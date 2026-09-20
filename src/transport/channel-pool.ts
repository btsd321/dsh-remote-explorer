/**
 * @file SSH 通道配额池
 * @description 统一管理单条 SSH 连接上的通道用量，避免超出服务端的 MaxSessions 上限。
 *
 * 为什么需要这一层：本仓库前一版实现踩过这个坑——引导时并发上传依赖文件会超通道上限，
 * 当时的对策是「所有上传走单个 SFTP 会话串行执行」。那是在调用点打补丁，
 * 换个调用点又会犯同样的错。这里把配额收口成独立模块，exec、SFTP、正向转发、
 * 反向转发全部经它申请，从结构上消除这类故障。
 *
 * 容量口径：admin 类通道受 OpenSSH `MaxSessions`（默认 10）约束；forward 类
 * （direct-tcpip）没有同等的低值硬上限，但浏览器对单一 web 主机的 keep-alive
 * 连接是**稳态占用**，上限必须按「浏览器常规并发 + 余量」取而不是取小了事。
 * 两类分池，保证心跳与管理命令不会被转发流量挤死（借 dsh-ssh 给心跳预留容量的思路）。
 *
 * 分层约束：本文件属传输层，不感知连接状态与业务语义。
 */

import { RemoteError } from '../util/errors.js';

/** 通道用途分类：决定从哪个配额池扣减 */
export type ChannelKind =
  /** 管理类：exec 命令、SFTP 会话 */
  | 'admin'
  /** 数据类：正反向转发的每条入站连接 */
  | 'forward';

/** 通道池配置 */
export interface ChannelPoolConfig {
  /** 管理类通道上限 */
  adminLimit: number;
  /** 数据类通道上限 */
  forwardLimit: number;
  /** 等待可用通道的超时（毫秒） */
  acquireTimeoutMs: number;
}

/**
 * 默认配额。
 *
 * admin 类（exec 命令、SFTP）确实受 OpenSSH `MaxSessions`（默认 10）约束，
 * 取 3 留余量即可——本工具的 exec 是串行的（心跳每 5 秒一条命令）。
 *
 * forward 类是另一回事，实测取 5 是错的（用户实测踩过）：浏览器对单一 web
 * 主机常规保持 6 条以上 HTTP/1.1 keep-alive 连接，加上 WebSocket 与 SSE，
 * 正常使用就会**稳态**耗满 5 条，此后每条新连接都要排队 30 秒再失败。
 * direct-tcpip 通道没有等同于 MaxSessions 的低值硬上限——`ssh -L` 的常规
 * 用法就是几十条并发转发连接——取 64 留足余量，仍能兜住异常失控的调用方。
 */
const DEFAULT_CONFIG: ChannelPoolConfig = {
  adminLimit: 3,
  forwardLimit: 64,
  acquireTimeoutMs: 30_000,
};

/** 已获取的通道租约；用完必须 release */
export interface ChannelLease {
  /** 释放通道；幂等 */
  release(): void;
}

/** 等待队列中的一个申请 */
interface Waiter {
  /** 申请的通道类型 */
  kind: ChannelKind;
  /** 授予回调 */
  grant: () => void;
  /** 拒绝回调 */
  reject: (error: Error) => void;
  /** 超时定时器 */
  timer: NodeJS.Timeout;
}

/**
 * 单条 SSH 连接的通道配额池。
 *
 * 每个 {@link RemoteTransport} 实例持有一个——多主机并行时各主机独立计数，
 * 因为 MaxSessions 是服务端按连接施加的限制。
 */
export class ChannelPool {
  private readonly config: ChannelPoolConfig;
  private adminUsed = 0;
  private forwardUsed = 0;
  private readonly waiters: Waiter[] = [];
  private closed = false;

  /**
   * @param config - 部分覆盖默认配额
   */
  constructor(config?: Partial<ChannelPoolConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** 当前用量快照（诊断用） */
  get usage(): { admin: number; forward: number; waiting: number } {
    return { admin: this.adminUsed, forward: this.forwardUsed, waiting: this.waiters.length };
  }

  /**
   * 申请一条通道，配额不足时排队等待。
   *
   * @param kind - 通道用途
   * @param signal - 取消信号
   * @returns 通道租约，使用完毕必须 `release()`
   * @throws RemoteError('ABORTED') 等待期间被取消或池已关闭
   * @throws RemoteError('EXEC_FAILED') 等待超时
   */
  async acquire(kind: ChannelKind, signal?: AbortSignal): Promise<ChannelLease> {
    if (this.closed) {
      throw new RemoteError('ABORTED', '通道池已关闭，无法申请新通道');
    }
    signal?.throwIfAborted();

    if (this.tryTake(kind)) return this.makeLease(kind);

    // 配额已满，排队等待
    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        kind,
        grant: () => { cleanup(); resolve(); },
        reject: (error) => { cleanup(); reject(error); },
        timer: setTimeout(() => {
          waiter.reject(new RemoteError(
            'EXEC_FAILED',
            `等待 SSH 通道超时（${this.config.acquireTimeoutMs}ms）：${kind} 类通道已用满`
              + `（admin ${this.adminUsed}/${this.config.adminLimit}，`
              + `forward ${this.forwardUsed}/${this.config.forwardLimit}）`,
          ));
        }, this.config.acquireTimeoutMs),
      };
      waiter.timer.unref();

      const onAbort = (): void => {
        waiter.reject(new RemoteError('ABORTED', '等待 SSH 通道时被取消'));
      };
      const cleanup = (): void => {
        clearTimeout(waiter.timer);
        signal?.removeEventListener('abort', onAbort);
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
      };

      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(waiter);
    });

    return this.makeLease(kind);
  }

  /**
   * 关闭池并拒绝所有等待者。
   *
   * 连接断开时调用——挂起的申请不应继续等待一条永不会来的通道。
   */
  close(): void {
    this.closed = true;
    // 复制一份再遍历：reject 回调会从 waiters 里移除自身
    for (const waiter of [...this.waiters]) {
      waiter.reject(new RemoteError('ABORTED', 'SSH 连接已关闭，挂起的通道申请作废'));
    }
  }

  /** 尝试直接占用一个配额，成功返回 true */
  private tryTake(kind: ChannelKind): boolean {
    if (kind === 'admin') {
      if (this.adminUsed >= this.config.adminLimit) return false;
      this.adminUsed += 1;
      return true;
    }
    if (this.forwardUsed >= this.config.forwardLimit) return false;
    this.forwardUsed += 1;
    return true;
  }

  /** 构造租约，release 时归还配额并唤醒等待者 */
  private makeLease(kind: ChannelKind): ChannelLease {
    let released = false;
    return {
      release: (): void => {
        if (released) return;
        released = true;
        if (kind === 'admin') this.adminUsed -= 1;
        else this.forwardUsed -= 1;
        this.wakeNext();
      },
    };
  }

  /** 唤醒第一个能被满足的等待者（按 FIFO，跳过配额仍不足的类型） */
  private wakeNext(): void {
    for (const waiter of this.waiters) {
      if (this.tryTake(waiter.kind)) {
        waiter.grant();
        return;
      }
    }
  }
}

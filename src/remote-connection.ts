/**
 * @file 连接编排与状态机模块
 * @description 管理 SSH 连接的生命周期状态，协调引导→连接→就绪→断开的全流程。
 *              提供可观测的状态机和事件流，供前端订阅连接状态变化。
 *              支持断线检测、自动重连尝试（有限次）、手动重连和多主机切换。
 *
 * 状态机：
 *   disconnected → connecting → verifying → ready → lost
 *                                          ↘ failed      ↘ reconnecting → ...
 *
 * 断线语义（与 dsh-ssh 一致）：
 * - 连接丢失后所有挂起操作作废，不自动重放
 * - 自动重连尝试有限次（默认 3 次），每次间隔递增
 * - 自动重连失败后进入 lost 状态，等待用户手动重连
 */

import { EventEmitter } from 'node:events';
import { Ssh2Connection, type Hello } from './ssh2-connection.js';
import { RemoteBootstrap, type BootstrapResult } from './remote-bootstrap.js';
import type { RemoteHostProfile } from './remote-hosts.js';

/** 连接状态枚举 */
export type ConnectionState = 'disconnected' | 'connecting' | 'verifying' | 'ready' | 'lost' | 'failed' | 'reconnecting';

/** 连接状态变化事件 */
export interface ConnectionEvent {
  /** 当前状态 */
  state: ConnectionState;
  /** 状态变化时间戳（ISO-8601） */
  timestamp: string;
  /** 可选的状态详情或错误消息 */
  message?: string;
}

/** 连接历史记录条目 */
export interface ConnectionHistoryEntry {
  /** 主机 ID */
  hostId: string;
  /** 主机显示名 */
  hostTitle: string;
  /** 连接开始时间（ISO-8601） */
  connectedAt: string;
  /** 连接结束时间（ISO-8601），未断开时为 null */
  disconnectedAt: string | null;
  /** 结束原因（'manual' | 'lost' | 'failed' | null） */
  endReason: 'manual' | 'lost' | 'failed' | null;
  /** 最后一个错误消息 */
  lastError?: string;
}

/** 自动重连配置 */
export interface ReconnectConfig {
  /** 是否启用自动重连（默认 true） */
  enabled: boolean;
  /** 最大重连次数（默认 3） */
  maxAttempts: number;
  /** 初始重连间隔毫秒（默认 1000） */
  initialDelayMs: number;
  /** 重连间隔递增倍数（默认 2） */
  backoffMultiplier: number;
  /** 最大重连间隔毫秒（默认 10000） */
  maxDelayMs: number;
}

/** 默认重连配置 */
const DEFAULT_RECONNECT_CONFIG: ReconnectConfig = {
  enabled: true,
  maxAttempts: 3,
  initialDelayMs: 1000,
  backoffMultiplier: 2,
  maxDelayMs: 10_000,
};

/**
 * 连接编排器：管理一个远程主机的 SSH 连接生命周期。
 *
 * 职责：
 * - 接收主机档案，执行引导（探测/安装 Node + 上传 helper）
 * - 用引导结果创建 Ssh2Connection
 * - 维护状态机，对外暴露状态变化事件
 * - 连接就绪后提供 Ssh2Connection 实例供下游 provider 使用
 * - 断线检测与自动重连尝试（有限次）
 * - 手动重连接口
 * - 连接历史记录
 * - 多主机切换（切换时先断开旧连接）
 */
export class ConnectionOrchestrator extends EventEmitter {
  /** 当前状态 */
  private _state: ConnectionState = 'disconnected';
  /** 当前连接实例 */
  private connection: Ssh2Connection | undefined;
  /** 引导结果 */
  private bootstrapResult: BootstrapResult | undefined;
  /** 当前绑定的主机档案 */
  private profile: RemoteHostProfile | undefined;
  /** 上次成功使用的 helperDirPath（用于重连） */
  private lastHelperDirPath: string | undefined;
  /** 重连配置 */
  private reconnectConfig: ReconnectConfig = DEFAULT_RECONNECT_CONFIG;
  /** 当前重连尝试次数 */
  private reconnectAttempts = 0;
  /** 重连定时器 */
  private reconnectTimer: NodeJS.Timeout | undefined;
  /** 连接历史记录 */
  private _history: ConnectionHistoryEntry[] = [];
  /** 当前连接的历史条目（断开时归档） */
  private currentHistoryEntry: ConnectionHistoryEntry | undefined;

  /** 获取当前状态 */
  get state(): ConnectionState { return this._state; }

  /** 获取当前连接实例（仅 ready 状态可用） */
  get activeConnection(): Ssh2Connection | undefined {
    return this._state === 'ready' ? this.connection : undefined;
  }

  /** 获取当前绑定的主机档案 */
  get activeProfile(): RemoteHostProfile | undefined {
    return this.profile;
  }

  /** 获取连接历史记录 */
  get history(): readonly ConnectionHistoryEntry[] {
    return this._history;
  }

  /** 获取当前重连尝试次数 */
  get currentReconnectAttempts(): number {
    return this.reconnectAttempts;
  }

  /**
   * 配置自动重连参数
   * @param config - 重连配置（部分字段可选，与默认合并）
   */
  configureReconnect(config: Partial<ReconnectConfig>): void {
    this.reconnectConfig = { ...this.reconnectConfig, ...config };
  }

  /**
   * 激活一个主机档案的连接
   * @param profile - 主机档案
   * @param helperDirPath - 本地 helper 构建目录路径
   * @returns 连接就绪后的 Hello
   */
  async activate(profile: RemoteHostProfile, helperDirPath: string): Promise<Hello> {
    // 如果已在连接，先断开（不算 lost）
    if (this.connection) await this.deactivate();

    this.profile = profile;
    this.lastHelperDirPath = helperDirPath;
    this.reconnectAttempts = 0;
    this.setState('connecting', `正在连接 ${profile.host}:${profile.port}`);

    // 记录连接历史
    this.currentHistoryEntry = {
      hostId: profile.id,
      hostTitle: profile.title,
      connectedAt: new Date().toISOString(),
      disconnectedAt: null,
      endReason: null,
    };

    try {
      return await this.connectWithBootstrap(profile, helperDirPath);
    } catch (error) {
      this.setState('failed', error instanceof Error ? error.message : String(error));
      if (this.currentHistoryEntry) {
        this.currentHistoryEntry.endReason = 'failed';
        this.currentHistoryEntry.lastError = error instanceof Error ? error.message : String(error);
      }
      this.archiveHistoryEntry();
      throw error;
    }
  }

  /** 断开当前连接，回到 disconnected 状态 */
  async deactivate(): Promise<void> {
    this.cancelReconnect();
    if (this.connection) {
      await this.connection.dispose().catch(() => {});
      this.connection = undefined;
    }
    this.bootstrapResult = undefined;
    // 记录手动断开
    if (this.currentHistoryEntry) {
      this.currentHistoryEntry.disconnectedAt = new Date().toISOString();
      this.currentHistoryEntry.endReason = 'manual';
      this.archiveHistoryEntry();
    }
    this.profile = undefined;
    this.setState('disconnected');
  }

  /**
   * 手动重连（用于 lost/failed/disconnected 状态）
   * @returns 连接就绪后的 Hello
   */
  async reconnect(): Promise<Hello> {
    if (!this.profile || !this.lastHelperDirPath) {
      throw new Error('没有可重连的主机档案（请先 activate）');
    }
    // 取消任何挂起的自动重连
    this.cancelReconnect();
    this.reconnectAttempts = 0;
    this.setState('reconnecting', `正在手动重连 ${this.profile.host}...`);
    return await this.connectWithBootstrap(this.profile, this.lastHelperDirPath);
  }

  /**
   * 用主机档案的配置创建 Ssh2Connection 并等待就绪
   * @param profile - 已完成引导的主机档案
   * @returns helper hello
   */
  private async tryConnect(profile: RemoteHostProfile): Promise<Hello> {
    const connection = new Ssh2Connection({
      host: profile.host,
      port: profile.port,
      username: profile.username,
      ...(profile.privateKeyPath ? { privateKeyPath: profile.privateKeyPath } : {}),
      ...(profile.passphrase ? { passphrase: profile.passphrase } : {}),
      ...(profile.password ? { password: profile.password } : {}),
      node: profile.node,
      helper: profile.helper,
      helperHash: profile.helperHash,
      workspace: profile.workspace,
      ...(profile.bootstrapPath ? { bootstrapPath: profile.bootstrapPath } : {}),
      ...(profile.bootstrapHash ? { bootstrapHash: profile.bootstrapHash } : {}),
    });

    this.connection = connection;

    // 监听连接断开事件（Ssh2Connection 在连接丢失时会触发 'closed' 事件）
    // 通过 RPC peer 的 'closed' 事件间接感知
    // 这里用 ready Promise 的 reject 来检测启动失败，
    // 运行时断开通过 connection.dispose 的失败或 RPC 请求的失败来感知

    // 等待就绪
    const hello = await connection.ready;
    this.setState('ready', `已连接到 ${profile.host}`);
    return hello;
  }

  /**
   * 连接+引导组合逻辑（activate 和 reconnect 共用）
   * @param profile - 主机档案
   * @param helperDirPath - helper 目录
   * @returns helper hello
   */
  private async connectWithBootstrap(profile: RemoteHostProfile, helperDirPath: string): Promise<Hello> {
    const bootstrap = new RemoteBootstrap();

    // 如果档案已有 helper 配置，先尝试直接连接
    if (profile.node && profile.helper && profile.helperHash) {
      this.setState('verifying', '正在验证已有配置...');
      try {
        return await this.tryConnect(profile);
      } catch {
        // 已有配置连接失败，执行重新引导
        this.setState('connecting', '已有配置失败，正在重新引导...');
      }
    }

    // 执行引导
    this.setState('verifying', '正在引导远端环境...');
    this.bootstrapResult = await bootstrap.bootstrap(profile, helperDirPath);

    // 用引导结果更新档案
    profile.node = this.bootstrapResult.node;
    profile.helper = this.bootstrapResult.helper;
    profile.helperHash = this.bootstrapResult.helperHash;

    // 建立连接
    this.setState('connecting', '正在建立 SSH 连接...');
    return await this.tryConnect(profile);
  }

  /**
   * 通知连接丢失（由外部检测到断线时调用，或由 RPC 请求失败触发）
   * @param reason - 断线原因
   */
  notifyConnectionLost(reason: string): void {
    if (this._state !== 'ready' && this._state !== 'reconnecting') return;

    // 归档历史
    if (this.currentHistoryEntry) {
      this.currentHistoryEntry.disconnectedAt = new Date().toISOString();
      this.currentHistoryEntry.endReason = 'lost';
      this.currentHistoryEntry.lastError = reason;
      this.archiveHistoryEntry();
    }

    // 清理连接
    this.connection = undefined;
    this.reconnectAttempts++;

    // 尝试自动重连
    if (this.reconnectConfig.enabled && this.reconnectAttempts <= this.reconnectConfig.maxAttempts) {
      const delay = Math.min(
        this.reconnectConfig.initialDelayMs * Math.pow(this.reconnectConfig.backoffMultiplier, this.reconnectAttempts - 1),
        this.reconnectConfig.maxDelayMs,
      );
      this.setState('reconnecting', `连接丢失（${reason}），${delay}ms 后自动重连（第 ${this.reconnectAttempts}/${this.reconnectConfig.maxAttempts} 次）`);
      this.reconnectTimer = setTimeout(() => {
        this.doAutoReconnect().catch(() => {
          // 自动重连失败，继续等待或进入 lost
        });
      }, delay);
      this.reconnectTimer.unref();
    } else {
      // 超过最大重连次数，进入 lost 状态
      this.setState('lost', `连接丢失且自动重连已耗尽（${reason}），请手动重连`);
    }
  }

  /** 执行自动重连 */
  private async doAutoReconnect(): Promise<void> {
    if (!this.profile || !this.lastHelperDirPath) {
      this.setState('lost', '无法重连：没有主机档案');
      return;
    }
    try {
      this.setState('reconnecting', `正在自动重连 ${this.profile.host}...`);
      await this.connectWithBootstrap(this.profile, this.lastHelperDirPath);
      // 重连成功，重置计数
      this.reconnectAttempts = 0;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.reconnectAttempts++;
      if (this.reconnectAttempts <= this.reconnectConfig.maxAttempts) {
        const delay = Math.min(
          this.reconnectConfig.initialDelayMs * Math.pow(this.reconnectConfig.backoffMultiplier, this.reconnectAttempts - 1),
          this.reconnectConfig.maxDelayMs,
        );
        this.setState('reconnecting', `重连失败（${msg}），${delay}ms 后重试（第 ${this.reconnectAttempts}/${this.reconnectConfig.maxAttempts} 次）`);
        this.reconnectTimer = setTimeout(() => {
          this.doAutoReconnect().catch(() => {});
        }, delay);
        this.reconnectTimer.unref();
      } else {
        this.setState('lost', `自动重连已耗尽（${msg}），请手动重连`);
      }
    }
  }

  /** 取消挂起的自动重连定时器 */
  private cancelReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  /** 归档当前历史条目到历史列表 */
  private archiveHistoryEntry(): void {
    if (this.currentHistoryEntry) {
      this._history.unshift(this.currentHistoryEntry);
      // 保留最近 50 条
      if (this._history.length > 50) this._history.length = 50;
      this.currentHistoryEntry = undefined;
    }
  }

  /**
   * 更新状态并发送事件
   * @param state - 新状态
   * @param message - 可选状态消息
   */
  private setState(state: ConnectionState, message?: string): void {
    this._state = state;
    const event: ConnectionEvent = {
      state,
      timestamp: new Date().toISOString(),
      ...(message ? { message } : {}),
    };
    this.emit('stateChange', event);
  }
}

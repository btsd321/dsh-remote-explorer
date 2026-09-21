/**
 * @file 正向转发（浏览器 → 远端 dsh）
 * @description 在本机监听一个端口，把入站连接经 SSH 通道转到远端 dsh 的 webserver。
 *
 * 核心设计：**监听器跨重连存活。** 本机 `net.Server` 由本模块持有，SSH 传输实例
 * 可以被替换（重连时会换一个新的），但监听端口始终不变。否则重连后端口一变，
 * 用户已打开的浏览器标签就全部失效——这是远程开发体验里最不能接受的一种退化。
 *
 * 实现方式是持有一个「当前传输」的引用而非传输本身：重连成功后调用
 * {@link LocalForward.swapTransport} 换掉引用，后续新连接自然走新传输。
 *
 * 安全约束：只绑 `127.0.0.1`。转发入口若绑全网卡，等于把远端 dsh 暴露到本机
 * 所在网络——即便 dsh 自带令牌认证，也没有理由扩大暴露面。
 */

import { createServer, type Server, type Socket } from 'node:net';
import { RemoteError, toErrorMessage } from '../util/errors.js';
import type { RemoteTransport } from '../transport/types.js';

/** 本机转发绑定地址，固定回环 */
const LOCAL_BIND_ADDR = '127.0.0.1';

/** 转发钩子：让上层（会话编排 → CLI/插件）接管本层的告警输出 */
export interface LocalForwardHooks {
  /**
   * 单条入站连接转发失败（开通道失败）时调用。
   * 未注入时回退直写 stderr（CLI 形态的既有行为）
   */
  onForwardError?: (message: string) => void;
}

/**
 * 正向转发句柄。
 *
 * 生命周期独立于 SSH 传输：传输重建时只需 {@link swapTransport}，不必重开监听。
 */
export class LocalForward {
  private transport: RemoteTransport;
  private server: Server | undefined;
  private listenPort = 0;
  /** 活跃的本机连接，close() 时统一销毁 */
  private readonly sockets = new Set<Socket>();
  private closed = false;

  /**
   * @param transport - 初始传输实例
   * @param remoteHost - 远端目标地址（应始终为 127.0.0.1）
   * @param remotePort - 远端目标端口
   * @param hooks - 告警输出钩子（插件形态注入；缺省直写 stderr）
   */
  constructor(
    transport: RemoteTransport,
    private readonly remoteHost: string,
    private readonly remotePort: number,
    private readonly hooks: LocalForwardHooks = {},
  ) {
    this.transport = transport;
  }

  /** 本机监听端口；`listen()` 之后可用 */
  get localPort(): number {
    return this.listenPort;
  }

  /**
   * 开始监听。
   *
   * @param preferredPort - 期望端口；传 0 由 OS 分配（推荐——内核保证不冲突）
   * @returns 实际监听端口
   * @throws RemoteError('CONNECT_FAILED') 监听失败
   */
  async listen(preferredPort = 0): Promise<number> {
    if (this.server) return this.listenPort;

    const server = createServer((socket: Socket) => {
      this.sockets.add(socket);
      socket.once('close', () => this.sockets.delete(socket));
      // error 监听器必须在任何 destroy 之前挂上：pipe() 的失败路径会销毁 socket，
      // raw TCP socket 没有 http 层兜底，无监听器时未处理 error 事件会直接掀翻进程
      socket.on('error', () => { /* 错误的处置在 pipe() 的失败路径里 */ });
      void this.pipe(socket);
    });
    this.server = server;

    this.listenPort = await new Promise<number>((resolve, reject) => {
      const cleanup = (): void => {
        server.off('error', onError);
        server.off('listening', onListening);
      };
      const onError = (error: Error): void => {
        cleanup();
        reject(new RemoteError(
          'CONNECT_FAILED',
          `本机监听端口 ${preferredPort} 失败：${error.message}`,
          { cause: error },
        ));
      };
      const onListening = (): void => {
        cleanup();
        const address = server.address();
        if (address === null || typeof address === 'string') {
          reject(new RemoteError('CONNECT_FAILED', '本机监听地址异常，无法确定端口'));
          return;
        }
        resolve(address.port);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(preferredPort, LOCAL_BIND_ADDR);
    });

    // 监听建立后的 error 不能让进程崩：单连接错误已在 pipe() 里处理，
    // 这里只兜住 server 级别的意外
    server.on('error', () => { /* 已记录在连接级处理中，此处仅防未捕获异常 */ });

    return this.listenPort;
  }

  /**
   * 替换传输实例（重连后调用）。
   *
   * 已建立的旧连接不会被迁移——它们依附于已失效的 SSH 通道，只能断开。
   * 浏览器会自行重连，而端口不变保证了页面无需刷新。
   *
   * @param transport - 新的传输实例
   */
  swapTransport(transport: RemoteTransport): void {
    this.transport = transport;
    // 主动断开依附旧传输的连接，让浏览器立刻重连而不是卡在半死的连接上
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
  }

  /** 关闭监听并断开所有连接；幂等 */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    const server = this.server;
    this.server = undefined;
    if (server) {
      await new Promise<void>((resolve) => { server.close(() => resolve()); });
    }
  }

  /**
   * 把一条本机连接对接到远端通道。
   *
   * @param socket - 本机入站连接
   */
  private async pipe(socket: Socket): Promise<void> {
    if (this.closed) {
      socket.destroy();
      return;
    }

    let channel;
    try {
      channel = await this.transport.openChannel(this.remoteHost, this.remotePort);
    } catch (error) {
      // 开通道失败通常意味着 SSH 已断或通道配额耗尽——销毁本机连接让浏览器
      // 感知并重试。**不带 error 参数调用 destroy**：带参数会在 socket 上
      // 触发 error 事件（listen() 里已挂兜底监听器，但那条路径只是吞掉），
      // 而这里要的是干净的连接重置。
      // 不在这里触发重连：重连由会话编排层按心跳统一决策，
      // 否则每个失败的连接都会各自发起一次重连。
      // 告警输出走钩子（插件形态接进日志缓冲）；未注入时直写 stderr 而非
      // cli 层的输出模块——tunnel 层不得向上 import
      const message = `转发失败（连接已断开，浏览器会自行重试）：${toErrorMessage(error)}`;
      if (this.hooks.onForwardError) this.hooks.onForwardError(message);
      else process.stderr.write(`${message}\n`);
      socket.destroy();
      return;
    }

    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      channel.release();
    };

    channel.stream.once('close', release);
    socket.once('close', release);
    socket.on('error', () => channel.stream.destroy());
    channel.stream.on('error', () => socket.destroy());

    socket.pipe(channel.stream).pipe(socket);
  }
}

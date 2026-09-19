/**
 * @file 跨平台 SSH 连接模块
 * @description 基于 ssh2 纯 JS 库实现，替代 dsh-ssh 中依赖系统 ssh 命令的实现。
 *              支持 Windows/Linux/macOS 客户端连接 POSIX 远程主机，提供与
 *              dsh-ssh SshConnection 兼容的接口（request/connectStream/dispose/ready）。
 *              远程 helper 仍在 POSIX 上运行，客户端侧通过 ssh2 的 exec 通道和
 *              openssh_forwardOutStream 实现 RPC 和流转发，无需 Unix 域套接字。
 */

import { Client, type ClientChannel, type ParsedKey } from 'ssh2';
import { readFileSync } from 'node:fs';
import { connect as tlsConnect, type TLSSocket, type ConnectionOptions } from 'node:tls';
import { EventEmitter } from 'node:events';
import type { Readable, Writable, Duplex } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { SshStreamEndpoint } from './schemas.js';

/** TLS-PSK 选项：与 dsh-ssh 的 stream-security.ts 保持一致 */
const SSH_STREAM_TLS_OPTIONS = {
  ciphers: 'PSK-AES256-GCM-SHA384',
  minVersion: 'TLSv1.2' as const,
  maxVersion: 'TLSv1.2' as const,
} as const satisfies ConnectionOptions;

/** RPC 协议版本，与 dsh-ssh 的 SSH_PROTOCOL_VERSION 保持一致 */
export const SSH_PROTOCOL_VERSION = 1;

/** 连接配置——从 dsh-ssh 的 Config 演化而来，增加了认证信息 */
export interface Ssh2Config {
  /** 远程主机地址 */
  host: string;
  /** SSH 端口 */
  port: number;
  /** 远程登录用户名 */
  username: string;
  /** 私钥文件路径（与 password 二选一） */
  privateKeyPath?: string;
  /** 私钥内容（直接传入，无需文件） */
  privateKey?: string;
  /** 私钥口令 */
  passphrase?: string;
  /** 密码认证（与 privateKey 二选一） */
  password?: string;
  /** 远程 Node 可执行文件绝对路径 */
  node: string;
  /** 远程 helper 入口文件绝对路径 */
  helper: string;
  /** helper 入口文件的 SHA-256，用于连接时校验 */
  helperHash: string;
  /** 远程默认工作目录绝对路径 */
  workspace: string;
  /** 可选：预装的 PTC bootstrap 入口路径 */
  bootstrapPath?: string;
  /** bootstrapPath 的 SHA-256 */
  bootstrapHash?: string;
  /** 请求超时（毫秒） */
  requestTimeoutMs?: number;
  /** 单帧最大字节 */
  maxFrameBytes?: number;
  /** 最大并发请求 */
  maxPending?: number;
  /** helper 心跳租约（毫秒） */
  leaseMs?: number;
}

/** helper 启动握手返回的远端标识 */
export interface Hello {
  /** 协议版本 */
  protocol: number;
  /** 远端 Node 可执行文件路径 */
  node: string;
  /** helper 入口文件 SHA-256 */
  hash: string;
  /** helper 根目录 */
  root: string;
  /** bootstrap SHA-256（若配置了 bootstrapPath） */
  bootstrapHash?: string;
}

/** hello 响应的 Zod schema */
const helloSchema = z.object({
  protocol: z.number(),
  node: z.string(),
  hash: z.string(),
  root: z.string(),
  bootstrapHash: z.string().optional(),
  platform: z.string().optional(),
  nodeVersion: z.string().optional(),
  workspace: z.string().optional(),
}).passthrough();

/** RPC 帧类型 */
type Frame =
  | { type: 'request'; id: string; method: string; params: unknown }
  | { type: 'result'; id: string; value: unknown }
  | { type: 'error'; id: string; error: { name: string; message: string; code?: string } }
  | { type: 'cancel'; id: string };

/** 远端操作错误：保留远端返回的错误码 */
export class RemoteOperationError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = 'RemoteOperationError';
  }
}

/**
 * RPC 对等端：处理 JSON-RPC 协议帧的读写和请求/响应配对。
 * 与 dsh-ssh 的 SshRpcPeer 协议兼容，可互操作。
 */
class RpcPeer extends EventEmitter {
  private readonly pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private writeTail = Promise.resolve();
  private failure: Error | undefined;

  /**
   * @param input - 可读流（远端→本地）
   * @param output - 可写流（本地→远端）
   * @param maxFrameBytes - 单帧最大字节
   */
  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
    private readonly maxFrameBytes: number,
  ) {
    super();
    input.on('error', (e: Error) => this.close(e));
    output.on('error', (e: Error) => this.close(e));
    output.on('close', () => this.close());
    void this.readLoop().catch((e: unknown) => this.close(e instanceof Error ? e : new Error(String(e))));
  }

  /**
   * 发送一个请求并等待响应
   * @param method - RPC 方法名
   * @param params - 请求参数
   * @param schema - 响应验证 schema
   * @param signal - 可选取消信号
   * @returns 验证后的响应
   */
  async request<T>(method: string, params: unknown, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    if (this.failure) throw this.failure;
    const id = randomUUID();
    const result = Promise.withResolvers<unknown>();
    void result.promise.catch(() => {});
    this.pending.set(id, { resolve: result.resolve, reject: result.reject });
    const abort = (): void => {
      result.reject(new Error('SSH 操作已取消；已完成的远端操作不会回滚'));
      void this.send({ type: 'cancel', id }).catch(() => {});
    };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      void this.send({ type: 'request', id, method, params }).catch((e: unknown) => {
        this.pending.delete(id);
        result.reject(e instanceof Error ? e : new Error(String(e)));
      });
      return schema.parse(await result.promise);
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }

  /** 关闭连接并拒绝所有挂起请求 */
  close(error: Error = new Error('SSH 连接丢失；远端操作结果未知')): void {
    if (this.failure) return;
    this.failure = error;
    for (const p of this.pending.values()) p.reject(error);
    this.pending.clear();
    this.input.destroy();
    this.output.destroy();
    this.emit('closed', error);
  }

  /** 发送一帧 */
  private async send(frame: Frame): Promise<void> {
    if (this.failure) throw this.failure;
    const body = Buffer.from(JSON.stringify(frame));
    if (body.length > this.maxFrameBytes) throw new Error('SSH 帧 exceeding maxFrameBytes');
    const header = Buffer.alloc(4);
    header.writeUInt32BE(body.length);
    const bytes = Buffer.concat([header, body]);
    this.writeTail = this.writeTail.then(async () => {
      if (this.failure) throw this.failure;
      if (!this.output.write(bytes)) {
        await new Promise<void>((resolve, reject) => {
          const cleanup = (): void => { this.output.off('drain', d); this.off('closed', c); };
          const d = (): void => { cleanup(); resolve(); };
          const c = (e: Error): void => { cleanup(); reject(e); };
          this.output.once('drain', d);
          this.once('closed', c);
        });
      }
    }).catch((e: unknown) => { this.close(e instanceof Error ? e : new Error(String(e))); });
    await this.writeTail;
  }

  /** 读取循环：解析帧并分发 */
  private async readLoop(): Promise<void> {
    let headerBuf = Buffer.alloc(4);
    let headerBytes = 0;
    let payload: Buffer | undefined;
    let payloadBytes = 0;
    for await (const raw of this.input) {
      const chunk: Buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
      let offset = 0;
      while (offset < chunk.length) {
        if (payload === undefined) {
          const count = Math.min(4 - headerBytes, chunk.length - offset);
          chunk.copy(headerBuf, headerBytes, offset, offset + count);
          headerBytes += count;
          offset += count;
          if (headerBytes < 4) continue;
          const size = headerBuf.readUInt32BE(0);
          if (size === 0 || size > this.maxFrameBytes) throw new Error('SSH helper 发送了无效的帧长度');
          payload = Buffer.alloc(size);
          payloadBytes = 0;
        }
        const count = Math.min(payload.length - payloadBytes, chunk.length - offset);
        chunk.copy(payload, payloadBytes, offset, offset + count);
        payloadBytes += count;
        offset += count;
        if (payloadBytes === payload.length) {
          const frame = JSON.parse(payload.toString('utf8')) as Frame;
          payload = undefined;
          headerBytes = 0;
          this.receive(frame);
        }
      }
    }
    throw new Error('SSH helper 断开连接');
  }

  /** 处理收到的帧 */
  private receive(frame: Frame): void {
    if (frame.type === 'result' || frame.type === 'error') {
      const p = this.pending.get(frame.id);
      if (!p) return;
      this.pending.delete(frame.id);
      if (frame.type === 'result') p.resolve(frame.value);
      else p.reject(new RemoteOperationError(frame.error.message, frame.error.code));
    }
  }
}

/**
 * 跨平台 SSH 连接：基于 ssh2 实现，提供与 dsh-ssh SshConnection 兼容的接口。
 *
 * 核心设计：
 * - RPC 通道：ssh2 exec 执行远端 Node helper，stdin/stdout 承载 JSON-RPC
 * - 流转发：ssh2 openssh_forwardOutStream 直连远端 Unix 域套接字，再用 TLS-PSK 认证
 * - 心跳租约：定期 heartbeat 保持 helper 活性
 * - 断线语义：连接丢失后所有挂起操作作废，不自动重连（与 dsh-ssh 一致）
 */
export class Ssh2Connection extends EventEmitter {
  /** 远端 helper 就绪 Promise */
  readonly ready: Promise<Hello>;
  private client: Client | undefined;
  private rpc: RpcPeer | undefined;
  private heartbeat: NodeJS.Timeout | undefined;
  private closed = false;
  private failure: Error | undefined;
  private remote: Hello | undefined;
  private readonly config: Required<Omit<Ssh2Config, 'privateKeyPath' | 'privateKey' | 'passphrase' | 'password' | 'bootstrapPath' | 'bootstrapHash'>> & Pick<Ssh2Config, 'privateKeyPath' | 'privateKey' | 'passphrase' | 'password' | 'bootstrapPath' | 'bootstrapHash'>;

  /**
   * @param config - 连接配置
   */
  constructor(config: Ssh2Config) {
    super();
    // 参数校验
    this.config = {
      ...config,
      port: config.port ?? 22,
      requestTimeoutMs: config.requestTimeoutMs ?? 30_000,
      maxFrameBytes: config.maxFrameBytes ?? 64 * 1024 * 1024,
      maxPending: config.maxPending ?? 128,
      leaseMs: config.leaseMs ?? 30_000,
    } as typeof this.config;
    this.ready = this.start();
    void this.ready.catch((e: unknown) => { this.fail(e instanceof Error ? e : new Error(String(e))); });
  }

  /** 远端 Node 可执行文件路径（helper 就绪后可用） */
  get nodeExecutable(): string {
    if (!this.remote) throw new Error('SSH helper 尚未就绪');
    return this.remote.node;
  }

  /** 已验证的 PTC bootstrap 路径 */
  get bootstrapPath(): string {
    if (!this.remote || !this.config.bootstrapPath) throw new Error('SSH PTC 需要已验证的 bootstrapPath 和 bootstrapHash');
    return this.config.bootstrapPath;
  }

  /**
   * 发送一个 helper 操作请求
   * @param method - RPC 方法名
   * @param params - 请求参数
   * @param result - 响应验证 schema
   * @param signal - 可选取消信号
   * @param wait - 是否允许操作超过管理超时（用于长等待）
   * @returns 验证后的远端结果
   */
  async request<T>(method: string, params: unknown, result: z.ZodType<T>, signal?: AbortSignal, wait = false): Promise<T> {
    this.assertOpen();
    await this.ready;
    this.assertOpen();
    const timeout = wait ? signal : signal === undefined
      ? AbortSignal.timeout(this.config.requestTimeoutMs)
      : AbortSignal.any([signal, AbortSignal.timeout(this.config.requestTimeoutMs)]);
    return (this.rpc as RpcPeer).request(method, params, result, timeout);
  }

  /**
   * 建立一个已认证的转发流
   * @param endpoint - helper 返回的流端点坐标
   * @param signal - 可选取消信号
   * @returns 已认证的 TLS 流
   */
  async connectStream(endpoint: SshStreamEndpoint, signal?: AbortSignal): Promise<TLSSocket> {
    const hello = await this.ready;
    this.assertOpen();
    // 校验流路径在 helper 根目录下
    if (!endpoint.path.startsWith(`${hello.root}/`)) throw new Error('SSH helper 返回了无效的流路径');
    signal?.throwIfAborted();

    // 用 ssh2 openssh_forwardOutStream 直连远端 Unix 域套接字
    const channel = await this.forwardStream(endpoint.path, signal);
    signal?.throwIfAborted();

    // TLS-PSK 认证（与 dsh-ssh stream-security.ts 一致）
    const tlsSocket = this.authenticateStream(channel, endpoint.capability, this.config.requestTimeoutMs, signal);
    return tlsSocket;
  }

  /** 释放连接和远端 helper 资源 */
  async dispose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    try {
      await this.ready.catch(() => {});
      if (this.rpc && !this.failure) {
        await this.rpc.request('close', {}, z.null(), AbortSignal.timeout(this.config.requestTimeoutMs)).catch(() => {});
      }
    } finally {
      this.rpc?.close();
      this.client?.end();
      this.client = undefined;
    }
  }

  /** 启动连接：SSH 握手 → exec helper → RPC hello → 校验摘要 → 启动心跳 */
  private async start(): Promise<Hello> {
    if (this.closed) throw new Error('连接在启动前已关闭');

    // 准备认证材料
    const auth: { privateKey?: Buffer; passphrase?: string; password?: string } = {};
    if (this.config.privateKeyPath) {
      auth.privateKey = readFileSync(this.config.privateKeyPath);
      if (this.config.passphrase) auth.passphrase = this.config.passphrase;
    } else if (this.config.privateKey) {
      auth.privateKey = Buffer.from(this.config.privateKey);
      if (this.config.passphrase) auth.passphrase = this.config.passphrase;
    } else if (this.config.password) {
      auth.password = this.config.password;
    } else {
      throw new Error('SSH 连接需要 privateKey 或 password');
    }

    // 创建 ssh2 客户端并连接
    const client = new Client();
    this.client = client;

    // 连接阶段错误处理
    await new Promise<void>((resolve, reject) => {
      const onReady = (): void => { cleanup(); resolve(); };
      const onError = (err: Error): void => { cleanup(); reject(err); };
      const cleanup = (): void => { client.off('ready', onReady); client.off('error', onError); };
      client.once('ready', onReady);
      client.once('error', onError);
      client.connect({
        host: this.config.host,
        port: this.config.port,
        username: this.config.username,

        ...auth,
        readyTimeout: this.config.requestTimeoutMs,
      });
    });

    // 运行时错误监听：连接成功后 ssh2 client 的 error 事件代表运行时断开
    client.on('error', (err: Error) => {
      this.fail(err);
    });
    client.on('close', () => {
      if (!this.closed) this.fail(new Error('SSH 连接已关闭'));
    });

    // exec 远端 helper（设置 NODE_PATH 让 helper 能找到 ~/.dsh/helper/node_modules 下的依赖）
    const helperDir = this.config.helper.substring(0, this.config.helper.lastIndexOf('/'));
    const helperCommand = `NODE_PATH='${helperDir}/node_modules' '${this.config.node}' --disable-sigusr1 '${this.config.helper}'`;
    const channel = await new Promise<ClientChannel>((resolve, reject) => {
      client.exec(helperCommand, { pty: false }, (err, stream) => {
        if (err) reject(err);
        else resolve(stream);
      });
    });

    // 消费 stderr 防止缓冲区满导致 channel 关闭（与 dsh-ssh 的 stderr.resume() 一致）
    channel.stderr.on('data', () => { /* 丢弃 helper 诊断输出 */ });

    // 创建 RPC 对等端：channel 是 Duplex 流，同时作为 input 和 output
    const rpc = new RpcPeer(channel, channel, this.config.maxFrameBytes);
    this.rpc = rpc;
    rpc.once('closed', (err: Error) => { this.fail(err); });

    // 发送 hello 请求
    const hello = await rpc.request('hello', {
      protocol: SSH_PROTOCOL_VERSION,
      workspace: this.config.workspace,
      leaseMs: this.config.leaseMs,
      ...(this.config.bootstrapPath ? { bootstrapPath: this.config.bootstrapPath } : {}),
    }, helloSchema, AbortSignal.timeout(this.config.requestTimeoutMs));

    // 校验 helper 摘要
    if (hello.hash !== this.config.helperHash) throw new Error('SSH helper 摘要与配置不符');
    if (this.config.bootstrapHash && hello.bootstrapHash !== this.config.bootstrapHash) {
      throw new Error('SSH PTC bootstrap 摘要与配置不符');
    }
    this.remote = hello;

    // 启动心跳
    let heartbeatPending: Promise<unknown> | undefined;
    this.heartbeat = setInterval(() => {
      heartbeatPending ??= rpc.request('heartbeat', {}, z.null(), AbortSignal.timeout(this.config.leaseMs / 2))
        .catch((e: unknown) => { this.fail(e instanceof Error ? e : new Error(String(e))); })
        .finally(() => { heartbeatPending = undefined; });
    }, Math.floor(this.config.leaseMs / 3));
    this.heartbeat.unref();

    return hello;
  }

  /**
   * 通过 ssh2 openssh_forwardOutStream 转发到远端 Unix 域套接字
   * @param socketPath - 远端 Unix 域套接字路径
   * @param signal - 可选取消信号
   * @returns ssh2 通道（Duplex 流）
   */
  private forwardStream(socketPath: string, signal?: AbortSignal): Promise<ClientChannel> {
    return new Promise((resolve, reject) => {
      const client = this.client;
      if (!client) { reject(new Error('SSH 连接已关闭')); return; }
      const cleanup = (): void => {
        client.off('openssh.stream', onStream);
      };
      const onStream = (err: Error | undefined, channel: ClientChannel): void => {
        cleanup();
        if (err) reject(err);
        else resolve(channel);
      };
      signal?.addEventListener('abort', () => {
        cleanup();
        reject(new Error('SSH 流转发已取消'));
      }, { once: true });
      // openssh_forwardOutStream 是 ssh2 的 OpenSSH 扩展：直接连接远端 Unix 域套接字
      client.openssh_forwardOutStream(socketPath, onStream);
    });
  }

  /**
   * 在 Duplex 流上做 TLS-PSK 认证
   * @param stream - ssh2 通道（Duplex 流）
   * @param capability - 每流 256-bit PSK 密钥（十六进制）
   * @param timeoutMs - 认证超时
   * @param signal - 可选取消信号
   * @returns 已认证的 TLS 流
   */
  private authenticateStream(stream: Duplex, capability: string, timeoutMs: number, signal?: AbortSignal): TLSSocket {
    if (signal?.aborted) { stream.destroy(); signal.throwIfAborted(); }
    // ssh2 通道是 Duplex 流，tls.connect 的 socket 选项接受 Duplex
    const tlsSocket = tlsConnect({
      ...SSH_STREAM_TLS_OPTIONS,
      socket: stream as any,
      rejectUnauthorized: true,
      pskCallback: () => ({ psk: Buffer.from(capability, 'hex'), identity: 'dsh-stream' }),
      checkServerIdentity: () => undefined,
    });
    const abort = (): void => { tlsSocket.destroy(signal?.reason instanceof Error ? signal.reason : new Error(String(signal?.reason))); };
    signal?.addEventListener('abort', abort, { once: true });
    tlsSocket.once('close', () => { signal?.removeEventListener('abort', abort); });
    // 超时保护
    const timer = setTimeout(() => {
      tlsSocket.destroy(new Error('SSH 流认证超时'));
    }, timeoutMs);
    tlsSocket.once('secureConnect', () => {
      clearTimeout(timer);
      tlsSocket.disableRenegotiation();
      tlsSocket.pause();
    });
    return tlsSocket;
  }

  /** 断言连接仍然打开 */
  private assertOpen(): void {
    if (this.closed) throw new Error('SSH 连接已关闭');
    if (this.failure) throw this.failure;
  }

  /** 标记连接失败，通知所有监听者 */
  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.rpc?.close(error);
    this.client?.end();
    // 通知外部监听者（ConnectionOrchestrator 监听此事件触发断线检测）
    this.emit('closed', error);
  }
}

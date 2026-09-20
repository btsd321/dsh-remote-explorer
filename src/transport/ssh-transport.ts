/**
 * @file 基于 ssh2 的远端传输实现
 * @description {@link RemoteTransport} 的 SSH 实现：纯 JS 的 ssh2 客户端，
 *              支持跳板机链、命令执行、SFTP 上传、正向与反向端口转发。
 *
 * 为什么用 ssh2 而不是系统 `ssh` 命令：客户端可能是 Windows。Zed 全程用系统 ssh
 * 并靠 ControlMaster 复用连接，但其源码注明 Windows 上 ControlMaster 不支持、
 * 且命令行有 8K 长度限制导致传不了环境变量。用纯 JS 库换来跨平台一致性，
 * 代价是要自己管通道配额（见 {@link ChannelPool}）。
 *
 * 断线语义（与 dsh-ssh 一致）：本层自身**不重连**。连接丢失后挂起操作全部作废，
 * 重连由会话编排层负责。
 */

import { createServer, type Server, type Socket } from 'node:net';
import { readFileSync } from 'node:fs';
import { Client, type ClientChannel, type SFTPWrapper } from 'ssh2';
import { RemoteError, toErrorMessage } from '../util/errors.js';
import { quote } from '../util/shell-quote.js';
import { ChannelPool, type ChannelPoolConfig } from './channel-pool.js';
import type {
  ExecOptions,
  ExecResult,
  ForwardHandle,
  RemoteArch,
  RemoteOs,
  RemotePlatform,
  RemoteTransport,
  ReverseConnection,
  ReverseHandle,
} from './types.js';
import type { ResolvedHost, ResolvedHostWithJump } from '../hosts/ssh-config-parser.js';

/** 传输层配置 */
export interface SshTransportConfig {
  /** 连接与命令的默认超时（毫秒） */
  timeoutMs?: number;
  /** keepalive 间隔（毫秒）；设 0 关闭 */
  keepaliveIntervalMs?: number;
  /** keepalive 连续失败次数上限 */
  keepaliveCountMax?: number;
  /** 通道配额覆盖 */
  channelPool?: Partial<ChannelPoolConfig>;
}

/** 默认超时：与 dsh-ssh 的 requestTimeoutMs 默认值保持一致 */
const DEFAULT_TIMEOUT_MS = 30_000;

/** 默认 keepalive 间隔 */
const DEFAULT_KEEPALIVE_INTERVAL_MS = 10_000;

/** 默认 keepalive 失败上限 */
const DEFAULT_KEEPALIVE_COUNT_MAX = 3;

/** 反向转发时远端必须监听的地址——绝不能对外暴露 */
const REVERSE_BIND_ADDR = '127.0.0.1';

/**
 * `uname -m` 输出到 Node 架构命名的映射。
 *
 * 用 Record 收口，新增架构时编译器会提示补齐分支。
 */
const ARCH_MAP: Record<string, RemoteArch> = {
  aarch64: 'arm64',
  arm64: 'arm64',
  x86_64: 'x64',
  amd64: 'x64',
  armv7l: 'armv7l',
  armv7: 'armv7l',
};

/** `uname -s` 输出到远端 OS 的映射 */
const OS_MAP: Record<string, RemoteOs> = {
  Linux: 'linux',
  Darwin: 'darwin',
};

/**
 * 基于 ssh2 的远端传输。
 *
 * 生命周期：`connect()` → 使用 → `dispose()`。跳板机链上的每个 Client
 * 都被记录下来，`dispose()` 时按反序释放。
 */
export class SshTransport implements RemoteTransport {
  private client: Client | undefined;
  /** 跳板机链上的客户端，按建立顺序；dispose 时反序关闭 */
  private readonly jumpClients: Client[] = [];
  /** 正向转发建立的本机监听服务器 */
  private readonly localServers = new Set<Server>();
  /** 已请求的反向监听端口 */
  private readonly reversePorts = new Set<number>();
  private readonly pool: ChannelPool;
  private readonly timeoutMs: number;
  private readonly keepaliveIntervalMs: number;
  private readonly keepaliveCountMax: number;
  private detectedPlatform: RemotePlatform | undefined;
  private disposed = false;
  private failure: Error | undefined;

  /**
   * @param hostAlias - 主机别名（诊断用）
   * @param resolved - 已解析的主机配置（含跳板机链）
   * @param config - 传输层配置
   */
  constructor(
    readonly hostAlias: string,
    private readonly resolved: ResolvedHostWithJump,
    config: SshTransportConfig = {},
  ) {
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.keepaliveIntervalMs = config.keepaliveIntervalMs ?? DEFAULT_KEEPALIVE_INTERVAL_MS;
    this.keepaliveCountMax = config.keepaliveCountMax ?? DEFAULT_KEEPALIVE_COUNT_MAX;
    this.pool = new ChannelPool(config.channelPool);
  }

  /** 探测到的远端平台；`connect()` 之前访问会抛错 */
  get platform(): RemotePlatform {
    if (!this.detectedPlatform) {
      throw new RemoteError('CONNECT_FAILED', `主机 ${this.hostAlias} 尚未连接，平台信息不可用`, {
        hostAlias: this.hostAlias,
      });
    }
    return this.detectedPlatform;
  }

  /** 传输是否仍可用 */
  get isAlive(): boolean {
    return this.client !== undefined && !this.disposed && this.failure === undefined;
  }

  /** 通道用量快照（doctor 命令用） */
  get channelUsage(): { admin: number; forward: number; waiting: number } {
    return this.pool.usage;
  }

  /**
   * 建立 SSH 连接并探测远端平台。
   *
   * @param signal - 取消信号
   * @throws RemoteError('CONNECT_FAILED') 连接或认证失败
   * @throws RemoteError('PLATFORM_UNSUPPORTED') 远端不是受支持的 POSIX 平台
   */
  async connect(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.client) return;

    // 1. 逐级建立跳板机链，拿到通向目标主机的 socket
    const sock = await this.buildJumpChain(signal);

    // 2. 连接目标主机
    const client = new Client();
    try {
      await this.connectClient(client, this.resolved.target, sock, `主机 ${this.hostAlias}`);
    } catch (error) {
      client.end();
      throw error;
    }
    this.client = client;

    // 3. 运行时错误监听：连接就绪后的 error/close 代表运行时断开
    client.on('error', (error: Error) => this.markFailed(error));
    client.on('close', () => {
      if (!this.disposed) this.markFailed(new Error(`主机 ${this.hostAlias} 的 SSH 连接已关闭`));
    });

    // 4. 探测平台
    this.detectedPlatform = await this.detectPlatform(signal);
  }

  /**
   * 在远端执行命令。
   *
   * @param command - 完整命令字符串；调用方负责用 `quote()` 转义动态值
   * @param options - 执行选项
   * @returns 执行结果
   * @throws RemoteError('EXEC_FAILED') 退出码非零且未设 allowNonZeroExit
   */
  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    const client = this.requireClient();
    options.signal?.throwIfAborted();

    // 统一用 `sh -c` 包裹，锁定 POSIX 语义——ssh exec 用的是用户登录 shell，
    // 而各 shell 行为有实质差异：zsh 对未匹配的 glob 直接报
    // "no matches found" 中止执行，bash 则保留字面量。不锁定的话，
    // 「遍历可能不存在的安装目录」这类脚本会在 zsh 用户的机器上突然失败。
    const posix = `sh -c ${quote(command)}`;

    // 环境变量用 `env K=V` 前缀注入：ssh2 的 env 选项要求服务端
    // AcceptEnv 放行，而绝大多数 sshd 默认只允许 LANG/LC_*，不可依赖
    const full = this.withEnv(posix, options.env);

    const lease = await this.pool.acquire('admin', options.signal);
    try {
      return await this.runExec(client, full, options);
    } finally {
      lease.release();
    }
  }

  /**
   * 经 SFTP 上传单个文件。
   *
   * 仅用于离线回退路径。批量上传必须串行复用同一 SFTP 会话——并发会超通道上限。
   *
   * @param localPath - 本机文件路径
   * @param remotePath - 远端绝对路径（POSIX 风格）
   * @param signal - 取消信号
   */
  async uploadFile(localPath: string, remotePath: string, signal?: AbortSignal): Promise<void> {
    const client = this.requireClient();
    signal?.throwIfAborted();

    const lease = await this.pool.acquire('admin', signal);
    let sftp: SFTPWrapper | undefined;
    try {
      sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
        client.sftp((error, wrapper) => {
          if (error) reject(this.connectError(`打开 SFTP 会话失败: ${error.message}`, error));
          else resolve(wrapper);
        });
      });
      await new Promise<void>((resolve, reject) => {
        sftp!.fastPut(localPath, remotePath, (error) => {
          if (error) {
            reject(new RemoteError(
              'EXEC_FAILED',
              `上传 ${localPath} 到 ${this.hostAlias}:${remotePath} 失败: ${error.message}`,
              { cause: error, hostAlias: this.hostAlias },
            ));
          } else {
            resolve();
          }
        });
      });
    } finally {
      sftp?.end();
      lease.release();
    }
  }

  /**
   * 正向转发：本机监听端口，入站连接经 SSH 通道转到远端目标。
   *
   * @param localPort - 本机监听端口；传 0 由 OS 分配
   * @param remoteHost - 远端目标地址（安全上应为 127.0.0.1）
   * @param remotePort - 远端目标端口
   * @returns 转发句柄
   */
  async forwardOut(localPort: number, remoteHost: string, remotePort: number): Promise<ForwardHandle> {
    const client = this.requireClient();

    const server = createServer((socket: Socket) => {
      void this.pipeForward(client, socket, remoteHost, remotePort);
    });
    this.localServers.add(server);

    const actualPort = await new Promise<number>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off('listening', onListening);
        reject(new RemoteError(
          'CONNECT_FAILED',
          `本机监听端口 ${localPort} 失败: ${error.message}`,
          { cause: error, hostAlias: this.hostAlias },
        ));
      };
      const onListening = (): void => {
        server.off('error', onError);
        const address = server.address();
        if (address === null || typeof address === 'string') {
          reject(new RemoteError('CONNECT_FAILED', '本机监听地址异常，无法确定端口'));
          return;
        }
        resolve(address.port);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      // 只绑回环：转发入口不对外暴露
      server.listen(localPort, '127.0.0.1');
    });

    // 监听期的 error 已消费，补一个长期处理器避免未捕获异常掀翻进程
    server.on('error', () => { /* 单个连接级错误由 pipeForward 处理，这里只防未捕获 */ });

    return {
      localPort: actualPort,
      close: async (): Promise<void> => {
        this.localServers.delete(server);
        await new Promise<void>((resolve) => { server.close(() => resolve()); });
      },
    };
  }

  /**
   * 反向转发：远端监听端口，入站连接回到本机。
   *
   * 远端监听地址固定 `127.0.0.1`，依赖 sshd 的 `GatewayPorts no` 默认值，
   * 同时显式传回环地址做双重保险。
   *
   * @param remotePort - 远端监听端口
   * @param onConnection - 入站连接处理器
   * @returns 转发句柄
   */
  async forwardIn(
    remotePort: number,
    onConnection: (connection: ReverseConnection) => void,
  ): Promise<ReverseHandle> {
    const client = this.requireClient();

    const handler = (details: { destPort: number }, accept: () => ClientChannel): void => {
      if (details.destPort !== remotePort) return;
      const stream = accept();
      onConnection({ remoteAddr: REVERSE_BIND_ADDR, remotePort, stream });
    };
    client.on('tcp connection', handler);

    const actualPort = await new Promise<number>((resolve, reject) => {
      client.forwardIn(REVERSE_BIND_ADDR, remotePort, (error, boundPort) => {
        if (error) {
          reject(new RemoteError(
            'CONNECT_FAILED',
            `请求主机 ${this.hostAlias} 反向监听 ${REVERSE_BIND_ADDR}:${remotePort} 失败: ${error.message}`
              + '（若远端 sshd 禁用了端口转发，需检查 AllowTcpForwarding）',
            { cause: error, hostAlias: this.hostAlias },
          ));
        } else {
          resolve(boundPort === 0 ? remotePort : boundPort);
        }
      });
    });
    this.reversePorts.add(actualPort);

    return {
      remotePort: actualPort,
      close: async (): Promise<void> => {
        client.off('tcp connection', handler);
        this.reversePorts.delete(actualPort);
        await new Promise<void>((resolve) => {
          client.unforwardIn(REVERSE_BIND_ADDR, actualPort, () => resolve());
        });
      },
    };
  }

  /** 释放连接与全部派生资源；幂等 */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.pool.close();

    // 1. 关本机监听
    for (const server of this.localServers) {
      await new Promise<void>((resolve) => { server.close(() => resolve()); });
    }
    this.localServers.clear();

    // 2. 撤反向监听（连接已断时会失败，忽略）
    if (this.client) {
      for (const port of this.reversePorts) {
        await new Promise<void>((resolve) => {
          try {
            this.client!.unforwardIn(REVERSE_BIND_ADDR, port, () => resolve());
          } catch { /* 连接已断，远端监听随之消失 */ }
        });
      }
    }
    this.reversePorts.clear();

    // 3. 关目标连接，再反序关跳板机
    this.client?.end();
    this.client = undefined;
    for (const jump of this.jumpClients.reverse()) jump.end();
    this.jumpClients.length = 0;
  }

  /**
   * 逐级建立跳板机链。
   *
   * 每级连上后 forwardOut 到下一跳，最后一级 forwardOut 到目标主机，
   * 得到的 channel 作为下一个 Client 的 `sock`。
   *
   * @param signal - 取消信号
   * @returns 通向目标主机的 socket；无跳板机时为 undefined
   */
  private async buildJumpChain(signal?: AbortSignal): Promise<ClientChannel | undefined> {
    const chain = this.resolved.jumpHosts;
    if (chain.length === 0) return undefined;

    let sock: ClientChannel | undefined;
    for (const [index, jump] of chain.entries()) {
      signal?.throwIfAborted();
      const jumpClient = new Client();
      await this.connectClient(jumpClient, jump, sock, `跳板机 ${index + 1}（${jump.host}:${jump.port}）`);
      this.jumpClients.push(jumpClient);

      const next = chain[index + 1];
      const destHost = next?.host ?? this.resolved.target.host;
      const destPort = next?.port ?? this.resolved.target.port;
      sock = await new Promise<ClientChannel>((resolve, reject) => {
        jumpClient.forwardOut('127.0.0.1', 0, destHost, destPort, (error, channel) => {
          if (error) {
            reject(new RemoteError(
              'CONNECT_FAILED',
              `跳板机 ${index + 1}（${jump.host}）转发到 ${destHost}:${destPort} 失败: ${error.message}`,
              { cause: error, hostAlias: this.hostAlias },
            ));
          } else {
            resolve(channel);
          }
        });
      });
    }
    return sock;
  }

  /**
   * 连接单个 ssh2 客户端。
   *
   * @param client - 待连接的客户端
   * @param host - 目标主机配置
   * @param sock - 上游通道（经跳板机时提供）
   * @param label - 错误消息中的定位标签
   * @throws RemoteError('CONNECT_FAILED') 连接或认证失败
   */
  private async connectClient(
    client: Client,
    host: ResolvedHost,
    sock: ClientChannel | undefined,
    label: string,
  ): Promise<void> {
    if (!host.identityFile) {
      throw new RemoteError(
        'HOST_CONFIG_INVALID',
        `${label} 缺少 IdentityFile；本工具只支持私钥认证`,
        { hostAlias: this.hostAlias },
      );
    }

    let privateKey: Buffer;
    try {
      privateKey = readFileSync(host.identityFile);
    } catch (error) {
      throw new RemoteError(
        'HOST_CONFIG_INVALID',
        `${label} 的私钥文件读取失败：${host.identityFile}（${toErrorMessage(error)}）`,
        { cause: error, hostAlias: this.hostAlias },
      );
    }

    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        client.off('ready', onReady);
        client.off('error', onError);
      };
      const onReady = (): void => { cleanup(); resolve(); };
      const onError = (error: Error): void => {
        cleanup();
        reject(new RemoteError(
          'CONNECT_FAILED',
          `${label} 连接失败: ${error.message}`,
          { cause: error, hostAlias: this.hostAlias },
        ));
      };
      client.once('ready', onReady);
      client.once('error', onError);
      client.connect({
        host: host.host,
        port: host.port,
        username: host.username,
        privateKey,
        readyTimeout: this.timeoutMs,
        keepaliveInterval: this.keepaliveIntervalMs,
        keepaliveCountMax: this.keepaliveCountMax,
        ...(sock ? { sock } : {}),
      });
    });
  }

  /**
   * 探测远端操作系统与架构。
   *
   * @param signal - 取消信号
   * @returns 归一化的平台信息
   * @throws RemoteError('PLATFORM_UNSUPPORTED') 非受支持的 POSIX 平台
   */
  private async detectPlatform(signal?: AbortSignal): Promise<RemotePlatform> {
    const result = await this.exec('uname -s && uname -m', {
      ...(signal ? { signal } : {}),
    });
    const [rawOs = '', rawArch = ''] = result.stdout.trim().split('\n').map(line => line.trim());
    const os = OS_MAP[rawOs];
    const arch = ARCH_MAP[rawArch];
    if (!os) {
      throw new RemoteError(
        'PLATFORM_UNSUPPORTED',
        `主机 ${this.hostAlias} 的系统 ${rawOs || '(空)'} 不受支持；远端只支持 Linux 与 macOS`,
        { hostAlias: this.hostAlias },
      );
    }
    if (!arch) {
      throw new RemoteError(
        'PLATFORM_UNSUPPORTED',
        `主机 ${this.hostAlias} 的架构 ${rawArch || '(空)'} 不受支持；`
          + `支持 ${Object.keys(ARCH_MAP).join('、')}`,
        { hostAlias: this.hostAlias },
      );
    }
    return { os, arch, rawOs, rawArch };
  }

  /**
   * 执行 exec 并收集输出。
   *
   * @param client - 已就绪的客户端
   * @param command - 完整命令
   * @param options - 执行选项
   * @returns 执行结果
   */
  private async runExec(client: Client, command: string, options: ExecOptions): Promise<ExecResult> {
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;

    const result = await new Promise<ExecResult>((resolve, reject) => {
      let settled = false;
      let stdout = '';
      let stderr = '';
      let timer: NodeJS.Timeout | undefined;
      let channel: ClientChannel | undefined;

      const finish = (outcome: { value?: ExecResult; error?: Error }): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        channel?.removeAllListeners();
        if (outcome.error) {
          channel?.close();
          reject(outcome.error);
        } else {
          resolve(outcome.value!);
        }
      };

      const onAbort = (): void => {
        finish({ error: new RemoteError('ABORTED', `主机 ${this.hostAlias} 上的命令被取消`) });
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });

      timer = setTimeout(() => {
        finish({
          error: new RemoteError(
            'EXEC_FAILED',
            `主机 ${this.hostAlias} 上的命令超时（${timeoutMs}ms）：${command.slice(0, 120)}`,
            { hostAlias: this.hostAlias },
          ),
        });
      }, timeoutMs);
      timer.unref();

      client.exec(command, (error, stream) => {
        if (error) {
          finish({
            error: new RemoteError(
              'EXEC_FAILED',
              `主机 ${this.hostAlias} 上启动命令失败: ${error.message}`,
              { cause: error, hostAlias: this.hostAlias },
            ),
          });
          return;
        }
        channel = stream;
        stream.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
        // 必须消费 stderr，否则缓冲区满会导致通道卡死
        stream.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
        stream.on('close', (code: number | null, signalName?: string) => {
          finish({
            value: {
              stdout,
              stderr,
              exitCode: code ?? null,
              ...(signalName ? { signal: signalName } : {}),
            },
          });
        });
        stream.on('error', (streamError: Error) => {
          finish({
            error: new RemoteError(
              'EXEC_FAILED',
              `主机 ${this.hostAlias} 上的命令流出错: ${streamError.message}`,
              { cause: streamError, hostAlias: this.hostAlias },
            ),
          });
        });
      });
    });

    if (!options.allowNonZeroExit && result.exitCode !== 0) {
      throw new RemoteError(
        'EXEC_FAILED',
        `主机 ${this.hostAlias} 上的命令返回 ${result.exitCode ?? `信号 ${result.signal}`}：`
          + `${command.slice(0, 120)}\n${result.stderr.trim().slice(0, 400)}`,
        { hostAlias: this.hostAlias },
      );
    }
    return result;
  }

  /**
   * 给命令加上 `env K=V` 前缀。
   *
   * 不用 ssh2 的 `env` 选项：那要求服务端 `AcceptEnv` 放行，
   * 而多数 sshd 默认只允许 `LANG`/`LC_*`，静默丢弃其余变量。
   *
   * @param command - 原始命令
   * @param env - 环境变量
   * @returns 带前缀的命令
   */
  private withEnv(command: string, env?: Record<string, string>): string {
    if (!env || Object.keys(env).length === 0) return command;
    const assignments = Object.entries(env)
      .map(([key, value]) => `${key}=${quote(value)}`)
      .join(' ');
    return `env ${assignments} ${command}`;
  }

  /**
   * 把本机 socket 与远端通道对接。
   *
   * @param client - 已就绪的客户端
   * @param socket - 本机入站连接
   * @param remoteHost - 远端目标地址
   * @param remotePort - 远端目标端口
   */
  private async pipeForward(
    client: Client,
    socket: Socket,
    remoteHost: string,
    remotePort: number,
  ): Promise<void> {
    // 转发连接也占 SSH 通道，必须走配额
    let lease;
    try {
      lease = await this.pool.acquire('forward');
    } catch {
      socket.destroy();
      return;
    }

    try {
      const channel = await new Promise<ClientChannel>((resolve, reject) => {
        client.forwardOut('127.0.0.1', 0, remoteHost, remotePort, (error, stream) => {
          if (error) reject(error);
          else resolve(stream);
        });
      });
      // 任一端结束即释放配额
      const release = (): void => lease.release();
      channel.once('close', release);
      socket.once('close', release);
      socket.on('error', () => channel.destroy());
      channel.on('error', () => socket.destroy());
      socket.pipe(channel).pipe(socket);
    } catch {
      lease.release();
      socket.destroy();
    }
  }

  /**
   * 取已就绪的客户端。
   *
   * @returns ssh2 客户端
   * @throws RemoteError('CONNECT_FAILED') 未连接、已释放或连接已失效
   */
  private requireClient(): Client {
    if (this.failure) {
      throw new RemoteError(
        'CONNECT_FAILED',
        `主机 ${this.hostAlias} 的连接已失效: ${this.failure.message}`,
        { cause: this.failure, hostAlias: this.hostAlias },
      );
    }
    if (this.disposed || !this.client) {
      throw new RemoteError('CONNECT_FAILED', `主机 ${this.hostAlias} 未连接`, {
        hostAlias: this.hostAlias,
      });
    }
    return this.client;
  }

  /**
   * 标记连接失效并关闭配额池，让挂起的申请立即失败。
   *
   * @param error - 导致失效的错误
   */
  private markFailed(error: Error): void {
    this.failure ??= error;
    this.pool.close();
  }

  /**
   * 构造连接类错误。
   *
   * @param message - 中文消息
   * @param cause - 底层错误
   * @returns RemoteError
   */
  private connectError(message: string, cause: unknown): RemoteError {
    return new RemoteError('CONNECT_FAILED', `主机 ${this.hostAlias}：${message}`, {
      cause,
      hostAlias: this.hostAlias,
    });
  }
}

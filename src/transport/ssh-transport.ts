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
 *
 * 认证：有 IdentityFile 时走 ssh2 默认顺序（none→publickey→agent），行为与
 * 早期版本一致；无 IdentityFile 时若上层注入了 getPassword 回调，则改走密码
 * 认证（ssh2 authHandler，被拒后重新取，最多 3 次；服务端只开
 * keyboard-interactive 时用同一份密码应答）。传输层不感知终端——提示由
 * 回调实现（cli/session 注入，见 util/password-prompt.ts）。
 */

import { readFileSync } from 'node:fs';
import {
  Client,
  type AuthHandlerMiddleware,
  type AuthenticationType,
  type ClientChannel,
  type KeyboardInteractiveAuthMethod,
  type NextAuthHandler,
  type PasswordAuthMethod,
  type SFTPWrapper,
} from 'ssh2';
import { RemoteError, toErrorMessage } from '../util/errors.js';
import { quote } from '../util/shell-quote.js';
import { ChannelPool, type ChannelPoolConfig } from './channel-pool.js';
import type {
  ExecOptions,
  ExecResult,
  RemoteArch,
  RemoteChannel,
  RemoteOs,
  RemotePlatform,
  RemoteTransport,
  ReverseConnection,
  ReverseHandle,
} from './types.js';
import type { ResolvedHost, ResolvedHostWithJump } from '../hosts/ssh-config-parser.js';

/**
 * 密码提供回调：无 IdentityFile 的主机认证时由传输层调用。
 *
 * @param hostKey - 主机标识（"user@host:port"，由传输层构造）
 * @param label - 定位标签（「主机 xxx」/「跳板机 1（host:port）」）
 * @param attempt - 第几次尝试，从 1 起；> 1 表示上一份密码已被服务器拒绝
 * @returns 密码；undefined 表示放弃认证（用户取消或无可用凭据）
 */
export type PasswordProviderFn = (
  hostKey: string,
  label: string,
  attempt: number,
) => Promise<string | undefined>;

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
  /**
   * 密码提供回调：无 IdentityFile 的主机认证时调用。
   * 不提供则维持「只支持私钥」——连接无 IdentityFile 的主机直接报错。
   */
  getPassword?: PasswordProviderFn;
}

/** 默认超时：与 dsh-ssh 的 requestTimeoutMs 默认值保持一致 */
const DEFAULT_TIMEOUT_MS = 30_000;

/** 默认 keepalive 间隔 */
const DEFAULT_KEEPALIVE_INTERVAL_MS = 10_000;

/** 默认 keepalive 失败上限 */
const DEFAULT_KEEPALIVE_COUNT_MAX = 3;

/** 密码认证最大尝试次数（每次被拒后经 getPassword 重新取） */
const MAX_PASSWORD_ATTEMPTS = 3;

/**
 * 密码路径的 readyTimeout：ssh2 的 readyTimeout 覆盖整个握手（含认证阶段），
 * 默认 30 秒会在用户打字输密码时超时。TCP 拒连/不可达不受影响（立刻报错），
 * 只有「握手成功但认证挂住」这种罕见情形才会等满 120 秒
 */
const PASSWORD_READY_TIMEOUT_MS = 120_000;

/** 单次密码认证的内部状态（connectClient 内局部持有，不逃逸到方法外） */
interface PasswordAuthState {
  /** 当前尝试的密码；undefined 表示尚未取得或已被消费（用于判定被拒） */
  password: string | undefined;
  /** 已被服务器拒绝的密码份数 */
  failures: number;
  /** 放弃原因标记，供 describeAuthFailure 翻译错误消息 */
  outcome: 'cancelled' | 'exhausted' | 'unsupported' | undefined;
}

/**
 * 判断错误是否为 SSH 认证失败（密码或密钥被服务器拒绝）。
 *
 * ssh2 给认证失败的 Error 挂 level='client-authentication'（含
 * next(false) 触发的「All configured authentication methods failed」），
 * 沿 cause 链识别。供会话层在无人值守重连时立即放弃——重试不会让密码变对。
 *
 * @param error - 捕获的错误（通常是包装了 ssh2 错误的 RemoteError）
 * @returns 是否认证失败
 */
export function isAuthFailure(error: unknown): boolean {
  return error instanceof RemoteError
    && error.cause instanceof Error
    // level 是 ssh2 自挂的非标准属性，就近断言读取
    && (error.cause as { level?: string }).level === 'client-authentication';
}

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
  /** 已请求的反向监听端口 */
  private readonly reversePorts = new Set<number>();
  private readonly pool: ChannelPool;
  private readonly timeoutMs: number;
  private readonly keepaliveIntervalMs: number;
  private readonly keepaliveCountMax: number;
  private readonly getPassword: PasswordProviderFn | undefined;
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
    this.getPassword = config.getPassword;
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
    const full = this.withEnv(posix, options.env, options.pathPrefix);

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
   * 开一条通向远端目标的双向通道。
   *
   * 本机监听由隧道层负责——监听器必须跨重连存活（本机端口变了用户的浏览器
   * 标签就失效），而传输实例会随重连被替换。
   *
   * @param remoteHost - 远端目标地址（安全上应为 127.0.0.1）
   * @param remotePort - 远端目标端口
   * @param signal - 取消信号
   * @returns 通道；使用完毕必须 release()
   */
  async openChannel(
    remoteHost: string,
    remotePort: number,
    signal?: AbortSignal,
  ): Promise<RemoteChannel> {
    const client = this.requireClient();
    signal?.throwIfAborted();

    // 每条通道都占 SSH 通道配额
    const lease = await this.pool.acquire('forward', signal);
    try {
      const stream = await new Promise<ClientChannel>((resolve, reject) => {
        client.forwardOut('127.0.0.1', 0, remoteHost, remotePort, (error, channel) => {
          if (error) {
            reject(new RemoteError(
              'CONNECT_FAILED',
              `经主机 ${this.hostAlias} 转发到 ${remoteHost}:${remotePort} 失败: ${error.message}`,
              { cause: error, hostAlias: this.hostAlias },
            ));
          } else {
            resolve(channel);
          }
        });
      });
      return { stream, release: () => lease.release() };
    } catch (error) {
      lease.release();
      throw error;
    }
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

    // 1. 撤反向监听（连接已断时会失败，忽略）
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

    // 2. 关目标连接，再反序关跳板机
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
   * 认证：有 IdentityFile 走 ssh2 默认顺序（行为与早期版本一致）；无
   * IdentityFile 且注入了 getPassword 回调时走密码认证（authHandler 重试，
   * 见 {@link SshTransport.createPasswordAuthHandler}）。
   *
   * @param client - 待连接的客户端
   * @param host - 目标主机配置
   * @param sock - 上游通道（经跳板机时提供）
   * @param label - 错误消息中的定位标签
   * @throws RemoteError('CONNECT_FAILED') 连接或认证失败
   * @throws RemoteError('HOST_CONFIG_INVALID') 无 IdentityFile 且无密码途径，或私钥读取失败
   */
  private async connectClient(
    client: Client,
    host: ResolvedHost,
    sock: ClientChannel | undefined,
    label: string,
  ): Promise<void> {
    // 1. 私钥路径：有 IdentityFile 时行为与「只支持私钥」时期完全一致
    let privateKey: Buffer | undefined;
    if (host.identityFile) {
      try {
        privateKey = readFileSync(host.identityFile);
      } catch (error) {
        throw new RemoteError(
          'HOST_CONFIG_INVALID',
          `${label} 的私钥文件读取失败：${host.identityFile}（${toErrorMessage(error)}）`,
          { cause: error, hostAlias: this.hostAlias },
        );
      }
    } else if (this.getPassword === undefined) {
      // 闸门（assertConnectable）通常已拦下；此处兜底未走闸门的直接调用方
      throw new RemoteError(
        'HOST_CONFIG_INVALID',
        `${label} 缺少 IdentityFile，且未提供密码输入途径（需要交互式终端或 --password）`,
        { hostAlias: this.hostAlias },
      );
    }

    // 2. 密码认证（仅无私钥时）：state 在单次 connectClient 内局部持有
    const usePasswordAuth = privateKey === undefined && this.getPassword !== undefined;
    const auth: PasswordAuthState = { password: undefined, failures: 0, outcome: undefined };
    const hostKey = `${host.username}@${host.host}:${host.port}`;
    const authHandler = usePasswordAuth
      ? this.createPasswordAuthHandler(host, hostKey, label, auth)
      : undefined;

    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        client.off('ready', onReady);
        client.off('error', onError);
      };
      const onReady = (): void => { cleanup(); resolve(); };
      const onError = (error: Error): void => {
        cleanup();
        // 密码路径把 ssh2 原文翻译成带上下文的中文；私钥路径保持原文不变
        const detail = usePasswordAuth
          ? this.describeAuthFailure(label, auth, error)
          : error.message;
        reject(new RemoteError(
          'CONNECT_FAILED',
          `${label} 连接失败: ${detail}`,
          { cause: error, hostAlias: this.hostAlias },
        ));
      };
      client.once('ready', onReady);
      client.once('error', onError);
      client.connect({
        host: host.host,
        port: host.port,
        username: host.username,
        ...(privateKey ? { privateKey } : {}),
        ...(authHandler ? { authHandler } : {}),
        // 密码场景 readyTimeout 覆盖认证阶段，30 秒会在用户打字时超时，放宽到 120 秒
        readyTimeout: authHandler !== undefined ? PASSWORD_READY_TIMEOUT_MS : this.timeoutMs,
        keepaliveInterval: this.keepaliveIntervalMs,
        keepaliveCountMax: this.keepaliveCountMax,
        ...(sock ? { sock } : {}),
      });
    });
  }

  /**
   * 构造密码认证的 authHandler。
   *
   * ssh2 每次 authHandler 调用意味着上一认证方法被拒（首调除外）；handler
   * 里异步向 provider 要密码再应答是官方支持的路径（返回 undefined 后延后
   * 调 next，见 ssh2 tryNextAuth 的 hasSentAuth 守卫）。
   *
   * @param host - 目标主机配置
   * @param hostKey - 主机标识（provider 缓存键）
   * @param label - 提示文案中的定位标签
   * @param auth - 单次连接的密码认证状态
   * @returns ssh2 authHandler 中间件
   */
  private createPasswordAuthHandler(
    host: ResolvedHost,
    hostKey: string,
    label: string,
    auth: PasswordAuthState,
  ): AuthHandlerMiddleware {
    // 首次调用运行时传 null（ssh2 源码 curAuthsLeft 初始为 null），@types/ssh2
    // 声明为数组；这里放宽参数类型（接受更宽参数的函数可赋给窄签名，逆变成立）
    const handler = (
      authsLeft: AuthenticationType[] | null,
      _partialSuccess: boolean,
      next: NextAuthHandler,
    ): void => {
      // 必须恰好调用一次 next（hasSentAuth 只防同步重入，双发会把两份认证
      // 请求发到同一连接）；单出口链保证不会
      void this.nextPasswordAuth(host, hostKey, label, auth, authsLeft)
        .then((method) => {
          // next(false) 表示放弃认证：运行时支持，@types/ssh2 的
          // NextAuthHandler 类型漏标了 false，这里断言补上（经 unknown 中转）
          (next as unknown as (auth: false | PasswordAuthMethod | KeyboardInteractiveAuthMethod) => void)(
            method ?? false,
          );
        })
        .catch(() => {
          (next as unknown as (auth: false) => void)(false);
        });
    };
    return handler;
  }

  /**
   * 计算密码认证的下一步。
   *
   * @param host - 目标主机配置
   * @param hostKey - 主机标识（provider 缓存键）
   * @param label - 提示文案中的定位标签
   * @param auth - 单次连接的密码认证状态
   * @param authsLeft - 服务端告知的剩余认证方法；首调为 null
   * @returns 下一个认证方法；undefined 表示放弃（原因记入 auth.outcome）
   */
  private async nextPasswordAuth(
    host: ResolvedHost,
    hostKey: string,
    label: string,
    auth: PasswordAuthState,
    authsLeft: AuthenticationType[] | null,
  ): Promise<PasswordAuthMethod | KeyboardInteractiveAuthMethod | undefined> {
    // 1. 服务器明确不再接受 password/keyboard-interactive：放弃并标记原因
    if (authsLeft !== null
      && !authsLeft.includes('password')
      && !authsLeft.includes('keyboard-interactive')) {
      auth.outcome = 'unsupported';
      return undefined;
    }
    // 2. 上一份密码已被拒（auth.password 尚存表示已发出过一份）：计数并丢弃；
    //    达上限放弃
    if (auth.password !== undefined) {
      auth.failures += 1;
      auth.password = undefined;
      if (auth.failures >= MAX_PASSWORD_ATTEMPTS) {
        auth.outcome = 'exhausted';
        return undefined;
      }
    }
    // 3. 取密码（attempt > 1 时 provider 会弃缓存重新提示）
    const password = await this.getPassword?.(hostKey, label, auth.failures + 1);
    if (password === undefined) {
      auth.outcome = 'cancelled';
      return undefined;
    }
    auth.password = password;
    // 4. 服务器允许 password 优先用；只开 keyboard-interactive 的 sshd
    //    用同一份密码应答（INFO_REQUEST 走 prompt 回调）
    if (authsLeft === null || authsLeft.includes('password')) {
      return { type: 'password', username: host.username, password };
    }
    return {
      type: 'keyboard-interactive',
      username: host.username,
      prompt: (_name, _instructions, _lang, prompts, finish) => {
        finish(prompts.map(() => password));
      },
    };
  }

  /**
   * 把密码路径的 ssh2 原始错误翻译成带上下文的中文。
   *
   * @param label - 定位标签
   * @param auth - 密码认证状态（outcome 由放弃路径先行置位）
   * @param error - ssh2 的原始错误
   * @returns 翻译后的消息；无对应翻译时返回原文
   */
  private describeAuthFailure(label: string, auth: PasswordAuthState, error: Error): string {
    if (auth.outcome === 'cancelled') {
      // failures > 0 说明密码已发出且被拒后 provider 不再提供（--password 场景）
      return auth.failures > 0
        ? `${label} 密码认证失败（提供的密码被拒绝）`
        : `${label} 密码输入已取消`;
    }
    if (auth.outcome === 'exhausted') {
      return `${label} 密码认证失败（已尝试 ${MAX_PASSWORD_ATTEMPTS} 次）`;
    }
    if (auth.outcome === 'unsupported') {
      return `${label} 不接受密码或键盘交互认证`;
    }
    // ssh2 的握手超时错误挂 level='client-timeout'（非标准属性，就近断言读取）
    if ((error as { level?: string }).level === 'client-timeout') {
      return `${label} 认证超时（${PASSWORD_READY_TIMEOUT_MS / 1_000} 秒内未完成，含等待输入密码的时间）`;
    }
    return error.message;
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
   * @param env - 环境变量；值会被完整转义，不做变量展开
   * @param pathPrefix - 前置到 PATH 的目录
   * @returns 带前缀的命令
   */
  private withEnv(
    command: string,
    env?: Record<string, string>,
    pathPrefix?: string,
  ): string {
    const assignments: string[] = [];

    if (pathPrefix !== undefined && pathPrefix.length > 0) {
      // `"$PATH"` 必须留在引号外由外层 shell 展开——把它塞进 quote() 会
      // 变成字面量，远端 PATH 就只剩这一个目录，连 rm/mkdir 都找不到。
      // 目录本身仍然转义，防注入。
      assignments.push(`PATH=${quote(pathPrefix)}:"$PATH"`);
    }
    for (const [key, value] of Object.entries(env ?? {})) {
      assignments.push(`${key}=${quote(value)}`);
    }

    if (assignments.length === 0) return command;
    return `env ${assignments.join(' ')} ${command}`;
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

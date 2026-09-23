/**
 * @file 基于 WSL 的远端传输实现
 * @description {@link RemoteTransport} 的 WSL（Windows Subsystem for Linux）实现。
 *              与 SSH 传输不同，WSL 是本机 Linux 子系统，不需要网络连接，
 *              通过 `wsl.exe` CLI 命令交互。文件传输优先走 UNC 路径
 *              （`\\wsl.localhost\<distro>\...`）直接读写，回退到 wsl.exe + stdin/stdout。
 *
 * 核心设计：
 * - 命令执行：`wsl.exe -d <distro> -u <user> -e bash -c <command>`
 * - 文件读写：UNC 路径为主路径（零开销、二进制安全），exec 为回退
 * - 端口转发：WSL2 与 Windows 共享 localhost（mirrored 模式）或通过 VM IP（NAT 模式），
 *   openChannel 创建 TCP socket 直连；forwardIn 在 Windows 侧开 TCP server
 * - 通道配额：WSL 没有 SSH 通道限制，但仍保留 release 语义以保持接口一致
 *
 * 分层约束：本文件属传输层，不得 import 编排层或能力层的任何模块。
 */

import { execFile } from 'node:child_process';
import { readFile, writeFile, copyFile, chmod } from 'node:fs/promises';
import { createServer, Socket, type Server } from 'node:net';
import { Duplex } from 'node:stream';
import { RemoteError, toErrorMessage } from '../util/errors.js';
import { quote } from '../util/shell-quote.js';
import { listWslDistros, getWslExePath } from '../hosts/wsl-distro-parser.js';
import type {
  ExecOptions,
  ExecResult,
  FileTransfer,
  RemoteArch,
  RemoteChannel,
  RemoteFileOptions,
  RemoteOs,
  RemotePlatform,
  RemoteTransport,
  ReverseConnection,
  ReverseHandle,
} from './types.js';

/** WSL 传输构造选项 */
export interface WslTransportOptions {
  /** WSL 发行版名称（如 Ubuntu-22.04） */
  distroName: string;
  /** 登录用户名；省略则使用发行版默认用户 */
  user?: string;
}

/** 默认命令超时（毫秒） */
const DEFAULT_TIMEOUT_MS = 30_000;

/** UNC 路径前缀模板 */
const UNC_PREFIX = '\\\\wsl.localhost\\';

/** `uname -m` 输出到 Node 架构命名的映射 */
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
 * 基于 WSL 的远端传输。
 *
 * 生命周期：`connect()` → 使用 → `dispose()`。
 * 与 SshTransport 保持一致的生命周期契约。
 */
export class WslTransport implements RemoteTransport {
  private detectedPlatform: RemotePlatform | undefined;
  private disposed = false;
  private alive = true;
  /** forwardIn 创建的 TCP server 列表；dispose 时逐一关闭 */
  private readonly forwardServers: Server[] = [];
  /** openChannel 创建的活跃 socket 列表；dispose 时逐一销毁 */
  private readonly activeSockets = new Set<Socket>();

  /** 主机别名（诊断与日志用） */
  readonly hostAlias: string;

  /**
   * @param options - WSL 传输选项
   */
  constructor(private readonly options: WslTransportOptions) {
    this.hostAlias = `wsl:${options.distroName}`;
  }

  /** 探测到的远端平台；`connect()` 之前访问会抛错 */
  get platform(): RemotePlatform {
    if (!this.detectedPlatform) {
      throw new RemoteError('CONNECT_FAILED', `WSL 发行版 ${this.options.distroName} 尚未连接，平台信息不可用`, {
        hostAlias: this.hostAlias,
      });
    }
    return this.detectedPlatform;
  }

  /** 传输是否仍可用 */
  get isAlive(): boolean {
    return this.alive && !this.disposed;
  }

  /**
   * 验证发行版存在并探测平台。
   *
   * @param signal - 取消信号
   * @throws RemoteError('CONNECT_FAILED') 发行版不存在或 WSL 不可用
   * @throws RemoteError('PLATFORM_UNSUPPORTED') 远端非 POSIX
   */
  async connect(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.detectedPlatform) return;

    // 1. 验证发行版存在
    const distros = await listWslDistros();
    const found = distros.find(d => d.name === this.options.distroName);
    if (found === undefined) {
      throw new RemoteError(
        'CONNECT_FAILED',
        `WSL 发行版 ${this.options.distroName} 不存在；`
          + `已安装的发行版：${distros.map(d => d.name).join('、') || '(无)'}`,
        { hostAlias: this.hostAlias },
      );
    }

    // 2. 探测平台
    this.detectedPlatform = await this.detectPlatform(signal);
  }

  /**
   * 在 WSL 内执行命令。
   *
   * @param command - 完整命令字符串；调用方负责用 `quote()` 转义动态值
   * @param options - 执行选项
   * @returns 执行结果
   * @throws RemoteError('EXEC_FAILED') 退出码非零且未设 allowNonZeroExit
   */
  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    this.requireAlive();
    options.signal?.throwIfAborted();

    // 统一用 bash -c 包裹，锁定 POSIX 语义
    const wrappedCommand = this.buildCommand(command, options.env, options.pathPrefix);
    const args = this.buildExecArgs(wrappedCommand);
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    try {
      const result = await runWslCommand(args, timeoutMs, options.signal);

      if (!options.allowNonZeroExit && result.exitCode !== 0) {
        throw new RemoteError(
          'EXEC_FAILED',
          `WSL ${this.options.distroName} 上的命令返回 ${result.exitCode ?? `信号 ${result.signal}`}：`
            + `${command.slice(0, 120)}\n${result.stderr.trim().slice(0, 400)}`,
          { hostAlias: this.hostAlias },
        );
      }
      return result;
    } catch (error) {
      if (error instanceof RemoteError) throw error;
      throw new RemoteError(
        'EXEC_FAILED',
        `WSL ${this.options.distroName} 上执行命令失败: ${toErrorMessage(error)}`,
        { cause: error, hostAlias: this.hostAlias },
      );
    }
  }

  /**
   * 把内容写入 WSL 内的文件。
   *
   * 主路径：UNC 路径直接 fs.writeFile（零开销、二进制安全）。
   * 回退：`wsl -d <distro> -e bash -c "cat > <path>"` + stdin 传入内容。
   *
   * @param remotePath - 远端绝对路径（POSIX 风格）
   * @param content - 文件内容
   * @param options - 超时、取消信号与文件模式
   */
  async writeRemoteFile(
    remotePath: string,
    content: string | Buffer,
    options: RemoteFileOptions = {},
  ): Promise<void> {
    this.requireAlive();
    options.signal?.throwIfAborted();

    const uncPath = this.toUncPath(remotePath);
    try {
      const data = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
      await writeFile(uncPath, data);
      // UNC 路径下设置文件权限
      if (options.mode !== undefined) {
        await chmod(uncPath, options.mode);
      }
    } catch {
      // UNC 不可用时回退到 exec + stdin
      await this.writeViaExec(remotePath, content, options);
    }
  }

  /**
   * 读取 WSL 内的文件全部内容。
   *
   * 主路径：UNC 路径直接 fs.readFile。
   * 回退：`wsl -d <distro> -e cat <path>` 读 stdout。
   *
   * @param remotePath - 远端绝对路径（POSIX 风格）
   * @param options - 超时与取消信号
   * @returns 文件内容
   */
  async readRemoteFile(remotePath: string, options: RemoteFileOptions = {}): Promise<Buffer> {
    this.requireAlive();
    options.signal?.throwIfAborted();

    const uncPath = this.toUncPath(remotePath);
    try {
      return await readFile(uncPath);
    } catch {
      // UNC 不可用时回退到 exec + stdout
      return this.readViaExec(remotePath, options);
    }
  }

  /**
   * 上传单个本地文件到 WSL。
   *
   * @param localPath - 本机文件路径
   * @param remotePath - 远端绝对路径（POSIX 风格）
   * @param signal - 取消信号
   */
  async uploadFile(localPath: string, remotePath: string, signal?: AbortSignal): Promise<void> {
    this.requireAlive();
    signal?.throwIfAborted();

    const uncPath = this.toUncPath(remotePath);
    try {
      await copyFile(localPath, uncPath);
    } catch {
      // UNC 不可用时回退：读本地文件 + writeRemoteFile
      const content = await readFile(localPath);
      await this.writeRemoteFile(remotePath, content, signal ? { signal } : {});
    }
  }

  /**
   * 批量上传本地文件到 WSL（串行执行，与 SSH 一致的纪律）。
   *
   * @param files - 传输条目列表
   * @param options - 超时与取消信号
   */
  async uploadFiles(files: readonly FileTransfer[], options: RemoteFileOptions = {}): Promise<void> {
    options.signal?.throwIfAborted();
    if (files.length === 0) return;

    for (const file of files) {
      options.signal?.throwIfAborted();
      await this.uploadFile(file.localPath, file.remotePath, options.signal);
    }
  }

  /**
   * 检查文件传输可用性。
   *
   * WSL 没有 SFTP 概念；这里验证 UNC 路径是否可访问。
   * UNC 不可用时抛出错误，提示调用方所有文件操作将走 exec 回退路径。
   *
   * @throws RemoteError('CONNECT_FAILED') UNC 路径不可访问
   */
  async checkSftp(): Promise<void> {
    this.requireAlive();
    // 尝试读取发行版根目录验证 UNC 可达性
    const uncRoot = `${UNC_PREFIX}${this.options.distroName}\\`;
    try {
      await readFile(`${uncRoot}etc\\hostname`);
    } catch (error) {
      throw new RemoteError(
        'CONNECT_FAILED',
        `WSL ${this.options.distroName} 的 UNC 路径不可访问（${toErrorMessage(error)}）；`
          + '文件操作将回退到 wsl.exe 命令方式',
        { cause: error, hostAlias: this.hostAlias },
      );
    }
  }

  /**
   * 开一条通向 WSL 内目标的双向通道（TCP socket）。
   *
   * WSL2 NAT 模式下连接到 WSL VM 的 IP:port；
   * WSL2 Mirrored 模式或 WSL1 下连接到 localhost:port。
   *
   * @param remoteHost - 目标地址（通常为 127.0.0.1）
   * @param remotePort - 目标端口
   * @param signal - 取消信号
   * @returns 通道；使用完毕必须 release()
   */
  async openChannel(
    remoteHost: string,
    remotePort: number,
    signal?: AbortSignal,
  ): Promise<RemoteChannel> {
    this.requireAlive();
    signal?.throwIfAborted();

    // 检测是否需要通过 WSL VM IP 连接（NAT 模式）
    const connectHost = await this.resolveConnectHost(remoteHost);

    const socket = await new Promise<Socket>((resolve, reject) => {
      const sock = new Socket();
      // error 监听器必须在 connect 之前挂上，防止未处理 error 事件掀翻进程
      sock.on('error', (error: Error) => {
        reject(new RemoteError(
          'CONNECT_FAILED',
          `连接到 WSL ${this.options.distroName} 的 ${connectHost}:${remotePort} 失败: ${error.message}`,
          { cause: error, hostAlias: this.hostAlias },
        ));
      });
      sock.once('connect', () => resolve(sock));
      sock.connect(remotePort, connectHost);
    });

    this.activeSockets.add(socket);
    socket.once('close', () => this.activeSockets.delete(socket));

    // 包装为 Duplex 以满足 RemoteChannel.stream 类型
    const stream = Duplex.from({ readable: socket, writable: socket });

    return {
      stream,
      release: () => {
        socket.destroy();
        this.activeSockets.delete(socket);
      },
    };
  }

  /**
   * 反向转发：在 Windows 侧开 TCP server，WSL 内的连接通过 localhost 到达。
   *
   * WSL2 Mirrored 模式下 Windows 与 WSL 共享 localhost，远端进程可直接连接。
   * NAT 模式下需要 portproxy 或类似机制——这里简化为仅在 mirrored 模式下工作，
   * NAT 模式报错提示用户配置网络。
   *
   * @param remotePort - 远端监听端口（实际在 Windows 侧监听）
   * @param onConnection - 每个入站连接的处理器
   * @returns 转发句柄
   */
  async forwardIn(
    remotePort: number,
    onConnection: (connection: ReverseConnection) => void,
  ): Promise<ReverseHandle> {
    this.requireAlive();

    const server = createServer((socket: Socket) => {
      // error 监听器必须在任何 destroy 之前挂上
      socket.on('error', () => { /* 客户端断开等无害错误，静默忽略 */ });
      const stream = Duplex.from({ readable: socket, writable: socket });
      onConnection({
        remoteAddr: '127.0.0.1',
        remotePort,
        stream,
      });
    });

    // 只绑 127.0.0.1——绝不能让反向端口对外可见
    await new Promise<void>((resolve, reject) => {
      server.on('error', (error: Error) => {
        reject(new RemoteError(
          'CONNECT_FAILED',
          `WSL ${this.options.distroName} 反向监听 127.0.0.1:${remotePort} 失败: ${error.message}`,
          { cause: error, hostAlias: this.hostAlias },
        ));
      });
      server.listen(remotePort, '127.0.0.1', () => resolve());
    });

    this.forwardServers.push(server);

    return {
      remotePort,
      close: async (): Promise<void> => {
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
        const index = this.forwardServers.indexOf(server);
        if (index >= 0) this.forwardServers.splice(index, 1);
      },
    };
  }

  /** 释放连接与全部派生资源；幂等 */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.alive = false;

    // 关闭所有反向转发 server
    for (const server of this.forwardServers) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
    this.forwardServers.length = 0;

    // 销毁所有活跃 socket
    for (const socket of this.activeSockets) {
      socket.destroy();
    }
    this.activeSockets.clear();
  }

  /**
   * 探测 WSL 内的操作系统与架构。
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
        `WSL ${this.options.distroName} 的系统 ${rawOs || '(空)'} 不受支持；远端只支持 Linux 与 macOS`,
        { hostAlias: this.hostAlias },
      );
    }
    if (!arch) {
      throw new RemoteError(
        'PLATFORM_UNSUPPORTED',
        `WSL ${this.options.distroName} 的架构 ${rawArch || '(空)'} 不受支持；`
          + `支持 ${Object.keys(ARCH_MAP).join('、')}`,
        { hostAlias: this.hostAlias },
      );
    }
    return { os, arch, rawOs, rawArch };
  }

  /**
   * 构造 wsl.exe 的执行参数。
   *
   * @param command - 要在 WSL 内执行的完整命令
   * @returns wsl.exe 参数数组
   */
  private buildExecArgs(command: string): string[] {
    const args: string[] = ['-d', this.options.distroName];
    if (this.options.user) {
      args.push('-u', this.options.user);
    }
    args.push('-e', 'bash', '-c', command);
    return args;
  }

  /**
   * 给命令加上环境变量和 PATH 前缀。
   *
   * @param command - 原始命令
   * @param env - 环境变量
   * @param pathPrefix - 前置到 PATH 的目录
   * @returns 带前缀的命令
   */
  private buildCommand(
    command: string,
    env?: Record<string, string>,
    pathPrefix?: string,
  ): string {
    const assignments: string[] = [];

    if (pathPrefix !== undefined && pathPrefix.length > 0) {
      // `"$PATH"` 留在引号外由外层 shell 展开
      assignments.push(`PATH=${quote(pathPrefix)}:"$PATH"`);
    }
    for (const [key, value] of Object.entries(env ?? {})) {
      assignments.push(`${key}=${quote(value)}`);
    }

    if (assignments.length === 0) return command;
    return `env ${assignments.join(' ')} ${command}`;
  }

  /**
   * 把 POSIX 路径转为 UNC 路径。
   *
   * POSIX 路径以 `/` 开头，UNC 路径不需要双斜杠。
   * 例：`/home/user/file.txt` → `\\wsl.localhost\Ubuntu-22.04\home\user\file.txt`
   *
   * @param posixPath - POSIX 风格的绝对路径
   * @returns UNC 路径
   */
  private toUncPath(posixPath: string): string {
    // 去掉开头的 /，把 / 替换为 \
    const relativePart = posixPath.replace(/^\//, '').replaceAll('/', '\\');
    return `${UNC_PREFIX}${this.options.distroName}\\${relativePart}`;
  }

  /**
   * 通过 exec + stdin 写入文件（UNC 不可用时的回退路径）。
   *
   * @param remotePath - 远端绝对路径
   * @param content - 文件内容
   * @param options - 写入选项
   */
  private async writeViaExec(
    remotePath: string,
    content: string | Buffer,
    options: RemoteFileOptions,
  ): Promise<void> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const data = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;

    // 用 cat 从 stdin 读取内容写入文件
    const modeCmd = options.mode !== undefined
      ? `umask ${quote(String(options.mode))} && `
      : '';
    const command = `${modeCmd}cat > ${quote(remotePath)}`;
    const args = this.buildExecArgs(command);

    await new Promise<void>((resolve, reject) => {
      const child = execFile(getWslExePath(), args, { timeout: timeoutMs }, (error) => {
        if (error) {
          reject(new RemoteError(
            'EXEC_FAILED',
            `WSL ${this.options.distroName} 上写入文件 ${remotePath} 失败: ${toErrorMessage(error)}`,
            { cause: error, hostAlias: this.hostAlias },
          ));
        } else {
          resolve();
        }
      });
      // 通过 stdin 传入内容
      if (child.stdin) {
        child.stdin.end(data);
      }
    });
  }

  /**
   * 通过 exec + stdout 读取文件（UNC 不可用时的回退路径）。
   *
   * @param remotePath - 远端绝对路径
   * @param options - 读取选项
   * @returns 文件内容
   */
  private async readViaExec(remotePath: string, options: RemoteFileOptions): Promise<Buffer> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const command = `cat ${quote(remotePath)}`;
    const args = this.buildExecArgs(command);

    return new Promise<Buffer>((resolve, reject) => {
      execFile(getWslExePath(), args, { encoding: 'buffer', timeout: timeoutMs }, (error, stdout) => {
        if (error) {
          reject(new RemoteError(
            'EXEC_FAILED',
            `WSL ${this.options.distroName} 上读取文件 ${remotePath} 失败: ${toErrorMessage(error)}`,
            { cause: error, hostAlias: this.hostAlias },
          ));
        } else {
          resolve(stdout as unknown as Buffer);
        }
      });
    });
  }

  /**
   * 解析 openChannel 的实际连接地址。
   *
   * WSL2 Mirrored 模式或 WSL1：直接用传入的 remoteHost（通常是 127.0.0.1）。
   * WSL2 NAT 模式：需要获取 WSL VM 的 IP 地址。
   *
   * @param remoteHost - 请求的目标地址
   * @returns 实际应连接的地址
   */
  private async resolveConnectHost(remoteHost: string): Promise<string> {
    // 如果目标不是 localhost，直接透传
    if (remoteHost !== '127.0.0.1' && remoteHost !== 'localhost') {
      return remoteHost;
    }

    // WSL2 无论 NAT 还是 mirrored 模式，Windows 的 localhost:PORT 都会
    // 自动转发到 WSL 内的 127.0.0.1:PORT（localhostForwarding 默认开启）。
    // 因此 openChannel 始终用 127.0.0.1 连接即可，不需要获取 VM IP。
    //
    // 注意：这个转发有约 3-5 秒冷启动延迟（首次连接时 WSL2 网络栈建立映射），
    // LocalForward 的重试机制可以覆盖这个延迟。
    //
    // 如果未来遇到 localhostForwarding 被禁用的环境，可在此处加 socat 桥接回退。
    return remoteHost;
  }

  /**
   * 校验传输仍可用。
   *
   * @throws RemoteError('CONNECT_FAILED') 已释放或已失效
   */
  private requireAlive(): void {
    if (this.disposed || !this.alive) {
      throw new RemoteError('CONNECT_FAILED', `WSL ${this.options.distroName} 传输已关闭`, {
        hostAlias: this.hostAlias,
      });
    }
  }
}

/**
 * 执行 wsl.exe 命令并收集输出。
 *
 * @param args - wsl.exe 参数
 * @param timeoutMs - 超时（毫秒）
 * @param signal - 取消信号
 * @returns 执行结果
 */
async function runWslCommand(
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve, reject) => {
    let settled = false;
    let stdout = '';
    let stderr = '';

    const finish = (outcome: { value?: ExecResult; error?: Error }): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      if (outcome.error) {
        reject(outcome.error);
      } else if (outcome.value) {
        resolve(outcome.value);
      }
    };

    const onAbort = (): void => {
      child.kill();
      finish({ error: new RemoteError('ABORTED', 'WSL 命令被取消') });
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const child = execFile(
      getWslExePath(),
      args,
      { encoding: 'utf8', timeout: timeoutMs },
      (error, stdoutText, stderrText) => {
        if (error && !('code' in error)) {
          // 非退出码错误（如超时、spawn 失败）
          finish({ error });
          return;
        }
        stdout = stdoutText ?? '';
        stderr = stderrText ?? '';
        const exitCode = error && 'code' in error ? (error as { code: number }).code : 0;
        finish({
          value: {
            stdout,
            stderr,
            exitCode: exitCode ?? null,
          },
        });
      },
    );
  });
}

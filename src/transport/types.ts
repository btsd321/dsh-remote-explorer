/**
 * @file 远端传输抽象接口
 * @description 定义上层（引导、隧道、会话编排）唯一依赖的远端传输契约。
 *              首版只有 SSH 一个实现，但接口按多传输设计——日后加 Docker / WSL
 *              只需新增实现，不动上层任何代码。
 *
 * 设计依据：Zed 的 `crates/remote/src/remote_client.rs` 用 `trait RemoteConnection`
 * 把 SSH / WSL / Docker 三种传输并列，上层只见 trait。本文件是其 TypeScript 等价物。
 *
 * 分层约束：本文件属传输层，不得 import 编排层或能力层的任何模块。
 */

import type { Duplex } from 'node:stream';

/** 远端操作系统（`uname -s` 的归一化结果） */
export type RemoteOs = 'linux' | 'darwin';

/** 远端 CPU 架构（Node 发行版命名口径） */
export type RemoteArch = 'x64' | 'arm64' | 'armv7l';

/** 远端平台信息 */
export interface RemotePlatform {
  /** 操作系统 */
  os: RemoteOs;
  /** CPU 架构（已从 uname 输出归一化，如 aarch64 → arm64） */
  arch: RemoteArch;
  /** `uname -s` 原始输出，用于诊断 */
  rawOs: string;
  /** `uname -m` 原始输出，用于诊断 */
  rawArch: string;
}

/** 远端命令执行结果 */
export interface ExecResult {
  /** 标准输出（已按 utf8 解码） */
  stdout: string;
  /** 标准错误（已按 utf8 解码） */
  stderr: string;
  /** 退出码；被信号终止时为 null */
  exitCode: number | null;
  /** 终止信号名；正常退出时为 undefined */
  signal?: string;
}

/** 远端命令执行选项 */
export interface ExecOptions {
  /** 超时（毫秒）；省略则用传输层默认值 */
  timeoutMs?: number;
  /** 取消信号；触发时关闭通道并抛 RemoteError('ABORTED') */
  signal?: AbortSignal;
  /**
   * 追加的环境变量，以 `env K=V` 前缀形式注入。
   *
   * 值会被 shell 转义，所以**不能**在值里写 `$VAR` 期待展开——
   * 单引号会让它变成字面量。需要在已有变量前追加内容时用 {@link pathPrefix}。
   */
  env?: Record<string, string>;

  /**
   * 前置到 `PATH` 的目录。
   *
   * 单独设一个选项而不是走 {@link env}，因为 `PATH=<新>:$PATH` 这种写法
   * 经转义后 `$PATH` 不会展开，远端 PATH 会变成字面量，
   * 连 `rm`、`mkdir` 这些基础命令都找不到。
   *
   * 典型用途：dsh 与 npm 的 shebang 是 `#!/usr/bin/env node`，
   * 必须让 node 的 bin 目录在 PATH 里。
   */
  pathPrefix?: string;
  /** 允许非零退出码而不抛错，由调用方自行判断 */
  allowNonZeroExit?: boolean;
}

/** 远端文件读写选项 */
export interface RemoteFileOptions {
  /** 超时（毫秒）；省略则用传输层默认值（批量上传另有更宽的默认值） */
  timeoutMs?: number;
  /** 取消信号；触发时等待中的操作立即拒绝 */
  signal?: AbortSignal;
  /**
   * 文件模式（如 `0o600`）。
   *
   * 仅在**创建新文件**时生效（SFTP writeFile 语义，等同 open 的 mode 参数）；
   * 覆盖已存在文件不改其模式。需要强制修正模式时另行 chmod。
   */
  mode?: number;
}

/** 批量文件传输中的一个条目 */
export interface FileTransfer {
  /** 本机文件路径 */
  localPath: string;
  /** 远端绝对路径（POSIX 风格） */
  remotePath: string;
}

/** 反向转发收到的一个入站连接 */
export interface ReverseConnection {
  /** 远端侧发起连接的地址 */
  remoteAddr: string;
  /** 远端侧发起连接的端口 */
  remotePort: number;
  /** 双向流；调用方负责接管与销毁 */
  stream: Duplex;
}

/** 一条通向远端目标的双向通道 */
export interface RemoteChannel {
  /** 双向流；调用方负责 pipe 与销毁 */
  stream: Duplex;
  /** 归还该通道占用的配额；流关闭后必须调用 */
  release(): void;
}

/** 反向转发句柄 */
export interface ReverseHandle {
  /** 远端实际监听的端口 */
  remotePort: number;
  /** 关闭转发并请求远端取消监听 */
  close(): Promise<void>;
}

/**
 * 远端传输接口。
 *
 * 生命周期：`connect()` → 多次使用 → `dispose()`。
 * 实现方必须保证 `dispose()` 幂等，且失败路径也释放底层资源。
 *
 * 断线语义与 dsh-ssh 一致：传输自身不重连，连接丢失后所有挂起操作作废，
 * 重连由会话编排层负责。
 */
export interface RemoteTransport {
  /** 主机别名（诊断与日志用） */
  readonly hostAlias: string;

  /** 探测到的远端平台；`connect()` 完成后可用 */
  readonly platform: RemotePlatform;

  /** 传输是否仍然可用 */
  readonly isAlive: boolean;

  /**
   * 建立底层连接并探测平台。
   *
   * @param signal - 取消信号
   * @throws RemoteError('CONNECT_FAILED') 连接或认证失败
   * @throws RemoteError('PLATFORM_UNSUPPORTED') 远端非 POSIX
   */
  connect(signal?: AbortSignal): Promise<void>;

  /**
   * 在远端执行一条命令。
   *
   * 命令字符串交给远端 shell 执行，调用方必须自行用 `quote()` 转义所有动态值。
   *
   * @param command - 完整命令字符串
   * @param options - 执行选项
   * @returns 执行结果
   * @throws RemoteError('EXEC_FAILED') 退出码非零且未设 `allowNonZeroExit`
   */
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;

  /**
   * 经 SFTP 上传单个本地文件到远端。
   *
   * 走池化 SFTP 会话（每连接一条，会话内并发不占额外通道配额）；
   * 死连接自动作废会话并重试一次。
   *
   * @param localPath - 本机文件路径
   * @param remotePath - 远端绝对路径（POSIX 风格）
   * @param signal - 取消信号
   */
  uploadFile(localPath: string, remotePath: string, signal?: AbortSignal): Promise<void>;

  /**
   * 批量上传本地文件到远端（fastPut，ssh2 内部分块并发流式）。
   *
   * 提速机制取自参考实现（flymysql/dsh-remote 的 pool/sync）：所有文件共享
   * **一条**池化 SFTP 会话，会话内按固定并发度流水线传输——SFTP 协议支持
   * 多个在飞请求，并发不新开 SSH 通道，通道配额纪律不受影响。
   *
   * 失败语义：首个错误即停止调度后续文件，等待在飞完成后抛出该错误。
   *
   * @param files - 传输条目列表
   * @param options - 超时（默认比单操作更宽）与取消信号
   */
  uploadFiles(files: readonly FileTransfer[], options?: RemoteFileOptions): Promise<void>;

  /**
   * 把内容写入远端文件（SFTP，二进制安全）。
   *
   * 与 shell 重定向（printf > file）相比：无命令长度上限、无转义开销、
   * 可传任意字节。目标文件的父目录必须已存在（本层不做 mkdir -p，
   * 目录骨架是调用方引导流程的职责）。
   *
   * @param remotePath - 远端绝对路径（POSIX 风格）
   * @param content - 文件内容（字符串按 utf8 编码）
   * @param options - 超时、取消信号与文件模式
   */
  writeRemoteFile(remotePath: string, content: string | Buffer, options?: RemoteFileOptions): Promise<void>;

  /**
   * 读取远端文件全部内容（SFTP，二进制安全）。
   *
   * @param remotePath - 远端绝对路径（POSIX 风格）
   * @param options - 超时与取消信号
   * @returns 文件内容
   */
  readRemoteFile(remotePath: string, options?: RemoteFileOptions): Promise<Buffer>;

  /**
   * 探测远端 SFTP 子系统可用性（试建一次会话，成功后留在池里复用）。
   *
   * @throws RemoteError('CONNECT_FAILED') SFTP 子系统不可用或会话建立失败
   */
  checkSftp(): Promise<void>;

  /**
   * 开一条通向远端目标的双向通道。
   *
   * 只负责开通道，不负责本机监听——本机监听器由隧道层持有，必须**跨重连存活**：
   * 重连后本机端口若发生变化，用户已打开的浏览器标签就失效了。所以传输实例
   * 可以被换掉，监听器不能。
   *
   * @param remoteHost - 远端目标地址，安全上应始终为 `127.0.0.1`
   * @param remotePort - 远端目标端口
   * @param signal - 取消信号
   * @returns 通道；使用完毕必须 `release()` 归还配额
   */
  openChannel(remoteHost: string, remotePort: number, signal?: AbortSignal): Promise<RemoteChannel>;

  /**
   * 反向转发：远端监听一个端口，其入站连接回到本机。
   *
   * 远端监听地址固定 `127.0.0.1`——绝不能让反向端口对外可见。
   *
   * @param remotePort - 远端监听端口
   * @param onConnection - 每个入站连接的处理器
   * @returns 转发句柄
   */
  forwardIn(
    remotePort: number,
    onConnection: (connection: ReverseConnection) => void,
  ): Promise<ReverseHandle>;

  /** 释放连接与全部派生资源；幂等 */
  dispose(): Promise<void>;
}

/**
 * @file 错误类型定义
 * @description 全仓库共用的错误类。错误消息一律中文且必须带定位信息
 *              （哪台主机、哪个路径、期望值与实际值），便于用户自行诊断。
 *
 * 分层约定：基础层只定义错误类型，不感知连接状态与 CLI 表现形式。
 */

/** 错误码：用于 CLI 决定退出码与提示文案，也便于测试断言 */
export type RemoteErrorCode =
  /** SSH config 中找不到该别名 */
  | 'HOST_NOT_FOUND'
  /** SSH config 缺少必要字段（HostName / User / IdentityFile） */
  | 'HOST_CONFIG_INVALID'
  /** SSH 连接建立失败（含跳板机链失败） */
  | 'CONNECT_FAILED'
  /** 远端命令执行返回非零退出码 */
  | 'EXEC_FAILED'
  /** 远端平台不受支持（非 POSIX） */
  | 'PLATFORM_UNSUPPORTED'
  /** 远端 Node 运行时不稳定（崩溃率自检不合格） */
  | 'NODE_UNSTABLE'
  /** 所有候选镜像均不可达 */
  | 'MIRROR_ALL_UNREACHABLE'
  /** 远端缺少必要的基础命令（curl/wget、tar 等） */
  | 'REMOTE_TOOL_MISSING'
  /** 操作被取消（AbortSignal 触发） */
  | 'ABORTED';

/**
 * 远程操作错误：携带错误码与可选的远端上下文。
 *
 * 用 `cause` 保留底层错误（ssh2 的 Error 等），不丢失原始堆栈。
 */
export class RemoteError extends Error {
  /**
   * @param code - 错误码
   * @param message - 中文错误消息，必须含定位信息
   * @param options - 可选的底层错误与主机别名
   */
  constructor(
    readonly code: RemoteErrorCode,
    message: string,
    options?: {
      /** 底层错误 */
      cause?: unknown;
      /** 相关主机别名 */
      hostAlias?: string;
    },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'RemoteError';
    this.hostAlias = options?.hostAlias;
  }

  /** 相关主机别名（如有） */
  readonly hostAlias: string | undefined;
}

/**
 * 把未知的捕获值归一化为错误消息文本。
 *
 * `catch (e: unknown)` 后不能假设拿到的是 Error，统一走这里。
 *
 * @param error - 捕获到的任意值
 * @returns 可读的错误消息
 */
export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

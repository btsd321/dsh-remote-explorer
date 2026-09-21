/**
 * @file 远端文本文件写入助手（SFTP 主路径，exec 回退）
 * @description 把一段文本写到远端文件的统一入口：主路径走池化 SFTP
 *              （{@link RemoteTransport.writeRemoteFile}），SFTP 不可用时
 *              （个别加固的 sshd 关闭了 sftp 子系统）回退到既有的
 *              `printf '%s' <quote(内容)> > <quote(路径)>` shell 重定向。
 *
 * 为什么保留回退：settings 镜像与 patch 写入是会话编排的关键路径，
 * 不能因为远端一个可选子系统缺席就整体失败。回退只对**文本**成立——
 * shell 重定向过不了二进制内容（那正是必须走 SFTP 的场合），所以
 * 二进制写入（writeRemoteFile 直调）没有回退路径。
 *
 * 分层约束：本文件属传输层的横切助手，只依赖传输接口与 util，
 * 不感知调用方业务语义；容忍/严格两种失败语义由调用方选择。
 */

import { RemoteError, toErrorMessage } from '../util/errors.js';
import { quote } from '../util/shell-quote.js';
import type { RemoteTransport } from './types.js';

/** 文本写入选项 */
export interface WriteRemoteTextOptions {
  /**
   * 容忍模式：写入失败不抛错（尽力而为语义）。
   *
   * settings 镜像用这个模式——它与主流程解耦，写失败的后果（远端 dsh
   * 用默认 settings）可接受，不应让整个会话开不起来。patch 等关键文件
   * 用默认的严格模式。
   */
  tolerant?: boolean;
  /** 取消信号 */
  signal?: AbortSignal;
}

/**
 * 写文本到远端文件：SFTP 主路径，exec printf 回退。
 *
 * @param transport - 传输实例
 * @param remotePath - 远端绝对路径（POSIX 风格；父目录必须已存在）
 * @param text - 文本内容
 * @param options - 容忍模式与取消信号
 * @throws RemoteError('EXEC_FAILED') 严格模式下两条路径都失败
 */
export async function writeRemoteTextFile(
  transport: RemoteTransport,
  remotePath: string,
  text: string,
  options: WriteRemoteTextOptions = {},
): Promise<void> {
  // 1. SFTP 主路径：二进制安全、无命令长度上限、无转义开销
  let sftpError: unknown;
  try {
    await transport.writeRemoteFile(remotePath, text, options.signal ? { signal: options.signal } : {});
    return;
  } catch (error) {
    // 取消不进回退——用户明确不要这个操作了
    if (error instanceof RemoteError && error.code === 'ABORTED') throw error;
    sftpError = error;
  }

  // 2. 回退 printf-over-exec（历史路径，行为与 SFTP 化之前一致）
  try {
    const result = await transport.exec(
      `printf '%s' ${quote(text)} > ${quote(remotePath)}`,
      { allowNonZeroExit: true, ...(options.signal ? { signal: options.signal } : {}) },
    );
    if (!options.tolerant && result.exitCode !== 0) {
      throw new RemoteError(
        'EXEC_FAILED',
        `写入 ${transport.hostAlias}:${remotePath} 失败（printf 回退，退出码 ${result.exitCode}）：`
          + `${result.stderr.trim().slice(0, 200)}`,
        { hostAlias: transport.hostAlias },
      );
    }
  } catch (error) {
    if (options.tolerant) return;
    // 两条路径都失败：把 SFTP 侧的原因一并带上，避免只看到回退路径的表象
    throw new RemoteError(
      'EXEC_FAILED',
      `写入 ${transport.hostAlias}:${remotePath} 失败（SFTP：${toErrorMessage(sftpError)}；`
        + `printf 回退：${toErrorMessage(error)}）`,
      { cause: error, hostAlias: transport.hostAlias },
    );
  }
}

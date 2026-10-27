/**
 * @file 本地资源下载策略（local_resource_download 的模式决策与执行编排）
 * @description 把 auto/always/off 三种模式的分支决策收口到一处，供 node-installer /
 *              dsh-installer / pnpm-installer 三个 installer 复用——各自只声明"远端下载
 *              函数"与"本机下载函数"，模式决策与 auto 回退编排由本模块统一处理。
 *
 * 三种模式的语义（与 VS Code Remote.SSH: Local Server Download 对齐）：
 * - `off`：仅远端下载（原行为，恢复 installer 既有逻辑）
 * - `always`：仅本机下载（跳过远端下载，直接本机 fetch + SFTP 上传 + 远端解包）
 * - `auto`（默认）：先远端下载，失败回退本机下载（远端无网时的自愈路径）
 *
 * auto 回退的判定：远端下载函数抛错即触发回退。回退前先清理远端残留的半成品
 * 临时文件（installer 的远端下载函数在失败路径上可能已留下半个 tarball），
 * 避免本机上传覆盖到残留文件上。
 *
 * 分层约束：本文件属能力层（provision/），向下使用传输层（transport/types）
 * 与基础层（util/logger）；不依赖编排层或入口层。类型导入
 * {@link LocalResourceDownloadMode} 来自同层 local-download-mode（零依赖纯类型）。
 */

import { createLogger } from '../util/logger.js';
import { toErrorMessage } from '../util/errors.js';
import type { LocalResourceDownloadMode } from './local-download-mode.js';
import type { RemoteTransport } from '../transport/types.js';

const log = createLogger('local-download-strategy');

/**
 * 资源下载策略执行结果。
 *
 * installer 拿到结果后根据 `viaLocal` 决定后续安装步骤的形态——本机下载
 * 的 tarball 已在远端的临时目录里（经 SFTP 上传），后续解包/安装路径与
 * 远端下载的 tarball 完全一致（解包命令对 tarball 来源无感知）。
 */
export interface DownloadStrategyResult {
  /** 本次下载是否经本机网络 + SFTP 上传（auto 回退或 always 直走） */
  viaLocal: boolean;
}

/**
 * 资源下载策略选项（installer 传给本模块的统一接口）。
 */
export interface DownloadStrategyOptions {
  /** 本地资源下载模式；undefined 按 auto 处理（与 advanced-store 默认值同源） */
  localResourceDownload?: LocalResourceDownloadMode;
  /** 远端传输实例（日志与 hostAlias 诊断用） */
  transport: RemoteTransport;
  /**
   * 远端下载函数（原行为：远端 curl / npm install 下载到远端临时目录）。
   *
   * off 模式直接调它；auto 模式先调它，失败回退本机下载；always 模式不调它。
   * 函数内部抛错即视为远端下载失败（auto 触发回退）。
   */
  remoteDownload: () => Promise<void>;
  /**
   * 本机下载 + SFTP 上传函数（本机 fetch 下载到本机临时文件，再经
   * transport.uploadFile 传到远端临时目录）。
   *
   * always 模式直接调它；auto 模式在远端下载失败后调它；off 模式不调它。
   * 函数内部抛错即视为本机下载也失败——向上抛（auto 回退后仍失败 = 不可恢复）。
   */
  localDownload: () => Promise<void>;
  /**
   * 远端临时文件清理函数（auto 回退前调用，清理远端下载留下的半成品）。
   *
   * 幂等：远端下载未产生残留时调用也无害。undefined 时跳过（个别 installer
   * 的远端下载函数已在自身 finally 里清理了残留，不需要外层再清）。
   */
  cleanupRemoteTemp?: () => Promise<void>;
  /** 资源名称（日志用，如 `Node v24.21.0`、`dsh 0.2.0-rc.2`） */
  resourceName: string;
}

/**
 * 按模式执行资源下载策略。
 *
 * @param options - 策略选项
 * @returns 下载结果（含是否经本机下载的标记）
 * @throws Error 远端与本机下载都失败（auto 模式），或唯一启用的路径失败
 *               （off 的远端失败 / always 的本机失败）
 */
export async function executeDownloadStrategy(
  options: DownloadStrategyOptions,
): Promise<DownloadStrategyResult> {
  const { transport, remoteDownload, localDownload, resourceName } = options;
  // undefined 按 auto 处理（与 advanced-store 的 DEFAULT_LOCAL_RESOURCE_DOWNLOAD 同源）
  const mode = options.localResourceDownload ?? 'auto';

  // off：仅远端下载，原行为不变
  if (mode === 'off') {
    await remoteDownload();
    return { viaLocal: false };
  }

  // always：仅本机下载，跳过远端
  if (mode === 'always') {
    log.info(`${resourceName}：always 模式，直接本机下载 + SFTP 上传`, {
      hostAlias: transport.hostAlias,
    });
    await localDownload();
    return { viaLocal: true };
  }

  // auto：先远端下载，失败回退本机下载
  try {
    await remoteDownload();
    return { viaLocal: false };
  } catch (remoteError) {
    // 远端下载失败——清理远端残留后回退本机下载
    const reason = toErrorMessage(remoteError);
    log.warn(`${resourceName}：远端下载失败（${reason}），auto 模式回退本机下载 + SFTP 上传`, {
      hostAlias: transport.hostAlias,
    });
    if (options.cleanupRemoteTemp !== undefined) {
      try {
        await options.cleanupRemoteTemp();
      } catch (cleanupError) {
        // 清理失败不阻断回退——残留文件会被本机上传覆盖或后续安装流程清理
        log.warn(`${resourceName}：回退前远端临时文件清理失败（${toErrorMessage(cleanupError)}），继续回退本机下载`, {
          hostAlias: transport.hostAlias,
        });
      }
    }
    try {
      await localDownload();
      log.info(`${resourceName}：本机下载 + SFTP 上传成功（auto 回退）`, {
        hostAlias: transport.hostAlias,
      });
      return { viaLocal: true };
    } catch (localError) {
      // 本机下载也失败——汇总两侧错误向上抛（调用方决定是否降级到下一候选版本）
      throw new Error(
        `${resourceName} 下载失败：远端下载失败（${reason}），回退本机下载也失败（${toErrorMessage(localError)}）`,
      );
    }
  }
}

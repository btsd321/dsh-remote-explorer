/**
 * @file 供应商设置文档同步（远端 profile 的 cordis.patch.yml）
 * @description 把一条供应商条目写进远端 profile 的**设置文档**——也就是 dsh
 *              自己读写「设置 → 模型」的那份文件。纯文本合并规则在
 *              provider-routes 的 `mergeProfileProviderPatch`，本模块只负责
 *              远端读、调用合并、原子写回与日志。
 *
 * 为什么需要单独一层（不是优化，是正确性）：
 *
 * - dsh 的设置文档 = `profiles/<name>/cordis.patch.yml`（`dsh-settings` 的
 *   `configEditor.documentPath`）。GUI 读写里面的 `user` 层，模型卡片的「继承
 *   模型」读 `base` 层；命令行 `--patch` 覆盖层**两层都不算**，只出现在组合树里，
 *   而且对同一 `id` 是整块替换。供应商写进覆盖层 → 远端设置页看不到模型，
 *   用户在远端的增改也会被整块盖掉（详见 docs/lessons.md 23d）。
 * - 目标文件是**机器级共享的用户设置文档**，所以三条安全契约必须成立：
 *   读取失败不能当成「文件不存在」（否则会用只含一条的内容覆盖用户全部设置）、
 *   写入必须原子（先截断再写会留下半截文档）、内容等价时不重写（避免无谓地
 *   触发远端 dsh 的配置重组合与设置页刷新）。
 *
 * 分层：本文件与 proxy-secret 同属凭据能力层，向下使用传输层写入助手与
 * provision 的路径规则（`RemoteContext` 仅类型引用）。
 */

import { writeRemoteTextFile } from '../transport/write-text.js';
import { RemoteError } from '../util/errors.js';
import { quote } from '../util/shell-quote.js';
import { createLogger } from '../util/logger.js';
import { mergeProfileProviderPatch, type ProviderPatchEntry } from './provider-routes.js';
import type { RemoteContext } from '../provision/remote-context.js';

const log = createLogger('provider-profile-sync');

/** 会话使用的 profile 名（与 dsh 官方模板 `web` 对齐；见 provision/profile-writer） */
const SESSION_PROFILE_NAME = 'web';

/**
 * 把供应商条目同步进远端 profile patch（= dsh 的设置文档）。
 *
 * 关键约束（详见 provider-routes.ts 里 ProviderPatchEntry 与本文文件头的说明）：
 * - 只替换 `llm-pi-ai` 一条，其余条目、行内注释与文件头注释原样保留
 * - **读取失败与文件不存在必须分开判定**
 * - 写入走「同目录临时文件 + rename」
 * - 解析不了就跳过（宁可这次没有供应商路由，也不能覆盖用户设置）
 * - 内容已等价时不写
 *
 * @param ctx - 远端执行上下文
 * @param entry - 待写入的供应商条目（baseURL 已重定向进隧道）
 * @param signal - 取消信号
 * @returns 写入的远端文件绝对路径
 * @throws RemoteError('EXEC_FAILED') 远端设置文档读取失败、无法解析或写入失败
 */
export async function syncProviderProfileEntry(
  ctx: RemoteContext,
  entry: ProviderPatchEntry,
  signal?: AbortSignal,
): Promise<string> {
  const { transport, paths } = ctx;
  const patchPath = paths.hostProfilePatch(SESSION_PROFILE_NAME);

  // 1. 文件存在性单独探测：`cat ... || true` 会把「读失败」和「文件不存在」
  //    混成同一个空输出，那是会丢用户设置的错误
  const probe = await transport.exec(
    `test -e ${quote(patchPath)} && echo YES || echo NO`,
    { allowNonZeroExit: true, ...(signal ? { signal } : {}) },
  );
  let existingText: string | undefined;
  if (probe.stdout.includes('YES')) {
    const read = await transport.exec(`cat ${quote(patchPath)}`, {
      allowNonZeroExit: true,
      ...(signal ? { signal } : {}),
    });
    if (read.exitCode !== 0) {
      throw new RemoteError(
        'EXEC_FAILED',
        `主机 ${transport.hostAlias} 上读取 profile 设置文档失败（${patchPath}，`
          + `退出码 ${read.exitCode}）：为避免覆盖远端用户设置，已跳过供应商配置写入`,
        { hostAlias: transport.hostAlias },
      );
    }
    existingText = read.stdout;
  }

  // 2. 合并（纯函数，规则见 credential/provider-routes 的同名函数）
  const merged = mergeProfileProviderPatch(existingText, entry);
  if (merged === undefined) {
    throw new RemoteError(
      'EXEC_FAILED',
      `主机 ${transport.hostAlias} 的 profile 设置文档无法解析（${patchPath}）：`
        + '为避免覆盖远端用户设置，已跳过供应商配置写入',
      { hostAlias: transport.hostAlias },
    );
  }
  if (!merged.merged) {
    log.debug(`供应商配置已是等价内容，跳过写入: ${patchPath}`, { hostAlias: transport.hostAlias });
    return patchPath;
  }

  // 3. 原子写：临时文件 + 同目录 rename。chmod 600 与 dsh 自己写的设置文档权限一致
  const tmpPath = `${patchPath}.tmp`;
  await writeRemoteTextFile(transport, tmpPath, merged.text, signal ? { signal } : {});
  await transport.exec(
    `chmod 600 ${quote(tmpPath)} && mv -f ${quote(tmpPath)} ${quote(patchPath)}`,
    { ...(signal ? { signal } : {}) },
  );

  log.info(`供应商配置已写入远端 profile 设置文档: ${patchPath}`, {
    hostAlias: transport.hostAlias,
  });
  return patchPath;
}

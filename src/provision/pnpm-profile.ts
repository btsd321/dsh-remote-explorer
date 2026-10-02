/**
 * @file 远端 profile 的 pnpm 运行前提补齐
 * @description pnpm 11 在远端 host profile（`base/profiles/<platform>/`）启用需要
 *              pnpm-workspace.yaml 里两段设置，缺失时任一插件安装都会致命失败——
 *              这正是历史把远端 pin 在 10 系的原因；如今补齐前提后远端与本地
 *              （dsh 官方仓库 packageManager 钉 11.7.0）对齐：
 *
 * - `allowBuilds`：pnpm 11 对未决策构建脚本直接致命报错
 *   （ERR_PNPM_IGNORED_BUILDS），远端 profile 无交互决策入口——逐包放行
 *   ssh2/cpu-features（原生加密绑定）与 esbuild（平台二进制校验），
 *   与本仓库根 pnpm-workspace.yaml 的决策一致
 * - `minimumReleaseAge: 0`：pnpm 11 默认 24h 供应链门槛会拒装发布不满
 *   24 小时的包，远端插件安装（跟踪 dsh 当天发布的 RC）必踩，显式关闭
 *
 * 补齐是幂等纯文本操作（{@link ensurePnpmWorkspaceSettings}）：读现有 yaml，
 * 已有顶层 key 的行一字不动，只追加缺失段；文件不存在则创建「dsh 模板设置 +
 * 两段前提」的最小骨架。dsh 首启会生成该文件（实测存在），且**对已存在的
 * 文件不覆盖**（/tmp 隔离 DSH_HOME 实测：预写标记文件后 `--dump-config`
 * 初始化原样保留）——所以最小骨架必须自带 dsh 模板的
 * `packages`/`nodeLinker`/`autoInstallPeers`：先建文件会让 dsh 跳过模板
 * 写入，缺这三行的话全新主机的 profile 会退回 pnpm 默认 nodeLinker。
 *
 * 写入经 writeRemoteTextFile 严格语义——**刻意不容忍**：写失败上抛，而不是
 * 像 settings 镜像那样尽力而为。容忍会把 pnpm 11 的插件操作埋雷到运行期
 * （用户在面板里点安装才炸，且报错与缺设置的因果隔了几个阶段）。
 */

import { RemoteError, toErrorMessage } from '../util/errors.js';
import { createLogger } from '../util/logger.js';
import { quote } from '../util/shell-quote.js';
import { writeRemoteTextFile } from '../transport/write-text.js';
import { DEFAULT_PLATFORM } from './plugin-store.js';
import type { RemoteContext } from './remote-context.js';

const log = createLogger('pnpm-profile');

/**
 * 顶层 `allowBuilds:` 行的存在判据。
 *
 * 只认行首无缩进的形态：这两段是 pnpm 的 workspace 顶层设置，嵌套在别处的
 * 同名 key 不代表本设置已决策。
 */
const ALLOW_BUILDS_PATTERN = /^allowBuilds[ \t]*:/m;

/** 顶层 `minimumReleaseAge:` 行的存在判据（同上，只认无缩进行首） */
const MINIMUM_RELEASE_AGE_PATTERN = /^minimumReleaseAge[ \t]*:/m;

/**
 * allowBuilds 补齐段（带中文注释说明为何存在）。
 *
 * 与本仓库根 pnpm-workspace.yaml 的逐包决策对齐：ssh2/cpu-features 构建原生
 * 加密绑定（sshcrypto.node），esbuild 校验平台二进制。
 */
const ALLOW_BUILDS_SECTION = [
  '# pnpm 11 对未决策构建脚本致命报错（ERR_PNPM_IGNORED_BUILDS），远端 profile',
  '# 无交互决策入口——逐包放行（dsh-remote-explorer 引导幂等补齐）。',
  'allowBuilds:',
  '  cpu-features: true',
  '  esbuild: true',
  '  ssh2: true',
].join('\n');

/**
 * minimumReleaseAge 补齐段（带中文注释说明为何存在）。
 *
 * pnpm 11 默认 24h 供应链门槛会拒装发布不满 24 小时的包，远端插件安装场景
 * 必踩，显式置 0 关闭——风险由插件规格显式化（包名@版本）兜底。
 */
const MINIMUM_RELEASE_AGE_SECTION = [
  '# pnpm 11 默认 24h 供应链门槛会拒装发布不满 24 小时的包（远端插件安装',
  '# 场景必踩），显式置 0 关闭（dsh-remote-explorer 引导幂等补齐）。',
  'minimumReleaseAge: 0',
].join('\n');

/**
 * 文件缺失时最小骨架里的 dsh 模板设置段。
 *
 * 逐行对齐 dsh profile 模板的生成结果（用户机器实测，61 字节）：
 * `packages`/`nodeLinker: hoisted`/`autoInstallPeers: false`。dsh 初始化对
 * 已存在的 pnpm-workspace.yaml 不覆盖（/tmp 隔离实测），引导先建文件会让
 * dsh 跳过模板写入——不带这三行，全新主机的 profile 会退回 pnpm 默认
 * nodeLinker（isolated），与 dsh 官方行为漂移。
 */
const DSH_TEMPLATE_SECTION = [
  '# 以下设置对齐 dsh profile 模板（引导先建此文件时 dsh 不再写模板，',
  '# 缺失会让 profile 退回 pnpm 默认 nodeLinker——见本文件头）。',
  'packages:',
  '  - .',
  '',
  'nodeLinker: hoisted',
  'autoInstallPeers: false',
].join('\n');

/**
 * 幂等补齐 host profile 的 pnpm-workspace.yaml 文本。
 *
 * 规则：
 * - 两段顶层 key 都已存在 → 原样返回（已有决策可能是 dsh 模板或用户显式写的，
 *   只认 key 存在、不合并内容，避免覆盖他人决策）
 * - 文本为空/纯空白（文件缺失）→ 「dsh 模板设置 + 两段前提」的最小骨架
 *   （模板段的必要性见 {@link DSH_TEMPLATE_SECTION}）
 * - 有内容缺段 → 补齐结尾换行后追加缺失段，段间空一行
 *
 * 幂等性保证：对补齐输出再跑一次得到相同文本（单测覆盖）。
 *
 * @param yaml - 现有 yaml 文本；文件缺失时空串
 * @returns 补齐后的文本；已是补齐态时原样返回
 */
export function ensurePnpmWorkspaceSettings(yaml: string): string {
  const hasAllowBuilds = ALLOW_BUILDS_PATTERN.test(yaml);
  const hasMinimumReleaseAge = MINIMUM_RELEASE_AGE_PATTERN.test(yaml);

  // 全齐：原样返回（幂等）
  if (hasAllowBuilds && hasMinimumReleaseAge) return yaml;

  // 文件缺失/空文本：dsh 模板设置 + 两段前提的最小骨架
  if (yaml.trim() === '') {
    return [
      ALLOW_BUILDS_SECTION,
      '',
      MINIMUM_RELEASE_AGE_SECTION,
      '',
      DSH_TEMPLATE_SECTION,
    ].join('\n') + '\n';
  }

  // 有内容缺段：追加（先确保结尾有换行，段间空一行分隔）
  const base = yaml.endsWith('\n') ? yaml : `${yaml}\n`;
  const sections: string[] = [];
  if (!hasAllowBuilds) sections.push(ALLOW_BUILDS_SECTION);
  if (!hasMinimumReleaseAge) sections.push(MINIMUM_RELEASE_AGE_SECTION);
  return `${base}\n${sections.join('\n\n')}\n`;
}

/**
 * 确保 host profile 的 pnpm-workspace.yaml 含 pnpm 11 运行前提（幂等）。
 *
 * 读现有文本 → {@link ensurePnpmWorkspaceSettings} 纯函数补齐 → 有变化才写回
 * （无变化不产生任何写IO）。目录位置是 host profile 的
 * `paths.hostProfileDir(DEFAULT_PLATFORM)`——补的就是 `pnpm add` 的工作目录，
 * 两处必须指向同一处：远端窗口原生插件 UI 与 `dsh plugin` 都在此目录动包。
 *
 * @param ctx - 远端执行上下文
 * @param options - 取消信号与进度回调
 * @returns updated = 本次是否写回（false 即已补齐/幂等命中）
 * @throws RemoteError('EXEC_FAILED') 写入失败（严格语义，见文件头）
 */
export async function ensurePnpmProfileSettings(
  ctx: RemoteContext,
  options: {
    /** 取消信号 */
    signal?: AbortSignal;
    /** 阶段进度回调 */
    onProgress?: (message: string) => void;
  } = {},
): Promise<{ path: string; updated: boolean }> {
  const { transport, paths } = ctx;
  const { signal } = options;
  const profileDir = paths.hostProfileDir(DEFAULT_PLATFORM);
  const path = `${profileDir}/pnpm-workspace.yaml`;

  // 1. 读现有文本：cat 自带容错（`2>/dev/null || true`），缺失当空串处理
  const existing = await transport.exec(
    `cat ${quote(path)} 2>/dev/null || true`,
    { allowNonZeroExit: true, ...(signal ? { signal } : {}) },
  );

  // 2. 纯函数补齐；无变化不写回（幂等，也省一次写 IO）。两条路径都留痕：
  //    「检查过且已齐备」与「实际补齐」在复盘日志里是一样重要的信息
  const next = ensurePnpmWorkspaceSettings(existing.stdout);
  if (next === existing.stdout) {
    log.debug('远端 profile pnpm 11 前提已齐备，无需写入', {
      hostAlias: transport.hostAlias,
      path,
    });
    return { path, updated: false };
  }

  // 3. 父目录防御：首次引导时 host profile 要到「准备会话 profile」阶段才由
  //    dsh 初始化创建，此刻可能尚不存在——mkdir -p 幂等，不干扰后续初始化
  await transport.exec(`mkdir -p ${quote(profileDir)}`, {
    allowNonZeroExit: true,
    ...(signal ? { signal } : {}),
  });

  // 4. 严格写入：SFTP 主路径、printf 回退；失败上抛，不给 pnpm 11 埋雷
  options.onProgress?.('补齐 pnpm-workspace.yaml（pnpm 11 前提）');
  try {
    await writeRemoteTextFile(transport, path, next, signal ? { signal } : {});
  } catch (error) {
    throw new RemoteError(
      'EXEC_FAILED',
      `在主机 ${transport.hostAlias} 上补齐 pnpm 11 前提失败（${path}）：${toErrorMessage(error)}`,
      { cause: error, hostAlias: transport.hostAlias },
    );
  }
  log.info('远端 profile pnpm 11 前提已补齐（allowBuilds/minimumReleaseAge）', {
    hostAlias: transport.hostAlias,
    path,
  });
  return { path, updated: true };
}

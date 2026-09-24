/**
 * @file 主机级共享 profile 管理（dsh 官方 `$DSH_HOME/profiles/<name>/` 结构）
 * @description 插件安装/卸载的唯一真源在 `base/profiles/<platform>/`，与 dsh 官方
 *              plugin-manager 的操作目录完全一致。所有会话通过 symlink 共享同一份
 *              安装——会话 `$DSH_HOME/profiles/<platform>` 是指向主机级 profile 的
 *              整体 symlink。
 *
 * 与 dsh 官方的一致性：
 * - pnpm 在 host profile 目录执行 add/remove，操作 host profile 的 package.json
 * - dsh 原生 UI 的 plugin-manager 也在同一目录操作，不存在双真源冲突
 * - bundle 解析从 profile 锚命中 symlink，peer 裸导入由回退链接闭环
 *
 * 回退链接（`@deepseek-ai/`、`cpu-features`、`nan` → dsh 安装树）在 host profile
 * 的 node_modules 中创建，等价于 dsh 自己在 `$DSH_HOME/profiles/node_modules`
 * 做的安装回退链接。
 */

import { quote } from '../util/shell-quote.js';
import { writeRemoteTextFile } from '../transport/write-text.js';
import { HANDOFF_PKG_NAME } from '../handoff/protocol.js';
import type { RemoteContext } from './remote-context.js';
import type { RemotePaths } from './remote-paths.js';
import type { RemoteTransport } from '../transport/types.js';

/**
 * manifest 读写所需的最小 IO：监督器用会话的窄委托（exec/writeRemoteFile），
 * 引导路径用传输本体——同一套逻辑两处复用，且 provision 层不 import 编排层。
 */
export interface ManifestIo {
  /** 远端执行（只取 stdout） */
  exec(command: string, options?: { allowNonZeroExit?: boolean }): Promise<{ stdout: string }>;
  /** 写远端文本文件 */
  writeFile(path: string, content: string): Promise<void>;
}

/**
 * 把传输适配成 ManifestIo。
 *
 * @param transport - 已连接的传输
 * @returns IO 适配器
 */
export function transportIo(transport: RemoteTransport): ManifestIo {
  return {
    exec: (command, options) => transport.exec(command, options),
    writeFile: (path, content) => writeRemoteTextFile(transport, path, content, {}),
  };
}

/** host profile manifest 的本工具关心部分 */
export interface PluginStoreManifest {
  name?: string;
  private?: boolean;
  dependencies?: Record<string, string>;
  dsh?: { profile?: { bundles?: string[] } };
}

/** 默认平台 profile 名（与 dsh 模板 web 对齐） */
export const DEFAULT_PLATFORM = 'web';

/**
 * 确保主机级 profile 骨架：目录、空清单、三条 peer 回退链接（幂等）。
 *
 * 回退链接目标随 dsh 版本变（升级后重链）；`ln -sfn` 覆盖旧链接。
 *
 * @param ctx - 远端执行上下文
 * @param dshVersion - 当前会话使用的 dsh 版本（回退链接锚定其安装树）
 * @param platform - 平台 profile 名（默认 web）
 */
export async function ensureHostProfile(
  ctx: RemoteContext,
  dshVersion: string,
  platform: string = DEFAULT_PLATFORM,
): Promise<void> {
  const { transport, paths } = ctx;
  const profileDir = paths.hostProfileDir(platform);
  const profileNm = paths.hostProfileNodeModules(platform);
  const profileManifest = paths.hostProfileManifest(platform);
  const dshNm = `${paths.dshDir(dshVersion)}/node_modules`;
  const exists = await transport.exec(
    `test -f ${quote(profileManifest)} && echo EXISTS || true`,
    { allowNonZeroExit: true },
  );
  const script = [
    `mkdir -p ${quote(profileNm)}`,
    // @deepseek-ai 整目录：cordis 与全部 dsh-* peer 一次闭环
    `[ -d ${quote(`${dshNm}/@deepseek-ai`)} ] && ln -sfn ${quote(`${dshNm}/@deepseek-ai`)} ${quote(`${profileNm}/@deepseek-ai`)}`,
    `[ -d ${quote(`${dshNm}/cpu-features`)} ] && ln -sfn ${quote(`${dshNm}/cpu-features`)} ${quote(`${profileNm}/cpu-features`)}`,
    `[ -d ${quote(`${dshNm}/nan`)} ] && ln -sfn ${quote(`${dshNm}/nan`)} ${quote(`${profileNm}/nan`)}`,
    'true',
  ].join('\n');
  await transport.exec(script, { allowNonZeroExit: true });
  if (!exists.stdout.includes('EXISTS')) {
    await writePluginStoreManifest(transportIo(transport), paths, {
      name: `dsh-remote-explorer-${platform}`,
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: [] } },
    }, platform);
  }
}

/**
 * 读 host profile manifest；缺失/损坏时返回空清单。
 *
 * @param io - manifest IO
 * @param paths - 远端路径集合
 * @param platform - 平台 profile 名（默认 web）
 * @returns manifest 结构
 */
export async function readPluginStoreManifest(
  io: ManifestIo,
  paths: RemotePaths,
  platform: string = DEFAULT_PLATFORM,
): Promise<PluginStoreManifest> {
  const result = await io.exec(`cat ${quote(paths.hostProfileManifest(platform))} 2>/dev/null || true`, {
    allowNonZeroExit: true,
  });
  try {
    return JSON.parse(result.stdout) as PluginStoreManifest;
  } catch {
    return { dependencies: {}, dsh: { profile: { bundles: [] } } };
  }
}

/**
 * 写 host profile manifest。
 *
 * @param io - manifest IO
 * @param paths - 远端路径集合
 * @param manifest - 新清单
 * @param platform - 平台 profile 名（默认 web）
 */
export async function writePluginStoreManifest(
  io: ManifestIo,
  paths: RemotePaths,
  manifest: PluginStoreManifest,
  platform: string = DEFAULT_PLATFORM,
): Promise<void> {
  await io.writeFile(paths.hostProfileManifest(platform), `${JSON.stringify(manifest, undefined, 2)}\n`);
}

/**
 * 会话 profile 接入主机级 profile：整体 symlink（幂等）。
 *
 * 会话 `$DSH_HOME/profiles/<platform>` → `base/profiles/<platform>`。
 * dsh 启动时 `--profile web` 在此找到 symlink，指向主机级共享安装。
 *
 * 老会话遗留的真实 profile 目录直接替换为 symlink。
 *
 * @param ctx - 远端执行上下文
 * @param sessionId - 会话 id
 * @param platform - 平台 profile 名（默认 web）
 */
export async function attachSessionProfile(
  ctx: RemoteContext,
  sessionId: string,
  platform: string = DEFAULT_PLATFORM,
): Promise<void> {
  const { transport, paths } = ctx;
  const sessionProfileDir = paths.sessionProfile(sessionId);
  const hostProfileDir = paths.hostProfileDir(platform);
  // sessionProfile 的父目录可能不存在（首次连接）
  const parentDir = sessionProfileDir.substring(0, sessionProfileDir.lastIndexOf('/'));
  const script = [
    `mkdir -p ${quote(parentDir)}`,
    `if [ -L ${quote(sessionProfileDir)} ]; then :;`,
    `elif [ -d ${quote(sessionProfileDir)} ]; then rm -rf ${quote(sessionProfileDir)} && ln -s ${quote(hostProfileDir)} ${quote(sessionProfileDir)};`,
    `else ln -s ${quote(hostProfileDir)} ${quote(sessionProfileDir)};`,
    'fi',
  ].join('\n');
  await transport.exec(script, { allowNonZeroExit: true });
}

/**
 * profile 模板（web）自带的 base bundles——不属于插件管理范围，
 * 合并进 manifest 时必须保留（丢了远端 dsh 起不来：无 webserver）。
 */
export const TEMPLATE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'];

/** host profile node_modules 里由回退链接占据的名字（不是插件，扫描时排除） */
const FALLBACK_LINK_NAMES = new Set(['@deepseek-ai', 'cpu-features', 'nan']);

/**
 * 同步 host profile manifest 的 deps/bundles 与实际 node_modules 状态。
 *
 * host profile 是唯一真源（session profile 只是 symlink），不再需要双向同步。
 * 本函数只做自愈：nm 中存在但 manifest 未声明的包收编进 deps；manifest 中
 * 声明但 nm 中已不存在的包从 deps 中移除。bundles 同理。
 *
 * @param io - manifest IO
 * @param paths - 远端路径集合
 * @param platform - 平台 profile 名（默认 web）
 * @returns 是否实际改写（false = 已一致）
 */
export async function syncHostProfileManifest(
  io: ManifestIo,
  paths: RemotePaths,
  platform: string = DEFAULT_PLATFORM,
): Promise<boolean> {
  const manifest = await readPluginStoreManifest(io, paths, platform);
  const deps = { ...(manifest.dependencies ?? {}) };
  const profileNm = paths.hostProfileNodeModules(platform);

  // 扫描 nm 中真实存在的包目录
  const scanned = await io.exec(
    `cd ${quote(profileNm)} 2>/dev/null && for d in */ @*/*/; do [ -f "$d/package.json" ] && echo "$d"; done || true`,
    { allowNonZeroExit: true },
  );
  let changed = false;
  const scannedNames = new Set<string>();
  for (const line of scanned.stdout.split('\n')) {
    const name = line.trim().replace(/\/$/, '');
    if (name === '' || FALLBACK_LINK_NAMES.has(name) || name.startsWith('@deepseek-ai/')
      || name === HANDOFF_PKG_NAME) continue;
    scannedNames.add(name);
    if (deps[name] === undefined) {
      deps[name] = '*';
      changed = true;
    }
  }
  // 回收：nm 中已不存在的包从 deps 中移除
  for (const name of Object.keys(deps)) {
    if (!scannedNames.has(name)) {
      delete deps[name];
      changed = true;
    }
  }
  // bundles 自愈：nm 中存在且有 bundle patch 的包应在 bundles 中
  const bundles = [...(manifest.dsh?.profile?.bundles ?? [])];
  // 注意：bundles 的增删由 install/remove/toggle 操作负责，这里只做一致性校验
  // 不移除 bundles 中的项（可能是停用但未卸载的插件）
  if (changed) {
    await writePluginStoreManifest(io, paths, {
      ...manifest,
      dependencies: deps,
      dsh: { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles } },
    }, platform);
  }
  return changed;
}

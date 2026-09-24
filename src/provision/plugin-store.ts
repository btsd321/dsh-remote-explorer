/**
 * @file 远端插件仓库（plugin store，host × 远程 OS 用户级）
 * @description 对标 VS Code `~/.vscode-server/extensions/`：插件真源在本工具
 *              远端根的 `plugins/`（pnpm 真目录 + manifest），**该远程账号的所有
 *              会话共享一份安装**——会话 profile 不持有任何包副本。
 *
 * 会话接入机制（用户拍板：整体 symlink）：会话 profile 的 `node_modules`
 * 是指向 store node_modules 的**整体 symlink**。dsh 的 bundle 解析从 profile
 * 锚命中 symlink；peer 裸导入的 Node 父 walk 落在 store 内，由 store 的三条
 * 回退链接（`@deepseek-ai/` 整目录、`cpu-features`、`nan` → dsh 安装树）闭环——
 * 等价于 dsh 自己在 `$DSH_HOME/profiles/node_modules` 做的安装回退链接。
 *
 * 生效语义（用户拍板：Reload 语义，不自动重启远端）：
 * - store 写操作后**本机自己的活会话**立即合并 manifest（dsh hmr 热加载/卸载
 *   bundle 层，比 VS Code 的 Reload Required 更热）
 * - **其他用户的活会话**在其下次连接时合并（最后写赢）
 * - hmr 不可用的老远端 dsh 回退为「重连/重启后生效」，UI 文案兜底
 *
 * 并发模型对标 VS Code「单管理进程」+ 我们的多本机现实：pnpm 对同目录 install
 * 自带锁序列化；跨工具写 store 的临界区另有 flock（install-lock.ts）可套。
 * 多个远端 dsh 进程只读 store，无竞态。
 */

import { quote } from '../util/shell-quote.js';
import { writeRemoteTextFile } from '../transport/write-text.js';
import { HANDOFF_PKG_NAME } from '../handoff/protocol.js';
import type { RemoteContext } from './remote-context.js';
import type { RemotePaths } from './remote-paths.js';
import type { RemoteTransport } from '../transport/types.js';

/**
 * manifest 读写所需的最小 IO：监督器用会话的窄委托（exec/writeRemoteFile），
 * 引导路径用传输本体——同一套 store 逻辑两处复用，且 provision 层不 import 编排层。
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

/** store / 会话 manifest 的本工具关心部分 */
export interface PluginStoreManifest {
  /** 包名（store 初始化清单用；会话 manifest 已有自己的名字） */
  name?: string;
  private?: boolean;
  dependencies?: Record<string, string>;
  dsh?: { profile?: { bundles?: string[] } };
}

/**
 * 确保 store 骨架：目录、空清单、三条 peer 回退链接（幂等）。
 *
 * 回退链接目标随 dsh 版本变（升级后重链）；`ln -sfn` 覆盖旧链接。
 *
 * @param ctx - 远端执行上下文
 * @param dshVersion - 当前会话使用的 dsh 版本（回退链接锚定其安装树）
 */
export async function ensurePluginStore(
  ctx: RemoteContext,
  dshVersion: string,
): Promise<void> {
  const { transport, paths } = ctx;
  const storeNm = paths.pluginsStoreNodeModules;
  const dshNm = `${paths.dshDir(dshVersion)}/node_modules`;
  const exists = await transport.exec(
    `test -f ${quote(paths.pluginsStoreManifest)} && echo EXISTS || true`,
    { allowNonZeroExit: true },
  );
  const script = [
    `mkdir -p ${quote(storeNm)}`,
    // @deepseek-ai 整目录：cordis 与全部 dsh-* peer 一次闭环
    `[ -d ${quote(`${dshNm}/@deepseek-ai`)} ] && ln -sfn ${quote(`${dshNm}/@deepseek-ai`)} ${quote(`${storeNm}/@deepseek-ai`)}`,
    `[ -d ${quote(`${dshNm}/cpu-features`)} ] && ln -sfn ${quote(`${dshNm}/cpu-features`)} ${quote(`${storeNm}/cpu-features`)}`,
    `[ -d ${quote(`${dshNm}/nan`)} ] && ln -sfn ${quote(`${dshNm}/nan`)} ${quote(`${storeNm}/nan`)}`,
    'true',
  ].join('\n');
  await transport.exec(script, { allowNonZeroExit: true });
  if (!exists.stdout.includes('EXISTS')) {
    await writePluginStoreManifest(transportIo(transport), paths, {
      name: 'dsh-remote-explorer-plugin-store',
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: [] } },
    });
  }
}

/**
 * 读 store manifest；缺失/损坏时返回空清单（调用方按空 store 处理）。
 *
 * @param transport - 已连接的传输
 * @param paths - 远端路径集合
 * @returns manifest 结构
 */
export async function readPluginStoreManifest(
  io: ManifestIo,
  paths: RemotePaths,
): Promise<PluginStoreManifest> {
  const result = await io.exec(`cat ${quote(paths.pluginsStoreManifest)} 2>/dev/null || true`, {
    allowNonZeroExit: true,
  });
  try {
    return JSON.parse(result.stdout) as PluginStoreManifest;
  } catch {
    return { dependencies: {}, dsh: { profile: { bundles: [] } } };
  }
}

/**
 * 写 store manifest。
 *
 * @param transport - 已连接的传输
 * @param paths - 远端路径集合
 * @param manifest - 新清单
 */
export async function writePluginStoreManifest(
  io: ManifestIo,
  paths: RemotePaths,
  manifest: PluginStoreManifest,
): Promise<void> {
  await io.writeFile(paths.pluginsStoreManifest, `${JSON.stringify(manifest, undefined, 2)}\n`);
}

/**
 * 会话 profile 的 node_modules 接入 store：整体 symlink（幂等）。
 *
 * 老会话遗留的真实 node_modules 目录（功能上线前的会话级副本）直接迁移：
 * 删除后改 symlink——其中的 handoff 与插件副本都已升格 store，无需保留。
 *
 * @param ctx - 远端执行上下文
 * @param sessionId - 会话 id
 */
export async function attachSessionNodeModules(
  ctx: RemoteContext,
  sessionId: string,
): Promise<void> {
  const { transport, paths } = ctx;
  const profileDir = paths.sessionProfile(sessionId);
  const profileNm = `${profileDir}/node_modules`;
  const storeNm = paths.pluginsStoreNodeModules;
  const script = [
    `if [ -L ${quote(profileNm)} ]; then :;`,
    `elif [ -d ${quote(profileNm)} ]; then rm -rf ${quote(profileNm)} && ln -s ${quote(storeNm)} ${quote(profileNm)};`,
    `else ln -s ${quote(storeNm)} ${quote(profileNm)};`,
    'fi',
  ].join('\n');
  await transport.exec(script, { allowNonZeroExit: true });
  // 远端窗口原生插件 UI 在 profile 目录跑 pnpm：node_modules 是指向 store 的
  // symlink 时，pnpm 按 profile 根算出的默认 virtual store（profile 下 .pnpm）
  // 与穿过 symlink 的实际位置（store 下 .pnpm）不符，报
  // ERR_PNPM_UNEXPECTED_VIRTUAL_STORE。用 .npmrc 把 virtual store 钉到 store
  // 的那一份，两个表面的 pnpm 共用同一虚拟存储（实测报错后补）
  await writeRemoteTextFile(
    transport,
    `${profileDir}/.npmrc`,
    `virtual-store-dir=${storeNm}/.pnpm\n`,
    { tolerant: true },
  );
}

/**
 * profile 模板（web）自带的 base bundles——不属于 store 管理范围，
 * 合并进会话 manifest 时必须保留（丢了远端 dsh 起不来：无 webserver）。
 */
export const TEMPLATE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'];

/** store node_modules 里由回退链接占据的名字（不是插件，扫描时排除） */
const FALLBACK_LINK_NAMES = new Set(['@deepseek-ai', 'cpu-features', 'nan']);

/**
 * 把 store 的 dependencies/bundles 合并进会话 manifest（真源在 store）。
 *
 * 会话 manifest 是 dsh hmr 的 watch 对象——改写即热加载/卸载 bundle 层，
 * 这是「本机活会话立即生效」的实现点。内容无变化时不写（避免无谓 hmr 触发）。
 *
 * 三条自愈/保留规则：
 * - store deps 从 store node_modules 扫描自愈——远端窗口原生 UI 的 pnpm 安装
 *   落在 store（session nm 是 symlink），其 manifest 写入只到会话层，这里收编
 * - store bundles 从会话 manifest 收编「store nm 中真实存在」的项——远端原生 UI
 *   启用插件只写会话 bundles，不收编则下次 sync 覆盖会话 bundles 时会把它关掉
 *   （面板列表也会显示未启用）；只增不删，handoff/TEMPLATE 不在扫描集内不受影响
 * - 会话 bundles = store bundles ∪ 模板 base bundles（base/web-app 永不被覆盖）
 *
 * @param io - manifest IO
 * @param paths - 远端路径集合
 * @param sessionId - 会话 id
 * @returns 是否实际改写（false = 已一致）
 */
export async function syncSessionManifest(
  io: ManifestIo,
  paths: RemotePaths,
  sessionId: string,
): Promise<boolean> {
  const store = await readPluginStoreManifest(io, paths);
  const storeDeps = { ...(store.dependencies ?? {}) };
  // 自愈：store nm 里真实存在的包目录（排除回退链接）收编进 deps
  const scanned = await io.exec(
    `cd ${quote(paths.pluginsStoreNodeModules)} 2>/dev/null && for d in */ @*/*/; do [ -f "$d/package.json" ] && echo "$d"; done || true`,
    { allowNonZeroExit: true },
  );
  let storeChanged = false;
  const scannedNames = new Set<string>();
  for (const line of scanned.stdout.split('\n')) {
    const name = line.trim().replace(/\/$/, '');
    // 回退链接占据的名字、@deepseek-ai 命名空间（整目录链到 dsh 树，扫进来
    // 会把 dsh 自家包全收编成「插件」）、以及直落盘的 handoff 合成包（不经
    // pnpm，收编进 deps 会让 pnpm 去 registry 找它或报 linked-dir 错）都跳过
    if (name === '' || FALLBACK_LINK_NAMES.has(name) || name.startsWith('@deepseek-ai/')
      || name === HANDOFF_PKG_NAME) continue;
    scannedNames.add(name);
    if (storeDeps[name] === undefined) {
      storeDeps[name] = '*';
      storeChanged = true;
    }
  }
  // 自愈回收：版本为 '*' 的收编项若已不在 store nm（卸载残留）则清除
  for (const [name, spec] of Object.entries(storeDeps)) {
    if (spec === '*' && !scannedNames.has(name)) {
      delete storeDeps[name];
      storeChanged = true;
    }
  }
  // 读会话 manifest 提前到 store 写回之前：bundles 收编依赖它的现状
  const sessionManifestPath = `${paths.sessionProfile(sessionId)}/package.json`;
  const sessionRaw = await io.exec(`cat ${quote(sessionManifestPath)}`, {
    allowNonZeroExit: true,
  });
  let session: PluginStoreManifest;
  try {
    session = JSON.parse(sessionRaw.stdout) as PluginStoreManifest;
  } catch {
    session = {};
  }
  // 自愈收编 bundles：远端窗口原生 UI 装/启插件只写**会话** manifest 的 bundles，
  // 若不收编进 store，下次 sync 会用 store bundles 整体覆盖会话 bundles，把原生 UI
  // 启用的插件（含外观类）关掉、且面板列表显示为未启用。收编条件 = 在会话 bundles
  // 里且 store nm 中真实存在（scannedNames）；只增不删——handoff 与 TEMPLATE 不在
  // scannedNames 内，收编碰不到它们，不会误删既有 bundles
  const storeBundlesList = [...(store.dsh?.profile?.bundles ?? [])];
  for (const name of session.dsh?.profile?.bundles ?? []) {
    if (TEMPLATE_BUNDLES.includes(name) || storeBundlesList.includes(name)) continue;
    if (!scannedNames.has(name)) continue;
    storeBundlesList.push(name);
    storeChanged = true;
  }
  if (storeChanged) {
    await writePluginStoreManifest(io, paths, {
      ...store,
      dependencies: storeDeps,
      dsh: { ...store.dsh, profile: { ...store.dsh?.profile, bundles: storeBundlesList } },
    });
  }
  const storeBundles = [
    ...TEMPLATE_BUNDLES,
    ...storeBundlesList.filter(name => !TEMPLATE_BUNDLES.includes(name)),
  ];
  const sameDeps = JSON.stringify(session.dependencies ?? {}) === JSON.stringify(storeDeps);
  const sameBundles = JSON.stringify(session.dsh?.profile?.bundles ?? []) === JSON.stringify(storeBundles);
  if (sameDeps && sameBundles) return false;
  const next: PluginStoreManifest = {
    ...session,
    dependencies: { ...storeDeps },
    dsh: { ...session.dsh, profile: { ...session.dsh?.profile, bundles: [...storeBundles] } },
  };
  await io.writeFile(sessionManifestPath, `${JSON.stringify(next, undefined, 2)}\n`);
  return true;
}

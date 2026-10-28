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

import { toErrorMessage } from '../util/errors.js';
import { createLogger } from '../util/logger.js';
import { quote } from '../util/shell-quote.js';
import { writeRemoteTextFile } from '../transport/write-text.js';
import { HANDOFF_PKG_NAME } from '../handoff/protocol.js';
import type { ExecOptions, ExecResult, RemoteTransport } from '../transport/types.js';
import type { RemoteContext } from './remote-context.js';
import type { RemotePaths } from './remote-paths.js';

const log = createLogger('plugin-store');

/**
 * 锁文件收敛超时（毫秒）。
 *
 * lockfile-only 只做图收敛、不下载；但会话打开不该被网络卡太久——超过这个
 * 时限就回滚 manifest、下次连接再试，宁可晚一次清理也不拖慢打开。
 */
const LOCKFILE_REALIGN_TIMEOUT_MS = 60_000;

/**
 * manifest 读写所需的最小 IO：监督器用会话的窄委托（exec/writeRemoteFile），
 * 引导路径用传输本体——同一套逻辑两处复用，且 provision 层不 import 编排层。
 */
export interface ManifestIo {
  /** 远端执行（自愈需要退出码判断锁文件收敛是否成功，不能只取 stdout） */
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
  /** 写远端文本文件 */
  writeFile(path: string, content: string): Promise<void>;
}

/**
 * 把传输适配成 ManifestIo。
 *
 * @param transport - 已连接的传输
 * @param options - 额外执行选项；`pathPrefix` 用于让自愈里的 pnpm 收敛命令
 *                  找到管理目录下的 node/pnpm（远端 PATH 不保证有）
 * @returns IO 适配器
 */
export function transportIo(
  transport: RemoteTransport,
  options: { pathPrefix?: string } = {},
): ManifestIo {
  return {
    exec: (command, execOptions) => transport.exec(command, {
      ...execOptions,
      ...(options.pathPrefix !== undefined ? { pathPrefix: options.pathPrefix } : {}),
    }),
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
  const dshNm = `${paths.dshDir}/node_modules`;
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

/** host profile node_modules 里由回退链接占据的名字（不是插件，扫描时排除） */
const FALLBACK_LINK_NAMES = new Set(['@deepseek-ai', 'cpu-features', 'nan']);

/** 扫描脚本的分段标记：整行匹配，包名不可能等于这些固定串 */
const SCAN_PLUGINS_MARKER = '__DSH_REMOTE_EXPLORER_PLUGINS__';
const SCAN_ALL_MARKER = '__DSH_REMOTE_EXPLORER_ALL__';

/** host profile 顶层 node_modules 扫描结果（自愈计划的输入） */
export interface HostProfileScan {
  /** 顶层包名；已排除回退链接、`@deepseek-ai/*` 与交接合成包 */
  packages: ReadonlySet<string>;
  /** 其中带 `dsh` 元数据（可作插件加载）的包 → 已安装版本 */
  plugins: ReadonlyMap<string, string>;
}

/** manifest dependencies 自愈计划 */
export interface HostProfileManifestPlan {
  /** 计划写入的 dependencies */
  dependencies: Record<string, string>;
  /** 是否与输入不同（需要写回） */
  changed: boolean;
}

/**
 * 本工具是否接管某个 node_modules 条目。
 *
 * 回退链接（`@deepseek-ai/`、`cpu-features`、`nan`）是 dsh 安装树的投影，
 * 交接合成包不经 pnpm——三者都不该被写进 dependencies。
 *
 * @param name - 顶层 node_modules 包名
 * @returns true = 可写进 manifest
 */
function isManagedPackageName(name: string): boolean {
  if (name === '' || FALLBACK_LINK_NAMES.has(name)) return false;
  if (name.startsWith('@deepseek-ai/')) return false;
  return name !== HANDOFF_PKG_NAME;
}

/**
 * 扫描脚本（node 一侧的纯 JS 文本，刻意只用双引号——整体经 `quote()` 单引号
 * 字面量化后原样交给 `node -e`）。
 *
 * 用 node 而不是 shell + grep 读 package.json：`dsh` 字段可能跨行，grep 会
 * 把真插件误判成“非插件”，而这一步误判的代价是把插件依赖当污染删掉。
 * 输出两段：真插件（名字 + 已装版本）与全部顶层包名。
 */
const SCAN_SCRIPT = [
  'const fs=require("node:fs"),path=require("node:path");',
  'const nm=process.argv[1];',
  'const names=[];',
  'for(const e of fs.readdirSync(nm)){',
  '  if(e.startsWith("."))continue;',
  '  if(e.startsWith("@")){',
  '    let subs=[];try{subs=fs.readdirSync(path.join(nm,e));}catch(err){continue;}',
  '    for(const s of subs)names.push(e+"/"+s);',
  '  }else names.push(e);',
  '}',
  `process.stdout.write("${SCAN_PLUGINS_MARKER}\\n");`,
  'for(const n of names){',
  '  let j;try{j=JSON.parse(fs.readFileSync(path.join(nm,n,"package.json"),"utf8"));}catch(err){continue;}',
  '  if(!j||!j.dsh)continue;',
  '  process.stdout.write(n+"\\t"+(typeof j.version==="string"?j.version:"")+"\\n");',
  '}',
  `process.stdout.write("${SCAN_ALL_MARKER}\\n");`,
  'for(const n of names)process.stdout.write(n+"\\n");',
].join('\n');

/**
 * 构造 host profile 顶层 node_modules 扫描命令。
 *
 * profile 用 `nodeLinker: hoisted`，**传递依赖也摊在顶层**——「有 package.json
 * 就算插件」会把整棵依赖树收编进 manifest（历史 bug：插件市场把它们列成已安装
 * 插件），所以插件判定必须看包自己的 `dsh` 元数据。
 *
 * @param profileNodeModules - profile 的 node_modules 绝对路径
 * @returns shell 命令（node 由调用方 `pathPrefix` 提供；node 不可用时整条命令
 *          非零退出，调用方会放弃本次自愈而不是清空依赖）
 */
function buildScanCommand(profileNodeModules: string): string {
  return `node -e ${quote(SCAN_SCRIPT)} ${quote(profileNodeModules)}`;
}

/**
 * 解析 {@link buildScanCommand} 的输出（纯函数）。
 *
 * @param stdout - 扫描脚本输出
 * @returns 扫描结果（自动剔除本工具不接管的条目）
 */
export function parseHostProfileScan(stdout: string): HostProfileScan {
  const packages = new Set<string>();
  const plugins = new Map<string, string>();
  let section: 'plugins' | 'all' | undefined;
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    if (line === SCAN_PLUGINS_MARKER) {
      section = 'plugins';
      continue;
    }
    if (line === SCAN_ALL_MARKER) {
      section = 'all';
      continue;
    }
    if (section === 'all') {
      const name = line.replace(/\/$/, '');
      if (isManagedPackageName(name)) packages.add(name);
      continue;
    }
    if (section !== 'plugins') continue;
    const [name = '', version = ''] = line.split('\t');
    const normalized = name.replace(/\/$/, '');
    if (!isManagedPackageName(normalized)) continue;
    if (version.trim() !== '') plugins.set(normalized, version.trim());
  }
  return { packages, plugins };
}

/**
 * 把已安装版本转成直接依赖 spec。
 *
 * 只接受 `x.y.z...` 形态（含预发布），否则返回 undefined——不猜 git/file 规格。
 *
 * @param version - 包 package.json 的 version
 * @returns `^x.y.z` 或 undefined
 */
function versionRange(version: string): string | undefined {
  const trimmed = version.trim();
  // 严格整串匹配（含预发布/构建元数据）：宁可放弃收编，也不写一个 pnpm 解析
  // 不了的 spec 进 manifest
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(trimmed)) return undefined;
  return `^${trimmed}`;
}

/**
 * 计算 manifest dependencies 的自愈结果（纯函数，便于单测钉住“不收编传递依赖”）。
 *
 * 三类变化：
 * 1. **回收**：声明了但 node_modules 里已不存在的条目删除。
 * 2. **清理历史污染**：旧版本自愈把 hoisted 传递依赖收编进 deps（插件市场
 *    因此把它们列成“已安装插件”，且 `*` 会随 pnpm 更新漂移）。**非插件依赖
 *    （无 `dsh` 元数据）一律删除**——无论 spec 是 `*` 还是后来被 dshmarket
 *    的 update 改写成的具体版本，都是同一批收编产物；真插件被收编成 `*`
 *    的改成 `^<已装版本>`。profile 模板初始 `dependencies: {}`，dsh 插件
 *    管理只会把插件包写进来，所以“非插件直接依赖”本身就是异常状态。
 * 3. **收编插件**：node_modules 里有 `dsh` 元数据、manifest 未声明的包装回
 *    deps，spec 用 `^<已装版本>`（不用 `*`，避免版本漂移）。
 *
 * 不碰 bundles：启用/停用由 install/remove/toggle 操作负责，这里只做
 * dependencies 的一致性校验。
 *
 * @param input - 现有 dependencies 与 node_modules 扫描结果
 * @returns 自愈计划
 */
export function planHostProfileManifestSync(input: {
  dependencies: Record<string, string>;
  scan: HostProfileScan;
}): HostProfileManifestPlan {
  const deps: Record<string, string> = {};
  let changed = false;
  for (const [name, spec] of Object.entries(input.dependencies)) {
    // 1. nm 里已不存在的包：从 deps 回收
    if (!input.scan.packages.has(name)) {
      changed = true;
      continue;
    }
    // 2. 非插件直接依赖：历史「收编 hoisted 传递依赖」的产物，一律清理
    const version = input.scan.plugins.get(name);
    if (version === undefined) {
      changed = true;
      continue;
    }
    // 3. 插件的 `*` 收编产物改钉已装版本；其余 spec 原样保留，不引入漂移
    if (spec === '*') {
      const pinned = versionRange(version);
      if (pinned !== undefined) {
        deps[name] = pinned;
        changed = true;
        continue;
      }
    }
    deps[name] = spec;
  }
  // 3. 真插件但 manifest 未声明：按已装版本收编（不用 `*`）
  for (const [name, version] of input.scan.plugins) {
    if (deps[name] !== undefined) continue;
    const pinned = versionRange(version);
    if (pinned === undefined) continue;
    deps[name] = pinned;
    changed = true;
  }
  return { dependencies: deps, changed };
}

/**
 * 同步 host profile manifest 的 dependencies 与实际 node_modules 状态。
 *
 * host profile 是唯一真源（session profile 只是 symlink），不再需要双向同步。
 * 本函数只做自愈：nm 里已不存在的依赖回收、历史 `*` 收编产物清理、真插件按
 * 已装版本收编——**绝不把 hoisted 传递依赖写进 deps**（那会让插件市场把它们
 * 当成已安装插件）。
 *
 * manifest 一旦变化，锁文件必须同步收敛：pnpm 的 `--frozen-lockfile` 修复路径
 * 会因“锁文件与 manifest 的 specifier 对不上”直接拒绝（dshmarket #808 记录过
 * 这个状态）。收敛失败就回滚 manifest，宁可保留旧状态，也不制造不一致。
 *
 * @param io - manifest IO（需要能运行 pnpm：调用方经 transportIo 传 node bin 前缀）
 * @param paths - 远端路径集合
 * @param platform - 平台 profile 名（默认 web）
 * @returns 是否实际改写（false = 已一致，或收敛失败已回滚）
 */
export async function syncHostProfileManifest(
  io: ManifestIo,
  paths: RemotePaths,
  platform: string = DEFAULT_PLATFORM,
): Promise<boolean> {
  try {
    return await syncHostProfileManifestInner(io, paths, platform);
  } catch (error) {
    // 自愈是辅助动作：任何 IO/传输异常都不该让会话打不开，降级为下次重连再试
    log.warn('profile manifest 自愈异常（不影响会话）', {
      platform,
      detail: toErrorMessage(error),
    });
    return false;
  }
}

/**
 * {@link syncHostProfileManifest} 的实现主体（异常由外层兜底）。
 *
 * @param io - manifest IO
 * @param paths - 远端路径集合
 * @param platform - 平台 profile 名
 * @returns 是否实际改写
 */
async function syncHostProfileManifestInner(
  io: ManifestIo,
  paths: RemotePaths,
  platform: string,
): Promise<boolean> {
  const profileDir = paths.hostProfileDir(platform);
  const manifestPath = paths.hostProfileManifest(platform);

  // 1. 读原始文本（回滚要原样恢复）并解析；缺失/损坏时不在自愈里猜内容
  const raw = await io.exec(`cat ${quote(manifestPath)} 2>/dev/null || true`, { allowNonZeroExit: true });
  let manifest: PluginStoreManifest;
  try {
    manifest = JSON.parse(raw.stdout) as PluginStoreManifest;
  } catch {
    log.debug('profile manifest 缺失或无法解析，跳过自愈', { platform });
    return false;
  }

  // 2. 扫描 nm 并计算计划。扫描失败/输出被截断时**必须放弃**：空扫描结果会
  //    让“回收”把所有依赖删光，比不自愈危险得多。
  const scanned = await io.exec(
    buildScanCommand(paths.hostProfileNodeModules(platform)),
    { allowNonZeroExit: true },
  );
  if (scanned.exitCode !== 0 || !scanned.stdout.includes(SCAN_ALL_MARKER)) {
    log.warn('profile node_modules 扫描失败，跳过本次 manifest 自愈', {
      platform,
      detail: scanned.stderr.trim().slice(-300) || `exit=${scanned.exitCode ?? 'signal'}`,
    });
    return false;
  }
  const plan = planHostProfileManifestSync({
    dependencies: manifest.dependencies ?? {},
    scan: parseHostProfileScan(scanned.stdout),
  });
  if (!plan.changed) return false;

  // 3. 写回 manifest
  await writePluginStoreManifest(io, paths, { ...manifest, dependencies: plan.dependencies }, platform);

  // 4. 有锁文件就必须收敛（pnpm 路径由调用方的 pathPrefix 提供）
  const lockFile = `${profileDir}/pnpm-lock.yaml`;
  const lockProbe = await io.exec(
    `test -f ${quote(lockFile)} && echo YES || true`,
    { allowNonZeroExit: true },
  );
  if (!lockProbe.stdout.includes('YES')) return true;

  const realign = await io.exec(
    `cd ${quote(profileDir)} && pnpm install --lockfile-only --prefer-offline --no-frozen-lockfile`,
    { allowNonZeroExit: true, timeoutMs: LOCKFILE_REALIGN_TIMEOUT_MS },
  );
  if (realign.exitCode === 0) {
    log.info('profile manifest 已自愈并收敛锁文件', {
      platform,
      dependencies: Object.keys(plan.dependencies).length,
    });
    return true;
  }

  // 5. 收敛失败：恢复原始 manifest，避免留下“manifest 与锁文件对不上”的状态
  const detail = realign.stderr.trim().slice(-500) || `exit=${realign.exitCode ?? 'signal'}`;
  log.warn('profile manifest 自愈后锁文件收敛失败，已回滚 manifest', { platform, detail });
  await io.writeFile(manifestPath, raw.stdout);
  return false;
}

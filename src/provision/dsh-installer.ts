/**
 * @file 远端 dsh 安装
 * @description 在远端用 npm 安装 `@deepseek-ai/dsh` 到版本隔离的目录。
 *
 * 主路径是**远端自装**（决策 3）：远端自己 `npm install`，装前由
 * {@link selectMirror} 测出最快的 registry。本地打包上传作为显式可选回退
 * （`--upload-fallback`，默认关闭），因为完全离线的远端是真实存在的场景——
 * Zed 与 VS Code 都保留了这条回退路径。
 *
 * 三个必须显式处理的点（1、2 为 P0 实测，3 为隔离要求）：
 *
 * 1. **版本号必须显式指定。** `@deepseek-ai/dsh` 的 dist-tags 是
 *    `latest: 0.1.5-rc.2`、`rc: 0.1.7-rc.2`——装 `latest` 会拿到比
 *    预期更旧的版本，不能依赖默认标签。（此为 P0 实测的历史结论；
 *    二次实测发现 dist-tag `latest` 持续滞后——`latest` 停在 0.1.7-rc.2
 *    时已发布版本的最大值已是 0.2.0-rc.2，见 lessons 6c——故默认策略
 *    已改为「已发布版本最大值」：未显式指定版本时由
 *    {@link resolveLatestDshVersion} 拉 registry 版本列表取最大，
 *    解析失败由 provisioner 回退兜底地板。显式传版本号或标签
 *    （`--dsh-version 0.2.0-rc.2` / `--dsh-version next`）仍可用，
 *    安装命令里依旧绝不出现标签。）
 * 2. **PATH 必须含 node 的 bin 目录。** npm 自身的 shebang 是
 *    `#!/usr/bin/env node`，不加 PATH 直接报 `env: 'node': No such file or directory`。
 * 3. **npm 缓存必须收进本工具的根目录。** 不设 `npm_config_cache` 时 npm
 *    写远端用户级 `~/.npm`（缓存与 `_logs` 都在里面）——那是远端其他
 *    npm 使用者的共享目录。隔离契约是「本工具在远端的一切落盘都在
 *    `~/.dsh-remote-explorer/btsd321/` 内、完全不触碰远端 `~/.dsh` 与 `~/.npm`」，
 *    对标 VS Code 的 `~/.vscode-server` 单根自治模型。
 */

import { RemoteError, toErrorMessage } from '../util/errors.js';
import { createLogger } from '../util/logger.js';
import { quote } from '../util/shell-quote.js';
import { INSTALL_LOCK_WAIT_SECONDS, installLockHint, lockInstallCommand } from './install-lock.js';
import type { RemoteContext } from './remote-context.js';
import type { RemotePaths } from './remote-paths.js';
import type { RemoteTransport } from '../transport/types.js';

/** 模块日志器（默认版本解析的关键节点与失败告警） */
const log = createLogger('dsh-installer');

/**
 * 安装超时（毫秒）。
 *
 * P0 实测 490 个包用了 60 秒。给到 15 分钟是为了覆盖慢链路与首次无缓存的情况——
 * 决策 7 已接受首次安装耗时长，这里宁可等也不要中途失败留下半个安装。
 */
const INSTALL_TIMEOUT_MS = 900_000;

/**
 * 远端 npm 元数据查询（`npm view`）超时（毫秒）。
 *
 * 与 plugin/tools.ts 的 KILL_TIMEOUT_MS 同值但语义独立、各自演化：
 * 那边是杀远端进程的宽限期，这边是慢链路下 registry 元数据查询的上限。
 */
const NPM_TIMEOUT_MS = 120_000;

/** dsh 安装结果 */
export interface DshInstallResult {
  /** 安装的版本 */
  version: string;
  /** dsh 可执行入口绝对路径 */
  dshBin: string;
  /** 安装目录绝对路径 */
  installDir: string;
  /** 是否复用了已有安装 */
  reused: boolean;
}

/**
 * 确保远端有可用的指定版本 dsh。
 *
 * 已装则复用（执行 `dsh --version` 比对），未装则安装。
 *
 * dsh 装在 `DSH_HOME`（= base）下的 `node_modules`——参考 dsh 官方安装方式：
 * 在 `DSH_HOME` 下 `npm install @deepseek-ai/dsh@<version>`，dsh 入口在
 * `base/node_modules/.bin/dsh`。不再按版本分目录（`versions/dsh-<ver>/`）。
 *
 * @param ctx - 远端执行上下文
 * @param options - 安装选项
 * @returns 安装结果
 * @throws RemoteError('EXEC_FAILED') 安装失败或装后版本不符
 */
export async function ensureDsh(
  ctx: RemoteContext,
  options: {
    /** 目标 dsh 版本，如 `0.1.7-rc.2` */
    version: string;
    /** npm registry baseUrl */
    registryUrl: string;
    /** node bin 目录，会加进 PATH */
    nodeBinDir: string;
    /** 取消信号 */
    signal?: AbortSignal;
    /** 阶段进度回调 */
    onProgress?: (message: string) => void;
  },
): Promise<DshInstallResult> {
  const { transport, paths } = ctx;
  const { version, registryUrl, nodeBinDir, signal } = options;
  const installDir = paths.dshDir;
  const dshBin = paths.dshBin;

  // 1. 检查是否已装。用 `dsh --version` 而非文件存在性——
  //    半成品安装（node_modules 不完整）会让文件检查误判为可用
  const existing = await runWithPath(
    transport,
    `${quote(dshBin)} --version 2>/dev/null || true`,
    nodeBinDir,
    { allowNonZeroExit: true, ...(signal ? { signal } : {}) },
  );
  if (existing.stdout.trim() === version) {
    return { version, dshBin, installDir, reused: true };
  }

  // 2. 安装。在 DSH_HOME（base）下放一个占位 package.json，让 npm 把依赖装进本目录
  options.onProgress?.(`安装 dsh ${version}（首次约需 1 分钟）`);
  const placeholder = JSON.stringify({ name: 'dsh-remote-explorer-install', private: true });
  // 整段套 flock：npm 写 base 目录是临界区，多人同远端账号并发引导会写竞态
  const install = lockInstallCommand(paths, [
    `mkdir -p ${quote(installDir)}`,
    `cd ${quote(installDir)}`,
    `printf '%s' ${quote(placeholder)} > package.json`,
    `npm install --registry=${quote(registryUrl)} --no-audit --no-fund ${quote(`@deepseek-ai/dsh@${version}`)}`,
  ].join('\n'));

  try {
    await transport.exec(install, {
      pathPrefix: nodeBinDir,
      env: npmEnv(paths),
      timeoutMs: INSTALL_TIMEOUT_MS + INSTALL_LOCK_WAIT_SECONDS * 1_000,
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    // 安装失败必须清掉目录：留下半个安装会让下次的版本检查行为难以预测。
    // 清目录不套锁：失败方持锁期间执行，与成功方临界区不重叠
    await cleanup(transport, installDir);
    throw new RemoteError(
      'EXEC_FAILED',
      `在主机 ${transport.hostAlias} 上安装 dsh ${version} 失败。`
        + installLockHint(toErrorMessage(error))
        + '若报错形如 V8 内存分配失败或 SIGTRAP，通常是 Node 运行时在该架构上不稳定，'
        + '请用 dsh-remote-explorer doctor 检查 Node 稳定性自检结果',
      { cause: error, hostAlias: transport.hostAlias },
    );
  }

  // 3. 验证装出来的版本
  const verify = await runWithPath(transport, `${quote(dshBin)} --version`, nodeBinDir, {
    ...(signal ? { signal } : {}),
  });
  const actual = verify.stdout.trim();
  if (actual !== version) {
    throw new RemoteError(
      'EXEC_FAILED',
      `主机 ${transport.hostAlias} 上安装的 dsh 版本不符：期望 ${version}，实际 ${actual || '(无输出)'}`,
      { hostAlias: transport.hostAlias },
    );
  }

  return { version, dshBin, installDir, reused: false };
}

// ─── 版本比较（纯函数，默认「最新」策略的判定核心） ────────────────────────

/** semver 解析结果（仅用于优先级比较；build metadata 不参与优先级，不接受） */
interface SemverParts {
  /** 主版本号 */
  major: number;
  /** 次版本号 */
  minor: number;
  /** 补丁版本号 */
  patch: number;
  /** 预发布标识符列表（点分）；空数组表示无预发布（优先级最高） */
  prerelease: readonly string[];
}

/**
 * 官方 semver 语法正则（不含 build metadata）。
 *
 * 候选列表来自 registry 的已发布版本数组，形态干净；不满足严格 semver
 * （v 前缀、缺段、前导零等）的一律按非法条目忽略，不做猜测修复。
 */
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?$/;

/**
 * 解析单个 semver 版本号。
 *
 * @param candidate - 待解析字符串（原样传入，带空白即非法）
 * @returns 解析结果；不满足 semver 语法返回 undefined
 */
function parseSemver(candidate: string): SemverParts | undefined {
  const match = SEMVER_PATTERN.exec(candidate);
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] !== undefined ? match[4].split('.') : [],
  };
}

/**
 * 比较两个预发布标识符（semver 规范第 11 条）。
 *
 * - 纯数字标识符数值比较（`rc.10` > `rc.2`，不走字典序）
 * - 非数字标识符按字典序（ASCII）比较
 * - 纯数字标识符恒小于非数字标识符
 *
 * @param a - 左侧标识符
 * @param b - 右侧标识符
 * @returns 负数表示 a < b，0 相等，正数表示 a > b
 */
function comparePrereleaseIdentifiers(a: string, b: string): number {
  const aIsNumeric = /^\d+$/.test(a);
  const bIsNumeric = /^\d+$/.test(b);
  if (aIsNumeric && bIsNumeric) return Number(a) - Number(b);
  if (aIsNumeric) return -1;
  if (bIsNumeric) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 按 semver 完整优先级比较两个已解析版本。
 *
 * 顺序：major/minor/patch 数值比较 → 无 prerelease 者大 → prerelease
 * 逐标识符比较 → 前缀相同时标识符多者大。build metadata 不参与优先级
 * （semver 规范明文），本模块的解析也不接受它。
 *
 * @param a - 左侧版本
 * @param b - 右侧版本
 * @returns 负数表示 a < b，0 相等，正数表示 a > b
 */
function compareSemver(a: SemverParts, b: SemverParts): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  // 无 prerelease > 有 prerelease（0.2.0 > 0.2.0-rc.2）
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  const shared = Math.min(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < shared; i++) {
    const cmp = comparePrereleaseIdentifiers(a.prerelease[i], b.prerelease[i]);
    if (cmp !== 0) return cmp;
  }
  // 前缀相同：标识符多者大（1.0.0-alpha < 1.0.0-alpha.1）
  return a.prerelease.length - b.prerelease.length;
}

/**
 * 取版本列表中 semver 优先级最大的条目（纯函数，无 IO）。
 *
 * 默认 dsh 版本策略的判定核心：「最新」= 已发布版本的最大值，而非任何
 * dist-tag——`latest` 实测滞后于已发布最大值（见文件头第 1 点）。
 * 非法/无法解析的条目直接忽略，不让一个脏值掀翻整个解析；空输入或
 * 无任何合法条目时返回 undefined，由调用方决定兜底。
 *
 * @param versions - 候选版本列表（通常来自 `npm view ... versions --json`）
 * @returns 最大的版本号；无合法条目时 undefined
 */
export function maxPublishedVersion(versions: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestParts: SemverParts | undefined;
  for (const candidate of versions) {
    const parts = parseSemver(candidate);
    if (parts === undefined) continue;
    if (bestParts === undefined || compareSemver(parts, bestParts) > 0) {
      best = candidate;
      bestParts = parts;
    }
  }
  return best;
}

/**
 * 查询 registry 上某个 dist-tag 对应的具体版本。
 *
 * 供用户显式传标签（`--dsh-version next` 等）的路径使用——解析结果会被
 * 显式传下去，安装命令里绝不出现 dist-tag（见文件头第 1 点）。未显式
 * 指定版本时的默认路径不走标签，见 {@link resolveLatestDshVersion}。
 *
 * @param ctx - 远端执行上下文
 * @param options - 查询选项
 * @returns 具体版本号
 * @throws RemoteError('EXEC_FAILED') 查询失败或标签不存在
 */
export async function resolveDshVersion(
  ctx: RemoteContext,
  options: {
    /** dist-tag，如 `latest` 或 `alpha` */
    tag: string;
    /** npm registry baseUrl */
    registryUrl: string;
    /** node bin 目录 */
    nodeBinDir: string;
    /** 取消信号 */
    signal?: AbortSignal;
  },
): Promise<string> {
  const { transport, paths } = ctx;
  const { tag, registryUrl, nodeBinDir, signal } = options;
  const result = await runWithPath(
    transport,
    `npm view ${quote(`@deepseek-ai/dsh@${tag}`)} version --registry=${quote(registryUrl)} 2>/dev/null || true`,
    nodeBinDir,
    {
      allowNonZeroExit: true,
      timeoutMs: NPM_TIMEOUT_MS,
      env: npmEnv(paths),
      ...(signal ? { signal } : {}),
    },
  );

  // npm view 可能输出多行（同一 tag 命中多个版本时），取最后一行非空值
  const lines = result.stdout.trim().split('\n').map(line => line.trim()).filter(Boolean);
  const version = lines.at(-1);
  if (!version) {
    throw new RemoteError(
      'EXEC_FAILED',
      `无法从 ${registryUrl} 解析 @deepseek-ai/dsh 的 ${tag} 标签对应版本`,
      { hostAlias: transport.hostAlias },
    );
  }
  return version;
}

/**
 * 解析 registry 上「已发布版本的最大值」作为默认 dsh 版本。
 *
 * dist-tag `latest` 实测滞后（见文件头第 1 点），「最新」不能取任何
 * 标签——必须拉全量版本列表自行比较（{@link maxPublishedVersion}）。
 * 执行形态与 {@link resolveDshVersion} 同款：远端 `npm view` + npmEnv
 * 缓存隔离 + `allowNonZeroExit` + 120 秒超时。本函数只抛错，解析失败
 * 后的兜底策略（回退地板、不中断引导）由 provisioner 决定。
 *
 * @param ctx - 远端执行上下文
 * @param options - 解析选项
 * @returns 已发布版本中的最大版本号
 * @throws RemoteError('EXEC_FAILED') 输出无法解析成版本列表、列表为空或无合法版本
 */
export async function resolveLatestDshVersion(
  ctx: RemoteContext,
  options: {
    /** npm registry baseUrl */
    registryUrl: string;
    /** node bin 目录 */
    nodeBinDir: string;
    /** 取消信号 */
    signal?: AbortSignal;
  },
): Promise<string> {
  const { transport, paths } = ctx;
  const { registryUrl, nodeBinDir, signal } = options;
  const result = await runWithPath(
    transport,
    `npm view ${quote('@deepseek-ai/dsh')} versions --json --registry=${quote(registryUrl)} 2>/dev/null || true`,
    nodeBinDir,
    {
      allowNonZeroExit: true,
      timeoutMs: NPM_TIMEOUT_MS,
      env: npmEnv(paths),
      ...(signal ? { signal } : {}),
    },
  );

  const versions = parseVersionListJson(result.stdout);
  const latest = versions === undefined ? undefined : maxPublishedVersion(versions);
  if (versions === undefined || latest === undefined) {
    throw new RemoteError(
      'EXEC_FAILED',
      `远端默认 dsh 版本解析失败：无法从 ${registryUrl} 解析 @deepseek-ai/dsh 的已发布版本列表`
        + '（输出不是合法的 JSON 版本数组、列表为空或无合法版本号）',
      { hostAlias: transport.hostAlias },
    );
  }
  log.info(`dsh 版本解析：最新已发布 ${latest}（候选 ${versions.length} 个）`, {
    hostAlias: transport.hostAlias,
  });
  return latest;
}

/**
 * 带 PATH 执行远端命令。
 *
 * 把「PATH 必须含 node bin」这条约束收口到一处，避免各调用点漏加。
 *
 * @param transport - 已连接的传输
 * @param command - 命令字符串
 * @param nodeBinDir - node bin 目录
 * @param options - 执行选项
 * @returns 执行结果
 */
async function runWithPath(
  transport: RemoteTransport,
  command: string,
  nodeBinDir: string,
  options: Parameters<RemoteTransport['exec']>[1],
): ReturnType<RemoteTransport['exec']> {
  return transport.exec(command, { ...options, pathPrefix: nodeBinDir });
}

/**
 * npm 的隔离环境变量：缓存收进本工具的根目录。
 *
 * 不设置时 npm 写远端用户级 `~/.npm`（缓存与 `_logs` 都在其中），
 * 那是与远端其他 npm 使用者共享的目录——隔离契约要求装机不碰它。
 * `npm_config_cache` 对 install 与 view 一视同仁。
 *
 * @param paths - 远端路径集合
 * @returns 环境变量
 */
function npmEnv(paths: RemotePaths): Record<string, string> {
  return { npm_config_cache: paths.npmCache };
}

/**
 * 解析 `npm view <包> versions --json` 的 stdout 为版本号列表。
 *
 * npm 的 stdout 可能带警告前缀行（registry 提示等）——直接 JSON.parse
 * 失败时，截取首个 `[` 到最后一个 `]` 之间的子串再试一次；两个候选
 * 都不合法则返回 undefined，交由调用方按解析失败上报。
 *
 * @param stdout - 远端命令原始输出
 * @returns 版本号列表；解析不出合法 string[] 时 undefined
 */
function parseVersionListJson(stdout: string): string[] | undefined {
  const text = stdout.trim();
  if (text.length === 0) return undefined;
  const candidates: string[] = [text];
  const firstBracket = text.indexOf('[');
  const lastBracket = text.lastIndexOf(']');
  if (firstBracket >= 0 && lastBracket > firstBracket) {
    candidates.push(text.slice(firstBracket, lastBracket + 1));
  }
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (Array.isArray(parsed) && parsed.every(item => typeof item === 'string')) {
        // every 已保证全部元素是 string，断言仅收窄类型（no-any 纪律下就地断言）
        return parsed as string[];
      }
    } catch { /* 非法 JSON：换下一个候选切片重试 */ }
  }
  return undefined;
}

/**
 * 删除远端目录，失败不抛错。
 *
 * @param transport - 已连接的传输
 * @param dir - 待删目录绝对路径
 */
async function cleanup(transport: RemoteTransport, dir: string): Promise<void> {
  try {
    await transport.exec(`rm -rf ${quote(dir)}`, { allowNonZeroExit: true });
  } catch { /* 清理失败只留下无用目录，不影响错误上报 */ }
}

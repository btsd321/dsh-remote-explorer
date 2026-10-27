/**
 * @file 远端 dsh 安装
 * @description 在远端用 npm 安装 `@deepseek-ai/dsh` 到 `DSH_HOME`（base）下的
 *              `node_modules`——dsh 是**单一安装点**，版本不符或损坏时清空安装树
 *              原地重装，不按版本分目录（与 Node 的多版本隔离相反）。装前由
 *              {@link selectMirror} 测出最快的 registry。
 *
 * 主路径是**远端自装**（决策 3）：远端自己 `npm install`。本地打包上传作为显式
 * 可选回退（`--upload-fallback`，默认关闭），因为完全离线的远端是真实存在的
 * 场景——Zed 与 VS Code 都保留了这条回退路径。
 *
 * 三个必须显式处理的点（1、2 为 P0 实测，3 为隔离要求）：
 *
 * 1. **版本号必须显式指定，默认取「最大稳定版（无则最新 rc）」，且首选装不上时沿候选链退到次新。**
 *    `@deepseek-ai/dsh` 的 dist-tags 是 `latest: 0.1.5-rc.2`、`rc: 0.1.7-rc.2`——装
 *    `latest` 会拿到比预期更旧的版本，不能依赖默认标签。（此为 P0 实测的历史结论；
 *    二次实测发现 dist-tag `latest` 持续滞后——`latest` 停在 0.1.7-rc.2 时已发布
 *    版本的最大值已是 0.2.0-rc.2，见 lessons 6c——故默认策略已改为「最大稳定版」：
 *    未显式指定版本时由 {@link resolveDshCandidates} 拉 registry 版本列表，经
 *    {@link selectDshCandidates} 分层排序（稳定版降序在前、rc 降序在后，
 *    `alpha` 一律不选），首项即首选。首选 npm install 失败或装后版本不符时，
 *    {@link ensureDsh} 沿候选链退到次新，最多尝试 3 个。解析失败由 provisioner
 *    回退兜底地板。显式传版本号或标签（`--dsh-version 0.2.0-rc.2` /
 *    `--dsh-version next`）仍可用，安装命令里依旧绝不出现标签。）
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
import { downloadNpmTarballLocally } from './local-downloader.js';
import { executeDownloadStrategy } from './local-download-strategy.js';
import type { LocalResourceDownloadMode } from './local-download-mode.js';
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

/**
 * 单个引导最多尝试的 dsh 候选数（首选 + 降级）。
 *
 * 每次 npm install 约需 1 分钟，逐个退到很旧版本会让引导退化成分钟级
 * 长尾。取 3：首选 + 两个降级，足以跨过「镜像暂缺某个版本」这类局部
 * 缺口，又不会让引导无限退到远古版本。
 */
const MAX_DSH_INSTALL_CANDIDATES = 3;

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
    /**
     * 有序降级候选（首选在前）。省略或为空时退化为只尝试 `version`。
     * 首选版本装不上（tarball 在镜像上缺失、registry 抖动、装后版本不符）
     * 时沿序列退到次新版本——见 {@link selectDshCandidates}。
     */
    candidates?: readonly string[];
    /** npm registry baseUrl */
    registryUrl: string;
    /** node bin 目录，会加进 PATH */
    nodeBinDir: string;
    /** 本地资源下载模式（远端无网时本机下载 tarball + SFTP 上传 + npm install 本地包） */
    localResourceDownload?: LocalResourceDownloadMode;
    /** 取消信号 */
    signal?: AbortSignal;
    /** 阶段进度回调 */
    onProgress?: (message: string) => void;
  },
): Promise<DshInstallResult> {
  const { transport, paths } = ctx;
  const { version, registryUrl, nodeBinDir, signal } = options;
  const localResourceDownload = options.localResourceDownload;
  const installDir = paths.dshDir;
  const dshBin = paths.dshBin;
  // 降级链：首选在前，最多尝试 {@link MAX_DSH_INSTALL_CANDIDATES} 个；
  // 显式指定版本时只有一项（尊重用户选择，不做降级）。
  const candidates = options.candidates && options.candidates.length > 0
    ? options.candidates.slice(0, MAX_DSH_INSTALL_CANDIDATES)
    : [version];

  let lastError: unknown;
  for (const candidate of candidates) {
    // 1. 该候选是否已装且可用。用 `dsh --version` 而非文件存在性——
    //    半成品安装（node_modules 不完整）会让文件检查误判为可用
    const existing = await runWithPath(
      transport,
      `${quote(dshBin)} --version 2>/dev/null || true`,
      nodeBinDir,
      { allowNonZeroExit: true, ...(signal ? { signal } : {}) },
    );
    if (existing.stdout.trim() === candidate) {
      return { version: candidate, dshBin, installDir, reused: true };
    }

    // 2. 安装。在 DSH_HOME（base）下放一个占位 package.json，让 npm 把依赖装进本目录。
    //    先清空 dsh 安装树再装——dsh 是单一安装点（base/node_modules，只含 dsh
    //    及其依赖树），版本不一致或二进制损坏时，npm 可能因 package.json 已声明
    //    该依赖而跳过实际重装、留下坏包。删除安装树强制 npm 从干净状态重装。
    options.onProgress?.(`安装 dsh ${candidate}（首次约需 1 分钟）`);
    const placeholder = JSON.stringify({ name: 'dsh-remote-explorer-install', private: true });

    // 远端下载安装函数：原行为——npm install 从 registry 下载（远端网络下载 + 安装合一）
    const remoteDownload = async (): Promise<void> => {
      // 整段套 flock：npm 写 base 目录是临界区，多人同远端账号并发引导会写竞态
      const install = lockInstallCommand(paths, [
        buildDshCleanCommand(installDir),
        `mkdir -p ${quote(installDir)}`,
        `cd ${quote(installDir)}`,
        `printf '%s' ${quote(placeholder)} > package.json`,
        `npm install --registry=${quote(registryUrl)} --no-audit --no-fund ${quote(`@deepseek-ai/dsh@${candidate}`)}`,
      ].join('\n'));
      await transport.exec(install, {
        pathPrefix: nodeBinDir,
        env: npmEnv(paths),
        timeoutMs: INSTALL_TIMEOUT_MS + INSTALL_LOCK_WAIT_SECONDS * 1_000,
        ...(signal ? { signal } : {}),
      });
    };

    // 本机下载安装函数：本机下载 tarball → SFTP 上传 → npm install 本地 tarball
    //（远端只需能 npm install 本地包，不需要访问 registry）
    const localDownload = async (): Promise<void> => {
      const tmpDir = paths.tmpDir(process.pid, `dsh-install-${candidate}`);
      const remoteTarball = `${tmpDir}/dsh.tgz`;
      const downloaded = await downloadNpmTarballLocally('@deepseek-ai/dsh', candidate, registryUrl);
      try {
        await transport.exec(`mkdir -p ${quote(tmpDir)}`);
        await transport.uploadFile(downloaded.localPath, remoteTarball, signal);
        // npm install 本地 tarball：不访问 registry（--registry 仍给但不用于本地包），
        // --no-audit --no-fund 与远端安装一致。整段套 flock 同上
        const install = lockInstallCommand(paths, [
          buildDshCleanCommand(installDir),
          `mkdir -p ${quote(installDir)}`,
          `cd ${quote(installDir)}`,
          `printf '%s' ${quote(placeholder)} > package.json`,
          `npm install --no-audit --no-fund ${quote(remoteTarball)}`,
        ].join('\n'));
        await transport.exec(install, {
          pathPrefix: nodeBinDir,
          env: npmEnv(paths),
          timeoutMs: INSTALL_TIMEOUT_MS + INSTALL_LOCK_WAIT_SECONDS * 1_000,
          ...(signal ? { signal } : {}),
        });
      } finally {
        await downloaded.cleanup();
        try {
          await transport.exec(`rm -rf ${quote(tmpDir)}`, { allowNonZeroExit: true });
        } catch { /* 清理失败无妨 */ }
      }
    };

    // 远端临时目录清理函数（auto 回退前调用，清理 npm install 失败留下的半成品）
    const cleanupRemoteTemp = async (): Promise<void> => {
      await cleanupDshTree(transport, paths);
    };

    try {
      // 策略决策：off / always / auto 三种模式的分支编排
      await executeDownloadStrategy({
        localResourceDownload,
        transport,
        resourceName: `dsh ${candidate}`,
        remoteDownload,
        localDownload,
        cleanupRemoteTemp,
      });
    } catch (error) {
      // 装不上就清掉半成品退到下一个候选：留下半个安装会让后续版本检查
      // 行为难以预测。只清 dsh 安装树，绝不碰 base 根目录（见 cleanupDshTree）。
      lastError = error;
      await cleanupDshTree(transport, paths);
      continue;
    }

    // 3. 验证装出来的版本：不符也视为该候选失败，清掉退到下一个候选
    const verify = await runWithPath(transport, `${quote(dshBin)} --version`, nodeBinDir, {
      ...(signal ? { signal } : {}),
    });
    const actual = verify.stdout.trim();
    if (actual !== candidate) {
      lastError = new RemoteError(
        'EXEC_FAILED',
        `主机 ${transport.hostAlias} 上安装的 dsh 版本不符：期望 ${candidate}，实际 ${actual || '(无输出)'}`,
        { hostAlias: transport.hostAlias },
      );
      await cleanupDshTree(transport, paths);
      continue;
    }

    return { version: candidate, dshBin, installDir, reused: false };
  }

  // 所有候选都失败：报最后一个错误，并列出已尝试的候选清单
  const tried = candidates.join('、');
  const hint = installLockHint(toErrorMessage(lastError));
  throw new RemoteError(
    'EXEC_FAILED',
    `在主机 ${transport.hostAlias} 上安装 dsh 失败，已尝试候选：${tried}。`
      + (hint !== undefined ? hint : '')
      + '若报错形如 V8 内存分配失败或 SIGTRAP，通常是 Node 运行时在该架构上不稳定，'
      + '请用 dsh-remote-explorer doctor 检查 Node 稳定性自检结果',
    { cause: lastError, hostAlias: transport.hostAlias },
  );
}

// ─── 版本比较（纯函数，默认「最新」策略的判定核心） ────────────────────────

/** semver 解析结果（仅用于优先级比较；build metadata 不参与优先级，不接受） */
export interface SemverParts {
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
export function parseSemver(candidate: string): SemverParts | undefined {
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
export function compareSemver(a: SemverParts, b: SemverParts): number {
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
 * semver 优先级比较的通用「取最大」原语，与 {@link compareSemver} 同源。
 * 默认 dsh 版本策略的分层排序见 {@link selectDshCandidates}（它按稳定/rc
 * 分层后各自降序，不直接调本函数）。非法/无法解析的条目直接忽略，不让一个
 * 脏值掀翻整个解析；空输入或无任何合法条目时返回 undefined，由调用方决定
 * 兜底。
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
 * 把版本列表整理成「首选在前」的有序降级候选（纯函数，无 IO）。
 *
 * 顺序：所有稳定版按 semver 降序，再接所有 rc 按 semver 降序。
 * 首项就是 {@link selectDefaultDshVersion} 的首选。`alpha`/`beta` 等非 rc
 * 预发布一律不进序列（见 {@link selectDefaultDshVersion} 的策略分层）。
 *
 * 用途：首选版本装不上时（tarball 在镜像上缺失、registry 抖动、装后版本
 * 不符），沿序列退到次新版本，避免「最新发布但装不上」直接卡死引导。
 *
 * semver 优先级判定复用 {@link parseSemver} / {@link compareSemver}（与
 * {@link maxPublishedVersion} 同源）；分层过滤（稳定/rc）与排序只在这里
 * 发生一次。
 *
 * @param versions - 候选版本列表（通常来自 `npm view ... versions --json`）
 * @returns 有序候选序列（首项为首选）；无可用候选时空数组
 */
export function selectDshCandidates(versions: readonly string[]): string[] {
  const parsed: Array<{ raw: string; parts: SemverParts }> = [];
  for (const candidate of versions) {
    const parts = parseSemver(candidate);
    if (parts === undefined) continue;
    parsed.push({ raw: candidate, parts });
  }

  // 按层取降序：稳定版一层、rc 一层（alpha/beta 两层都不进）
  const byTier = (keep: (parts: SemverParts) => boolean): string[] => {
    const tier = parsed.filter(item => keep(item.parts));
    tier.sort((a, b) => compareSemver(b.parts, a.parts));
    return tier.map(item => item.raw);
  };

  return [
    ...byTier(parts => parts.prerelease.length === 0),
    ...byTier(parts => parts.prerelease[0] === 'rc'),
  ];
}

/**
 * dsh 默认版本选择策略：优先稳定版，无稳定版时取最新 rc（纯函数，无 IO）。
 *
 * 策略分层（用户拍板）：
 * 1. 优先取最大的**稳定版**（无 prerelease，如 `0.2.1`）。有稳定版时不看
 *    任何 rc——即使 rc 的 semver 更高（`0.2.2-rc.1 > 0.2.1`）也不选，因为
 *    稳定版才是正式发布通道。
 * 2. 没有稳定版时回退取最大的 **rc**（prerelease 首段为 `rc`，如
 *    `0.2.1-rc.2`）。dsh 当前 registry 只发布 rc/alpha、尚无稳定版，故
 *    回退路径是常态而非异常。
 * 3. `alpha`/`beta` 等非 rc 预发布一律不选——prerelease 首段必须是 `rc`。
 * 4. 既无稳定版也无 rc 返回 undefined，由调用方决定兜底（provisioner 回退
 *    兜底地板，见 DEFAULT_DSH_VERSION）。
 *
 * 实现为 {@link selectDshCandidates} 的首项，保证「首选」与「降级序列」
 * 同源、不会各自演化出分歧。
 *
 * @param versions - 候选版本列表（通常来自 `npm view ... versions --json`）
 * @returns 最大稳定版（无稳定版时为最新 rc）；无可用候选时 undefined
 */
export function selectDefaultDshVersion(versions: readonly string[]): string | undefined {
  return selectDshCandidates(versions)[0];
}

/**
 * 查询 registry 上某个 dist-tag 对应的具体版本。
 *
 * 供用户显式传标签（`--dsh-version next` 等）的路径使用——解析结果会被
 * 显式传下去，安装命令里绝不出现 dist-tag（见文件头第 1 点）。未显式
 * 指定版本时的默认路径不走标签，见 {@link resolveDshCandidates}。
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
 * 解析 registry 上 dsh 的有序降级候选（首选在前）。
 *
 * dist-tag `latest` 实测滞后（见文件头第 1 点），「最新」不能取任何
 * 标签——必须拉全量版本列表，经 {@link selectDshCandidates} 分层排序。
 * 执行形态与 {@link resolveDshVersion} 同款：远端 `npm view` + npmEnv
 * 缓存隔离 + `allowNonZeroExit` + 120 秒超时。本函数只抛错，解析失败后的
 * 兜底策略（回退地板、不中断引导）由 provisioner 决定。
 *
 * @param ctx - 远端执行上下文
 * @param options - 解析选项
 * @returns 有序候选序列（首项为首选；供安装失败时沿序列降级）
 * @throws RemoteError('EXEC_FAILED') 输出无法解析成版本列表、列表为空、或既无稳定版也无 rc
 */
export async function resolveDshCandidates(
  ctx: RemoteContext,
  options: {
    /** npm registry baseUrl */
    registryUrl: string;
    /** node bin 目录 */
    nodeBinDir: string;
    /** 取消信号 */
    signal?: AbortSignal;
  },
): Promise<string[]> {
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
  const candidates = versions === undefined ? [] : selectDshCandidates(versions);
  if (versions === undefined || candidates.length === 0) {
    throw new RemoteError(
      'EXEC_FAILED',
      `远端默认 dsh 版本解析失败：无法从 ${registryUrl} 解析 @deepseek-ai/dsh 的稳定版/rc 版本列表`
        + '（输出不是合法的 JSON 版本数组、列表为空、或既无稳定版也无 rc）',
      { hostAlias: transport.hostAlias },
    );
  }
  log.info(`dsh 版本解析：首选 ${candidates[0]}（候选 ${versions.length} 个）`, {
    hostAlias: transport.hostAlias,
  });
  return candidates;
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
 * 校验并返回 dsh 依赖树根目录（`<installDir>/node_modules`）。
 *
 * installDir 必须是 base 的绝对 POSIX 路径（createRemotePaths 的契约）。
 * 空串或相对路径会让随后的 `rm -rf` 落到不可预期的位置——宁可抛错也不冒
 * 误删风险。目录名固定追加 `/node_modules`，从构造上保证清理目标永远
 * 是 base 的子树、绝不等于 base 本身（历史事故就是误把 base 当清理目标）。
 *
 * @param installDir - dsh 安装目录（= base）
 * @returns 依赖树根目录绝对路径
 * @throws Error installDir 为空或非绝对路径
 */
function dshNodeModulesOf(installDir: string): string {
  if (installDir.length === 0 || !installDir.startsWith('/')) {
    throw new Error(`dsh 安装目录必须是绝对路径，实际为：${installDir}`);
  }
  return `${installDir}/node_modules`;
}

/**
 * 构造「清空 dsh 安装树」的远端命令（`rm -rf <base>/node_modules <base>/package-lock.json`）。
 *
 * 供「安装前清空」与「失败后清理」两处共用，保证清理范围一致（纯函数，导出
 * 供单测锁定路径形状约束）。installDir 非绝对路径时抛错——宁可不装也不冒
 * 误删风险。
 *
 * @param installDir - dsh 安装目录（= base）
 * @returns 可直接并入 flock 临界区的清理命令
 * @throws Error installDir 为空或非绝对路径
 */
export function buildDshCleanCommand(installDir: string): string {
  const nodeModules = dshNodeModulesOf(installDir);
  return `rm -rf ${quote(nodeModules)} ${quote(`${installDir}/package-lock.json`)}`;
}

/**
 * 清理失败的 dsh 安装树（只删 `base/node_modules` 与 lock 文件，绝不删 base 根）。
 *
 * dsh 装在 `base/node_modules` 下，而 base 本身是 DSH_HOME——还承载 Node
 * 版本目录、profiles、sessions、.agents、credentials.yaml。历史上这里的清理
 * 曾误写 `cleanup(transport, installDir)`（`installDir === base`），npm install
 * 一旦失败就会把整台远端本工具的状态清空。现经 {@link dshNodeModulesOf} 断言
 * 路径形状；异常时宁可不删也不误删——清理是尽力而为，不掩盖原始安装错误。
 *
 * @param transport - 已连接的传输
 * @param paths - 远端路径集合
 */
async function cleanupDshTree(transport: RemoteTransport, paths: RemotePaths): Promise<void> {
  let command: string;
  try {
    command = buildDshCleanCommand(paths.dshDir);
  } catch (error) {
    log.warn('dsh 安装树路径形状异常，跳过清理（绝不删除 base 根目录）', {
      dshNodeModules: `${paths.dshDir}/node_modules`,
      error: toErrorMessage(error),
    });
    return;
  }
  try {
    await transport.exec(command, { allowNonZeroExit: true });
  } catch { /* 清理失败只留下无用目录，不影响错误上报 */ }
}

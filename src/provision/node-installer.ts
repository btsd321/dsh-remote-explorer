/**
 * @file 远端 Node 运行时安装
 * @description 下载官方 Node 发行版 tarball 到远端并解包到版本隔离的目录，
 *              装完立即做稳定性自检。下载走镜像候选链（{@link nodeMirrorChain}）：
 *              单一镜像失败自动换下一源，全部镜像与官方源都失败才报错。
 *
 * 版本策略（决策 10）：默认锁定 v24 系。P0 实测 v22.23.2 在 aarch64 上起进程
 * 崩溃率 35%（V8 初始化 isolate 随机失败，报 OOM 但机器内存充足），
 * 而 v24.11.1 在同一台机器上 0/60 失败。dsh 的 engines 是
 * `^22.19.0 || >=24.0.0`，v24 在范围内。默认跟随 Node 24 LTS（Krypton）
 * 最新版，当前为 v24.21.0。
 *
 * 目录隔离：每个版本装到 `~/.dsh-remote-explorer/btsd321/node/<版本>/`，多版本并存。
 * 升级时不覆盖旧版本，避免「运行中的进程占着文件」这类故障。
 */

import { RemoteError, toErrorMessage } from '../util/errors.js';
import { createLogger } from '../util/logger.js';
import { quote } from '../util/shell-quote.js';
import { INSTALL_LOCK_WAIT_SECONDS, lockInstallCommand } from './install-lock.js';
import { getCandidates, OFFICIAL_NODE_BASE_URL, type MirrorCandidate } from './mirror-selector.js';
import { assertNodeStable, checkNodeStability } from './probe.js';
import type { RemoteContext } from './remote-context.js';
import type { RemotePaths } from './remote-paths.js';
import type { RemoteArch, RemoteOs, RemoteTransport } from '../transport/types.js';

const log = createLogger('node-installer');

/**
 * 默认安装的 Node 版本。
 *
 * 跟随 Node 24 LTS（Krypton）最新版。P0 实测 v24.11.1 在 aarch64 上 0/60
 * 失败，v24 系已验证稳定。用户可用 `--node-version` 覆盖。
 */
export const DEFAULT_NODE_VERSION = 'v24.21.0';

/** 下载 tarball 的超时（毫秒）。P0 实测 29M 用了 2.9s，给足余量应对慢链路 */
const DOWNLOAD_TIMEOUT_MS = 600_000;

/** 解包超时（毫秒）。P0 实测 4.2s */
const EXTRACT_TIMEOUT_MS = 300_000;

/** Node 发行版 tarball 的平台段命名 */
const OS_SEGMENT: Record<RemoteOs, string> = {
  linux: 'linux',
  darwin: 'darwin',
};

/** Node 发行版 tarball 的架构段命名 */
const ARCH_SEGMENT: Record<RemoteArch, string> = {
  x64: 'x64',
  arm64: 'arm64',
  armv7l: 'armv7l',
};

/** Node 安装结果 */
export interface NodeInstallResult {
  /** 安装的版本 */
  version: string;
  /** node 可执行文件绝对路径 */
  nodeBin: string;
  /** bin 目录绝对路径（必须加进 PATH） */
  binDir: string;
  /** 是否复用了已有安装 */
  reused: boolean;
}

/**
 * 确保远端有可用且稳定的指定版本 Node。
 *
 * 已装则直接复用（对标 Zed 的 `binary_exists_on_server` 检查），
 * 未装则下载安装。两种路径都会做稳定性自检——复用的也要检，
 * 因为同一个二进制在不同时刻的表现可能不同（实测崩溃是随机的）。
 *
 * @param ctx - 远端执行上下文
 * @param options - 安装选项
 * @returns 安装结果
 * @throws RemoteError('NODE_UNSTABLE') 稳定性自检不合格
 * @throws RemoteError('EXEC_FAILED') 下载或解包失败
 */
export async function ensureNode(
  ctx: RemoteContext,
  options: {
    /** 目标版本，含 v 前缀 */
    version: string;
    /** Node 发行版镜像 baseUrl */
    mirrorBaseUrl: string;
    /** 跳过稳定性自检（仅供 doctor 之类只读场景使用） */
    skipStabilityCheck?: boolean;
    /** 取消信号 */
    signal?: AbortSignal;
    /** 阶段进度回调 */
    onProgress?: (message: string) => void;
  },
): Promise<NodeInstallResult> {
  const { version, mirrorBaseUrl, signal } = options;
  const { transport, paths } = ctx;
  const nodeBin = paths.nodeBin(version);
  const binDir = paths.nodeBinDir(version);

  // 1. 检查是否已装：直接执行 `node -v` 并比对版本，不看文件存在性——
  //    残留的半成品目录会让文件检查误判
  const existing = await transport.exec(`${quote(nodeBin)} -v 2>/dev/null || true`, {
    allowNonZeroExit: true,
    ...(signal ? { signal } : {}),
  });
  const reused = existing.stdout.trim() === version;

  if (!reused) {
    // 调用方在「探测显示已装」时会省掉镜像测速并传空 URL。若此时却判定需要安装，
    // 说明探测与实际不一致（安装目录残留但二进制损坏）——不再视为错误：下载
    // 候选链（{@link nodeMirrorChain}）不依赖传入的首选镜像，直接自愈重装
    if (mirrorBaseUrl.length === 0) {
      log.warn(
        `探测判定 Node ${version} 已装但二进制不可用，安装目录疑似残留`
          + `（${nodeBin} 无法执行或版本不符），将经默认镜像候选链重新下载`,
        { hostAlias: transport.hostAlias },
      );
    }
    options.onProgress?.(`下载 Node ${version}`);
    await downloadAndExtract(ctx, version, mirrorBaseUrl, signal);

    // 装完立即验证版本，避免镜像给错文件时把问题留到后面
    const verify = await transport.exec(`${quote(nodeBin)} -v`, {
      ...(signal ? { signal } : {}),
    });
    const actual = verify.stdout.trim();
    if (actual !== version) {
      throw new RemoteError(
        'EXEC_FAILED',
        `主机 ${transport.hostAlias} 上安装的 Node 版本不符：期望 ${version}，实际 ${actual || '(无输出)'}`,
        { hostAlias: transport.hostAlias },
      );
    }
  }

  // 2. 稳定性自检（决策 10 要求，容错次数为 0）
  if (options.skipStabilityCheck !== true) {
    options.onProgress?.(`Node ${version} 稳定性自检`);
    const stability = await checkNodeStability(transport, nodeBin, undefined, signal);
    assertNodeStable(stability, transport.hostAlias, version);
  }

  return { version, nodeBin, binDir, reused };
}

/**
 * 构造 Node 下载的镜像候选链（纯函数）。
 *
 * 单一镜像失败不终止安装（用户明确的语义）：按「首选镜像 → 其余镜像 →
 * 官方源垫底」的顺序逐一尝试，全部失败才报错。首选镜像（测速或缓存选中）
 * 优先；官方源固定垫底——它最慢但最全（镜像同步缺口实测存在：清华
 * nodejs-release 缺 v24.21.0 整个目录，测速却照样能选中它）。
 *
 * @param preferredBaseUrl - 首选镜像 baseUrl（可为空串；不在候选列表里时按
 *                          未知候选置于链首）
 * @returns 去重后的候选链，baseUrl 互不相同
 */
export function nodeMirrorChain(preferredBaseUrl: string): readonly MirrorCandidate[] {
  const chain: MirrorCandidate[] = [];
  const seen = new Set<string>();
  const add = (candidate: MirrorCandidate): void => {
    if (seen.has(candidate.baseUrl)) return;
    seen.add(candidate.baseUrl);
    chain.push(candidate);
  };

  // 1. 首选镜像置顶（测速胜出或缓存命中的那一个）
  if (preferredBaseUrl.length > 0) {
    const known = getCandidates('node').find(c => c.baseUrl === preferredBaseUrl);
    add(known ?? { name: '首选', baseUrl: preferredBaseUrl });
  }
  // 2. 其余镜像按候选列表顺序
  for (const candidate of getCandidates('node')) {
    if (candidate.baseUrl === OFFICIAL_NODE_BASE_URL) continue;
    add(candidate);
  }
  // 3. 官方源垫底（首选即官方时已在链首，此处去重跳过）
  const official = getCandidates('node').find(c => c.baseUrl === OFFICIAL_NODE_BASE_URL);
  if (official !== undefined) add(official);
  return chain;
}

/**
 * 下载并解包 Node 发行版。
 *
 * 下载按 {@link nodeMirrorChain} 的候选链逐源尝试：单一镜像缺版本文件
 * （404）、不可达或超时都会自动换下一源，仅当全部镜像与官方源都失败时
 * 才汇总各次失败原因上抛。curl 加 `--connect-timeout`：不可达的源在
 * 连接期 15 秒内失败，不吃满整个下载超时。
 *
 * @param ctx - 远端执行上下文
 * @param version - 目标版本
 * @param preferredBaseUrl - 首选镜像 baseUrl（候选链首项；空串时用默认链）
 * @param signal - 取消信号
 * @throws RemoteError('PLATFORM_UNSUPPORTED') 平台无对应发行版
 * @throws RemoteError('EXEC_FAILED') 候选链全部下载失败，或解包失败
 */
async function downloadAndExtract(
  ctx: RemoteContext,
  version: string,
  preferredBaseUrl: string,
  signal?: AbortSignal,
): Promise<void> {
  const { transport, paths } = ctx;
  const platform = transport.platform;
  const osSegment = OS_SEGMENT[platform.os];
  const archSegment = ARCH_SEGMENT[platform.arch];
  const dirName = `node-${version}-${osSegment}-${archSegment}`;
  const tarball = `${dirName}.tar.xz`;

  // 临时目录带本机 pid，避免多个 CLI 并发安装时互相覆盖（Zed 的做法）
  const tmpDir = paths.tmpDir(process.pid, 'node-install');
  const targetDir = paths.nodeDir(version);

  // 1. 候选链逐源下载。curl 用 -fL：跟随重定向（镜像常有 302），HTTP 错误码
  //    要失败而非写出错误页；--connect-timeout 让不可达源快速失败
  const attempts = nodeMirrorChain(preferredBaseUrl);
  const failures: string[] = [];
  let downloaded = false;
  for (const candidate of attempts) {
    const url = `${candidate.baseUrl}/${version}/${tarball}`;
    const download = [
      `mkdir -p ${quote(tmpDir)}`,
      `cd ${quote(tmpDir)}`,
      `curl -fsSL --connect-timeout 15 --max-time ${Math.floor(DOWNLOAD_TIMEOUT_MS / 1000)}`
        + ` -o ${quote(tarball)} ${quote(url)}`,
    ].join('\n');
    try {
      await transport.exec(download, {
        timeoutMs: DOWNLOAD_TIMEOUT_MS,
        ...(signal ? { signal } : {}),
      });
      downloaded = true;
      if (failures.length > 0) {
        log.info(
          `Node ${version} 已从 ${candidate.name}（${candidate.baseUrl}）下载成功`
            + `（前 ${failures.length} 个源失败后回退）`,
          { hostAlias: transport.hostAlias },
        );
      }
      break;
    } catch (error) {
      const reason = toErrorMessage(error);
      failures.push(`${candidate.name}（${url}）：${reason}`);
      // 单源失败不是终局：换下一候选（复盘日志按源留痕）
      log.warn(`Node 下载失败：${url}（${reason}），换下一源`, {
        hostAlias: transport.hostAlias,
      });
    }
  }

  if (!downloaded) {
    // 清理残留的临时目录，避免下次误判
    await cleanup(transport, tmpDir);
    throw new RemoteError(
      'EXEC_FAILED',
      `Node ${version} 下载失败：已尝试全部镜像与官方源，均不可用——\n`
        + failures.map(f => `  ${f}`).join('\n')
        + `\n若并非网络问题，请确认 ${platform.os}/${platform.arch} 有对应构建`,
      { hostAlias: transport.hostAlias },
    );
  }

  // 2. 解包并原子地移到目标位置。
  // 先解到临时目录再 mv，避免中途失败留下半个安装被后续误判为"已装"。
  // 整段套 flock：`rm -rf 目标 && mv` 是写版本目录的临界区，多人同远端
  // 账号并发引导时会互删（等锁超时计入 exec 超时）
  const extract = lockInstallCommand(paths, [
    `cd ${quote(tmpDir)}`,
    `tar xf ${quote(tarball)}`,
    `mkdir -p ${quote(dirOf(targetDir))}`,
    `rm -rf ${quote(targetDir)}`,
    `mv ${quote(`${tmpDir}/${dirName}`)} ${quote(targetDir)}`,
  ].join('\n'));

  try {
    await transport.exec(extract, {
      timeoutMs: EXTRACT_TIMEOUT_MS + INSTALL_LOCK_WAIT_SECONDS * 1_000,
      ...(signal ? { signal } : {}),
    });
  } finally {
    // 无论成败都清理临时目录——tarball 有几十 MB
    await cleanup(transport, tmpDir);
  }
}

/**
 * 删除远端临时目录，失败不抛错。
 *
 * @param transport - 已连接的传输
 * @param dir - 待删目录绝对路径
 */
async function cleanup(transport: RemoteTransport, dir: string): Promise<void> {
  try {
    await transport.exec(`rm -rf ${quote(dir)}`, { allowNonZeroExit: true });
  } catch { /* 清理失败只留下临时文件，不影响本次结果 */ }
}

/**
 * 取路径的父目录。
 *
 * 远端是 POSIX，用字符串处理而非 node:path——后者在 Windows 上会产出反斜杠。
 *
 * @param path - 绝对路径
 * @returns 父目录路径
 */
function dirOf(path: string): string {
  const index = path.lastIndexOf('/');
  return index <= 0 ? '/' : path.slice(0, index);
}

/**
 * @file 远端 Node 运行时安装
 * @description 下载官方 Node 发行版 tarball 到远端并解包到版本隔离的目录，
 *              装完立即做稳定性自检。
 *
 * 版本策略（决策 10）：默认锁定 v24 系。P0 实测 v22.23.2 在 aarch64 上起进程
 * 崩溃率 35%（V8 初始化 isolate 随机失败，报 OOM 但机器内存充足），
 * 而 v24.11.1 在同一台机器上 0/60 失败。dsh 的 engines 是
 * `^22.19.0 || >=24.0.0`，v24 在范围内。
 *
 * 目录隔离：每个版本装到 `~/.dsh-remote/node/<版本>/`，多版本并存。
 * 升级时不覆盖旧版本，避免「运行中的进程占着文件」这类故障。
 */

import { RemoteError } from '../util/errors.js';
import { quote } from '../util/shell-quote.js';
import { assertNodeStable, checkNodeStability } from './probe.js';
import type { RemotePaths } from './remote-paths.js';
import type { RemoteArch, RemoteOs, RemoteTransport } from '../transport/types.js';

/**
 * 默认安装的 Node 版本。
 *
 * P0 在 aarch64 上实测 0/60 失败，是目前已验证稳定的版本。
 * 用户可用 `--node-version` 覆盖。
 */
export const DEFAULT_NODE_VERSION = 'v24.11.1';

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
 * @param transport - 已连接的传输
 * @param paths - 远端路径集合
 * @param options - 安装选项
 * @returns 安装结果
 * @throws RemoteError('NODE_UNSTABLE') 稳定性自检不合格
 * @throws RemoteError('EXEC_FAILED') 下载或解包失败
 */
export async function ensureNode(
  transport: RemoteTransport,
  paths: RemotePaths,
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
    // 说明探测与实际不一致（安装目录残留但二进制损坏），必须明确报错而不是
    // 拿着空 URL 去拼出一个必然失败的下载地址
    if (mirrorBaseUrl.length === 0) {
      throw new RemoteError(
        'EXEC_FAILED',
        `主机 ${transport.hostAlias} 上的 Node ${version} 安装已损坏`
          + `（${nodeBin} 无法执行或版本不符），但未提供下载镜像。`
          + `请删除 ${paths.nodeDir(version)} 后重试`,
        { hostAlias: transport.hostAlias },
      );
    }
    options.onProgress?.(`下载 Node ${version}`);
    await downloadAndExtract(transport, paths, version, mirrorBaseUrl, signal);

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
 * 下载并解包 Node 发行版。
 *
 * @param transport - 已连接的传输
 * @param paths - 远端路径集合
 * @param version - 目标版本
 * @param mirrorBaseUrl - 镜像 baseUrl
 * @param signal - 取消信号
 * @throws RemoteError('PLATFORM_UNSUPPORTED') 平台无对应发行版
 */
async function downloadAndExtract(
  transport: RemoteTransport,
  paths: RemotePaths,
  version: string,
  mirrorBaseUrl: string,
  signal?: AbortSignal,
): Promise<void> {
  const platform = transport.platform;
  const osSegment = OS_SEGMENT[platform.os];
  const archSegment = ARCH_SEGMENT[platform.arch];
  const dirName = `node-${version}-${osSegment}-${archSegment}`;
  const tarball = `${dirName}.tar.xz`;
  const url = `${mirrorBaseUrl}/${version}/${tarball}`;

  // 临时目录带本机 pid，避免多个 CLI 并发安装时互相覆盖（Zed 的做法）
  const tmpDir = paths.tmpDir(process.pid, 'node-install');
  const targetDir = paths.nodeDir(version);

  // 下载。curl 用 -fL：跟随重定向（镜像常有 302），HTTP 错误码要失败而非写出错误页
  const download = [
    `mkdir -p ${quote(tmpDir)}`,
    `cd ${quote(tmpDir)}`,
    `curl -fsSL --max-time ${Math.floor(DOWNLOAD_TIMEOUT_MS / 1000)} -o ${quote(tarball)} ${quote(url)}`,
  ].join('\n');

  try {
    await transport.exec(download, {
      timeoutMs: DOWNLOAD_TIMEOUT_MS,
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    // 清理残留的临时目录，避免下次误判
    await cleanup(transport, tmpDir);
    throw new RemoteError(
      'EXEC_FAILED',
      `从 ${url} 下载 Node 失败。若该镜像缺少此平台的发行版，`
        + `请确认 ${platform.os}/${platform.arch} 有对应构建`,
      { cause: error, hostAlias: transport.hostAlias },
    );
  }

  // 解包并原子地移到目标位置。
  // 先解到临时目录再 mv，避免中途失败留下半个安装被后续误判为"已装"
  const extract = [
    `cd ${quote(tmpDir)}`,
    `tar xf ${quote(tarball)}`,
    `mkdir -p ${quote(dirOf(targetDir))}`,
    `rm -rf ${quote(targetDir)}`,
    `mv ${quote(`${tmpDir}/${dirName}`)} ${quote(targetDir)}`,
  ].join('\n');

  try {
    await transport.exec(extract, {
      timeoutMs: EXTRACT_TIMEOUT_MS,
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

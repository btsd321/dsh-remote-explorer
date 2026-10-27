/**
 * @file 本机资源下载（local_resource_download 的本机侧能力）
 * @description 远端无网络时用本机网络下载资源包，下载到本机临时文件后由 provision
 *              层的 installer 经 SFTP（transport.uploadFile）传到远端再解包安装。
 *
 * 两个下载目标：
 * 1. **Node 发行版 tarball**（.tar.xz）：复用 {@link nodeMirrorChain} 候选链 +
 *    本机 `fetch` 逐源尝试（与远端 curl 下载同一套镜像清单，避免两处手动复制）
 * 2. **npm 包 tarball**（`npm pack` 的 .tgz）：经 npm registry 的 packument
 *    API 拿到 tarball URL 后本机 fetch 下载
 *
 * 与 local-mirror-race.ts 的关系：那个模块竞速的是 JSON 元数据（版本列表），
 * 本模块下载的是二进制 tarball——不竞速（tarball 较大，并发下载浪费带宽），
 * 而是按候选链逐源尝试，首个成功即返回（与远端 curl 的 `nodeMirrorChain`
 * 语义一致）。
 *
 * 分层约束：本文件属能力层（provision/），向下使用基础层（util/logger）与
 * 传输层类型（transport/types，仅类型）；不依赖编排层（session/）或入口层。
 */

import { createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import { createLogger } from '../util/logger.js';
import { toErrorMessage } from '../util/errors.js';
import {
  getCandidates, OFFICIAL_NODE_BASE_URL, type MirrorCandidate,
} from './mirror-selector.js';
import type { RemoteArch, RemoteOs } from '../transport/types.js';

const log = createLogger('local-downloader');

/** 本机下载单个 tarball 的超时（毫秒）。Node tarball 约 30MB，给足慢链路余量 */
const DOWNLOAD_TIMEOUT_MS = 600_000;

/** 本机 fetch 单个 URL 的连接超时（毫秒）。不可达的源应快速失败 */
const CONNECT_TIMEOUT_MS = 15_000;

/** Node 发行版 tarball 的平台段命名（与 node-installer.ts 的 OS_SEGMENT 同源） */
const OS_SEGMENT: Record<RemoteOs, string> = {
  linux: 'linux',
  darwin: 'darwin',
};

/** Node 发行版 tarball 的架构段命名（与 node-installer.ts 的 ARCH_SEGMENT 同源） */
const ARCH_SEGMENT: Record<RemoteArch, string> = {
  x64: 'x64',
  arm64: 'arm64',
  armv7l: 'armv7l',
};

/** 下载结果：本机临时文件路径与清理函数 */
export interface LocalDownloadResult {
  /** 本机临时文件路径（调用方用完后必须调 cleanup 删除） */
  localPath: string;
  /** 删除本机临时文件；幂等 */
  cleanup: () => Promise<void>;
}

/**
 * 构造 Node 下载的镜像候选链（与 node-installer.ts 的 nodeMirrorChain 同源）。
 *
 * 首选镜像 → 其余镜像 → 官方源垫底，baseUrl 去重。远端 curl 下载与本机 fetch
 * 下载共用同一份候选链与同一份镜像清单（{@link getCandidates}），保证两侧
 * 的镜像缺口与可用性感知一致。
 *
 * @param preferredBaseUrl - 首选镜像 baseUrl（测速胜出或缓存命中；空串用默认链）
 * @returns 去重后的候选链
 */
export function nodeMirrorChain(preferredBaseUrl: string): readonly MirrorCandidate[] {
  const chain: MirrorCandidate[] = [];
  const seen = new Set<string>();
  const add = (candidate: MirrorCandidate): void => {
    if (seen.has(candidate.baseUrl)) return;
    seen.add(candidate.baseUrl);
    chain.push(candidate);
  };

  // 1. 首选镜像置顶
  if (preferredBaseUrl.length > 0) {
    const known = getCandidates('node').find(c => c.baseUrl === preferredBaseUrl);
    add(known ?? { name: '首选', baseUrl: preferredBaseUrl });
  }
  // 2. 其余镜像按候选列表顺序
  for (const candidate of getCandidates('node')) {
    if (candidate.baseUrl === OFFICIAL_NODE_BASE_URL) continue;
    add(candidate);
  }
  // 3. 官方源垫底
  const official = getCandidates('node').find(c => c.baseUrl === OFFICIAL_NODE_BASE_URL);
  if (official !== undefined) add(official);
  return chain;
}

/**
 * 本机下载 Node 发行版 tarball 到临时文件。
 *
 * 按 {@link nodeMirrorChain} 候选链逐源本机 fetch，首个成功即返回。全部失败
 * 时抛错（由 auto 模式的调用方决定是否回退远端 curl 重试——但本机下载已是
 * 回退路径，失败即向上抛）。
 *
 * @param version - Node 版本（含 v 前缀）
 * @param platform - 远端平台信息（os/arch 决定 tarball 命名）
 * @param preferredBaseUrl - 首选镜像 baseUrl（空串用默认链）
 * @returns 下载结果（临时文件路径 + 清理函数）
 * @throws Error 全部镜像与官方源都下载失败
 */
export async function downloadNodeTarballLocally(
  version: string,
  platform: { os: RemoteOs; arch: RemoteArch },
  preferredBaseUrl: string,
): Promise<LocalDownloadResult> {
  const osSegment = OS_SEGMENT[platform.os];
  const archSegment = ARCH_SEGMENT[platform.arch];
  const dirName = `node-${version}-${osSegment}-${archSegment}`;
  const tarball = `${dirName}.tar.xz`;

  const attempts = nodeMirrorChain(preferredBaseUrl);
  const failures: string[] = [];
  for (const candidate of attempts) {
    const url = `${candidate.baseUrl}/${version}/${tarball}`;
    try {
      const result = await downloadToFile(url, tarball);
      if (failures.length > 0) {
        log.info(
          `Node ${version} 已从 ${candidate.name}（${candidate.baseUrl}）本机下载成功`
          + `（前 ${failures.length} 个源失败后回退）`,
        );
      }
      return result;
    } catch (error) {
      const reason = toErrorMessage(error);
      failures.push(`${candidate.name}（${url}）：${reason}`);
      log.warn(`本机下载 Node 失败：${url}（${reason}），换下一源`);
    }
  }

  throw new Error(
    `Node ${version} 本机下载失败：已尝试全部镜像与官方源，均不可用——\n`
    + failures.map(f => `  ${f}`).join('\n')
    + `\n若并非网络问题，请确认 ${platform.os}/${platform.arch} 有对应构建`,
  );
}

/**
 * 本机下载 npm 包 tarball（.tgz）到临时文件。
 *
 * 经 npm registry 的 packument API（`<registry>/<scope>/<name>`）拿到指定版本
 * 的 `dist.tarball` URL，再本机 fetch 下载。tarball URL 通常指向 CDN
 * （如 registry.npmmirror.com 的 tarball 在 nodesource 等），fetch 自动跟随
 * 重定向。
 *
 * **局限性**：npm 包 tarball 不自包含——`npm install` 本地 tarball 仍需从
 * registry 下载该包的依赖树。本机下载解决了包本身的 tarball 传输，但远端
 * `npm install` 本地包时仍需 registry 可达（至少依赖树可达）。完全离线方案
 * 走 `offline-export`/`offline-import`（导出整个 node_modules 归档）。
 * 此函数的价值在于：远端的 registry 可达但**特定包的 tarball 下载受阻**
 * （如镜像缺版本、CDN 抖动）时，本机下载 tarball + SFTP 上传能让 npm install
 * 本地包绕过 tarball 下载环节。
 *
 * @param packageName - 完整包名（含 scope，如 `@deepseek-ai/dsh`）
 * @param version - 精确版本号（不含 dist-tag；调用方先解析）
 * @param registryUrl - npm registry baseUrl
 * @returns 下载结果（临时文件路径 + 清理函数）
 * @throws Error packument 查询失败、版本不存在或 tarball 下载失败
 */
export async function downloadNpmTarballLocally(
  packageName: string,
  version: string,
  registryUrl: string,
): Promise<LocalDownloadResult> {
  // 1. 查 packument 拿 tarball URL
  //    packument URL: <registry>/<scope>/<name>（scope 的 @ 需保持，registry 路径不编码）
  const packumentUrl = `${registryUrl.replace(/\/+$/, '')}/${packageName}`;
  const tarballUrl = await fetchTarballUrl(packumentUrl, version);
  // 2. 本机下载 tarball
  const tarballName = `${packageName.replace(/^@/, '').replace('/', '-')}-${version}.tgz`;
  return downloadToFile(tarballUrl, tarballName);
}

/**
 * 查 packument 拿指定版本的 tarball URL。
 *
 * @param packumentUrl - packument 完整 URL
 * @param version - 精确版本号
 * @returns tarball URL
 * @throws Error 查询失败、版本不存在或 tarball 字段缺失
 */
async function fetchTarballUrl(packumentUrl: string, version: string): Promise<string> {
  const response = await fetch(packumentUrl, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`packument 查询返回 HTTP ${response.status}（${packumentUrl}）`);
  }
  const packument = await response.json() as { versions?: Record<string, { dist?: { tarball?: string } }> };
  const versionEntry = packument.versions?.[version];
  if (versionEntry === undefined) {
    throw new Error(`packument 中不存在版本 ${version}（${packumentUrl}）`);
  }
  const tarballUrl = versionEntry.dist?.tarball;
  if (typeof tarballUrl !== 'string' || tarballUrl.length === 0) {
    throw new Error(`版本 ${version} 的 dist.tarball 字段缺失或非字符串`);
  }
  return tarballUrl;
}

/**
 * 本机 fetch 下载一个 URL 到临时文件（流式写入，不过载内存）。
 *
 * 临时文件放在 OS 临时目录下的唯一子目录里（`<tmpdir>/dsh-remote-explorer-<uuid>/`），
 * 调用方用完后通过返回的 cleanup 函数删除整个子目录。
 *
 * @param url - 完整下载 URL
 * @param fileName - 临时文件名（仅用于日志与诊断）
 * @returns 下载结果（临时文件路径 + 清理函数）
 * @throws Error fetch 失败、HTTP 错误码或流式写入失败
 */
async function downloadToFile(url: string, fileName: string): Promise<LocalDownloadResult> {
  const dir = join(tmpdir(), `dsh-remote-explorer-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  const localPath = join(dir, fileName);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}（${url}）`);
    }
    if (response.body === null) {
      throw new Error(`响应体为空（${url}）`);
    }
    // 流式写入：fetch 的 body 是 ReadableStream，经 pipeline 转 Node stream 写文件
    await pipeline(response.body as unknown as NodeJS.ReadableStream, createWriteStream(localPath));

    // 校验文件非空（空文件说明下载异常）
    const stats = await stat(localPath);
    if (stats.size === 0) {
      throw new Error('下载的文件大小为 0');
    }
    log.info(`本机下载完成：${fileName}（${url}）`);
  } catch (error) {
    // 下载失败要清掉临时目录，避免堆积
    try { await rm(dir, { recursive: true, force: true }); } catch { /* 清理失败无妨 */ }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  return {
    localPath,
    cleanup: async () => {
      try { await rm(dir, { recursive: true, force: true }); } catch { /* 清理失败无妨 */ }
    },
  };
}

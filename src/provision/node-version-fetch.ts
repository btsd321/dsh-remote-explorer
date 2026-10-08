/**
 * @file 本机 Node 版本探测
 * @description 在 dsh 宿主进程（本机）直接 HTTP 查询 Node 官方发行站 index.json，
 *              拉取已发布版本列表，供面板版本下拉框填充。与 dsh-version-fetch
 *              同款设计：进程内缓存（TTL 5 分钟）、降级优先（不可达返回空列表）、
 *              门槛过滤（只显示 dsh engines 兼容的版本）。
 *
 *              Node 版本号带 `v` 前缀（如 `v24.21.0`），与 dsh 的 semver 格式
 *              不同——解析时需剥掉 `v` 前缀再过 parseSemver。dsh 的 engines
 *              要求 `^22.19.0 || >=24.0.0`，故门槛设为 major >= 22。
 */

import { createLogger } from '../util/logger.js';
import { compareSemver, parseSemver, type SemverParts } from './dsh-installer.js';

/** 模块日志器（探测关键节点与失败告警） */
const log = createLogger('node-version-fetch');

/** 显示给用户的最小 major 版本（dsh engines 要求 ^22.19.0 || >=24.0.0） */
const MIN_NODE_MAJOR = 22;

/** 缓存有效期（毫秒）。面板高频打开，5 分钟窗口内复用上次查询结果 */
const CACHE_TTL_MS = 5 * 60 * 1_000;

/** Node 官方发行站 index.json 地址 */
const INDEX_URL = 'https://nodejs.org/dist/index.json';

/** HTTP 查询超时（毫秒）：慢链路下不阻塞面板加载太久 */
const FETCH_TIMEOUT_MS = 15_000;

/** Node 版本探测结果 */
export interface NodeVersionList {
  /** 可用版本列表（major >= 22，按 semver 降序排列，最新在前；带 v 前缀） */
  versions: string[];
  /** 最新版本（列表非空时为 versions[0]；列表空时 undefined） */
  latest?: string;
}

/** Node index.json 单条条目（只取用到的字段） */
interface NodeIndexEntry {
  /** 版本号（带 v 前缀，如 v24.21.0） */
  version: string;
  /** LTS 代号（如 Krypton）；非 LTS 版本为 false */
  lts: string | false;
}

/** 进程内缓存条目（带过期时间戳） */
interface CacheEntry {
  /** 缓存值 */
  list: NodeVersionList;
  /** 缓存过期时间戳（epoch 毫秒） */
  expiresAt: number;
}

/** 进程内缓存（模块级单例；缓存窗口内复用上次查询结果） */
let cache: CacheEntry | undefined;

/**
 * 从 index.json 条目数组提取版本号列表并按门槛过滤+降序排列。
 *
 * Node 版本号带 `v` 前缀（如 `v24.21.0`），parseSemver 不接受前缀——
 * 需剥掉 `v` 再解析。过滤掉 major < 22 的版本（dsh engines 不兼容），
 * 剩余按 semver 降序排列（最新在前），返回时还原 `v` 前缀。
 *
 * @param entries - index.json 解析出的条目数组
 * @returns 过滤+排序后的版本号列表（带 v 前缀）
 */
function filterAndSortVersions(entries: readonly NodeIndexEntry[]): string[] {
  const parsed: Array<{ raw: string; parts: SemverParts }> = [];
  for (const entry of entries) {
    // 剥掉 v 前缀再解析（parseSemver 不接受 v 前缀）
    const stripped = entry.version.startsWith('v')
      ? entry.version.slice(1)
      : entry.version;
    const parts = parseSemver(stripped);
    if (parts === undefined) continue;
    if (parts.major < MIN_NODE_MAJOR) continue;
    parsed.push({ raw: entry.version, parts });
  }
  // 按 semver 降序排列（最新在前）
  parsed.sort((a, b) => compareSemver(b.parts, a.parts));
  return parsed.map(item => item.raw);
}

/**
 * 探测 Node 官方发行站的已发布版本列表。
 *
 * 查询 `https://nodejs.org/dist/index.json`（Node 发行站标准索引文件），
 * 提取各条目的 version 字段，过滤掉 major < 22 的版本（dsh engines 不兼容），
 * 按 semver 降序排列。进程内缓存（5 分钟 TTL）避免面板每次打开都打 registry。
 *
 * **降级语义**：registry 不可达、超时、返回非 JSON、解析失败——一律返回
 * `{ versions: [], latest: undefined }`，不抛错。面板降级为空 datalist，
 * 用户仍可手动输入任意版本号。
 *
 * @returns 版本列表与最新版本号；探测失败返回空列表
 */
export async function fetchNodeVersions(): Promise<NodeVersionList> {
  // 1. 缓存命中：未过期直接复用
  const now = Date.now();
  if (cache !== undefined && cache.expiresAt > now) {
    return cache.list;
  }

  // 2. 查询 Node 官方发行站 index.json
  try {
    const response = await fetch(INDEX_URL, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      log.warn('index.json 查询返回非 2xx', { url: INDEX_URL, status: response.status });
      return emptyResult();
    }
    const raw: unknown = await response.json();
    if (!Array.isArray(raw)) {
      log.warn('index.json 返回非数组', { url: INDEX_URL });
      return emptyResult();
    }
    // 逐条校验形状，只取 version 字段（lts 字段保留供将来扩展）
    const entries: NodeIndexEntry[] = [];
    for (const item of raw) {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
      const record = item as Record<string, unknown>;
      if (typeof record.version !== 'string') continue;
      entries.push({
        version: record.version,
        lts: typeof record.lts === 'string' ? record.lts : false,
      });
    }
    const versions = filterAndSortVersions(entries);

    // latest 取过滤后降序列表的首项（filterAndSortVersions 已按 semver 降序排列）
    const latest = versions.length > 0 ? versions[0] : undefined;
    const result: NodeVersionList = {
      versions,
      ...(latest !== undefined ? { latest } : {}),
    };
    cache = { list: result, expiresAt: now + CACHE_TTL_MS };
    log.info('Node 版本探测成功', { count: versions.length, latest });
    return result;
  } catch (error) {
    // 降级：index.json 不可达/超时/解析失败——返回空列表，不阻塞面板
    const msg = error instanceof Error ? error.message : String(error);
    log.warn('Node 版本探测失败，返回空列表', { url: INDEX_URL, error: msg });
    return emptyResult();
  }
}

/**
 * 构造空探测结果（降级用）。
 *
 * @returns 空版本列表
 */
function emptyResult(): NodeVersionList {
  return { versions: [] };
}

/**
 * 清除进程内缓存（测试用；面板路由不需要主动调用）。
 */
export function clearNodeVersionCache(): void {
  cache = undefined;
}

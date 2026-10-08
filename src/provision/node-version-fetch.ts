/**
 * @file 本机 Node 版本探测
 * @description 在 dsh 宿主进程（本机）直接 HTTP 查询 Node 发行站 index.json，
 *              拉取已发布版本列表，供面板版本下拉框填充。与 dsh-version-fetch
 *              同款设计：镜像竞速自适应、进程内缓存（TTL 5 分钟）、降级优先
 *              （不可达返回空列表）、门槛过滤（只显示 dsh engines 兼容的版本）。
 *
 *              Node 版本号带 `v` 前缀（如 `v24.21.0`），与 dsh 的 semver 格式
 *              不同——解析时需剥掉 `v` 前缀再过 parseSemver。dsh 的 engines
 *              要求 `^22.19.0 || >=24.0.0`，门槛需精确匹配该范围：22.19.0+
 *              与 24.0.0+ 兼容，23.x 整条线不兼容。
 */

import { createLogger } from '../util/logger.js';
import { compareSemver, parseSemver, type SemverParts } from './dsh-installer.js';
import { raceMirrors, type LocalMirrorCandidate } from './local-mirror-race.js';

/** 模块日志器（探测关键节点与失败告警） */
const log = createLogger('node-version-fetch');

/**
 * 显示给用户的最小 22 系 minor 版本（dsh engines `^22.19.0` 的下界）。
 * 22.19.0 以下（含 22.18.x 及更早）不兼容 dsh，不进下拉列表。
 */
const MIN_NODE22_MINOR = 19;

/**
 * dsh engines 要求 `^22.19.0 || >=24.0.0`：22.19.0+ 与 24.0.0+ 兼容，
 * 23.x 整条线不在范围内。判断已解析版本是否满足该范围。
 *
 * @param parts - 已解析的 semver 结构（不带 v 前缀）
 * @returns 满足 dsh engines 范围返回 true
 */
function meetsDshEngines(parts: SemverParts): boolean {
  // >=24.0.0：24 系及以上全部兼容
  if (parts.major >= 24) return true;
  // ^22.19.0：22 系需 minor >= 19
  if (parts.major === 22) return parts.minor >= MIN_NODE22_MINOR;
  // 23 系及其他 major 不在范围内
  return false;
}

/** 缓存有效期（毫秒）。面板高频打开，5 分钟窗口内复用上次查询结果 */
const CACHE_TTL_MS = 5 * 60 * 1_000;

/** Node 发行站候选镜像（与 mirror-selector.ts 的 NODE_MIRRORS 对齐） */
const NODE_MIRRORS: readonly LocalMirrorCandidate[] = [
  { name: '中科大', baseUrl: 'https://mirrors.ustc.edu.cn/node' },
  { name: '阿里', baseUrl: 'https://npmmirror.com/mirrors/node' },
  { name: '清华', baseUrl: 'https://mirrors.tuna.tsinghua.edu.cn/nodejs-release' },
  { name: '官方', baseUrl: 'https://nodejs.org/dist' },
];

/** Node 版本探测结果 */
export interface NodeVersionList {
  /** 可用版本列表（满足 dsh engines ^22.19.0 || >=24.0.0，按 semver 降序排列，最新在前；带 v 前缀） */
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
 * 需剥掉 `v` 再解析。过滤掉不满足 dsh engines `^22.19.0 || >=24.0.0`
 * 的版本（含 23.x 整条线与 22.18.x 及更早），剩余按 semver 降序排列
 * （最新在前），返回时还原 `v` 前缀。
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
    if (!meetsDshEngines(parts)) continue;
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
 * 提取各条目的 version 字段，过滤掉不满足 dsh engines `^22.19.0 || >=24.0.0`
 * 的版本（含 23.x 整条线与 22.18.x 及更早），按 semver 降序排列。
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

  // 2. 镜像竞速查询 Node 发行站 index.json
  const raced = await raceMirrors<unknown>(NODE_MIRRORS, '/index.json');
  if (raced === undefined) {
    // 全部镜像都失败——降级返回空列表
    return emptyResult();
  }
  const raw = raced.data;
  if (!Array.isArray(raw)) {
    log.warn('index.json 返回非数组');
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

/**
 * @file 本机 dsh 版本探测
 * @description 在 dsh 宿主进程（本机）直接 HTTP 查询 npm registry，拉取
 *              `@deepseek-ai/dsh` 的已发布版本列表，供面板版本下拉框填充。
 *              与 dsh-installer.ts 的 {@link resolveLatestDshVersion} 不同：
 *              那条路径在**远端**跑 `npm view`（安装期决策，有远端传输上下文）；
 *              本模块只在本机用 Node 原生 `fetch` 查 registry，不依赖任何远端
 *              传输——面板路由跑在 dsh 宿主进程里，没有 SSH 通道可用。
 *
 * 设计要点：
 * - **镜像竞速**：官方 npm registry 在中国大陆可能被墙或超时，并发请求
 *   阿里镜像与官方源，取首个成功的（{@link raceMirrors}），缓存选中镜像
 * - 进程内缓存（TTL 5 分钟）：面板每次打开都打 registry 太重，缓存窗口内
 *   复用上次结果；缓存失效由时间戳判定，不做主动失效
 * - 降级优先：registry 不可达、返回非 JSON、解析失败——一律返回空列表，
 *   不抛错；面板降级为空 datalist（用户仍可手动输入任意版本）
 * - 门槛过滤：只保留 major.minor >= 0.2.0 的版本（0.1.x 及更早不显示，
 *   避免用户选到已知有问题的旧版本）
 * - 复用 dsh-installer 的 semver 纯函数（parseSemver / compareSemver），
 *   保持版本解析逻辑单一定义
 */

import { createLogger } from '../util/logger.js';
import { compareSemver, parseSemver, type SemverParts } from './dsh-installer.js';
import { raceMirrors, type LocalMirrorCandidate } from './local-mirror-race.js';

/** 模块日志器（探测关键节点与失败告警） */
const log = createLogger('dsh-version-fetch');

/** 显示给用户的最小 major 版本（0.2.0 起的版本才进下拉列表） */
const MIN_DSH_MAJOR = 0;
/** 显示给用户的最小 minor 版本（major === MIN_DSH_MAJOR 时生效） */
const MIN_DSH_MINOR = 2;

/** 缓存有效期（毫秒）。面板高频打开，5 分钟窗口内复用上次查询结果 */
const CACHE_TTL_MS = 5 * 60 * 1_000;

/** npm registry 候选镜像（与 mirror-selector.ts 的 NPM_MIRRORS 对齐） */
const REGISTRY_MIRRORS: readonly LocalMirrorCandidate[] = [
  { name: '阿里', baseUrl: 'https://registry.npmmirror.com' },
  { name: '官方', baseUrl: 'https://registry.npmjs.org' },
];

/** 探测包名（与 dsh-installer 安装目标一致） */
const PACKAGE_NAME = '@deepseek-ai/dsh';

/** dsh 版本探测结果 */
export interface DshVersionList {
  /** 可用版本列表（major.minor >= 0.2.0，按 semver 降序排列，最新在前） */
  versions: string[];
  /** 最新版本（列表非空时为 versions[0]，即 semver 最大值；列表空时 undefined） */
  latest?: string;
}

/** 进程内缓存条目（带过期时间戳） */
interface CacheEntry {
  /** 缓存值 */
  list: DshVersionList;
  /** 缓存过期时间戳（epoch 毫秒） */
  expiresAt: number;
}

/** 进程内缓存（模块级单例；缓存窗口内复用上次查询结果） */
let cache: CacheEntry | undefined;

/**
 * 判断版本是否满足最低显示门槛（major.minor >= MIN_DSH_MAJOR.MIN_DSH_MINOR）。
 *
 * major > MIN_DSH_MAJOR 时直接通过（如 1.0.0）；major === MIN_DSH_MAJOR 时
 * 要求 minor >= MIN_DSH_MINOR（如 0.2.0 通过，0.1.x 不通过）。
 *
 * @param parts - 已解析的 semver 结构
 * @returns 满足门槛返回 true
 */
function meetsMinVersion(parts: SemverParts): boolean {
  if (parts.major > MIN_DSH_MAJOR) return true;
  if (parts.major < MIN_DSH_MAJOR) return false;
  return parts.minor >= MIN_DSH_MINOR;
}

/**
 * 从 registry packument 的 versions 对象提取版本号列表并按门槛过滤+降序排列。
 *
 * packument 的 `versions` 字段是一个以版本号为键的对象（值是版本元数据），
 * 这里只取键名。过滤掉不满足 semver 语法或低于 0.2.0 门槛的条目，剩余按
 * semver 降序排列（最新在前）。
 *
 * @param versionsField - packument 的 versions 字段（unknown，需校验形状）
 * @returns 过滤+排序后的版本号列表
 */
function filterAndSortVersions(versionsField: unknown): string[] {
  if (typeof versionsField !== 'object' || versionsField === null || Array.isArray(versionsField)) {
    return [];
  }
  // 只取键名（版本号），值忽略
  const raw = Object.keys(versionsField as Record<string, unknown>);
  // 解析 + 门槛过滤：用 SemverParts 保留解析结果避免二次 parse
  const parsed: Array<{ raw: string; parts: SemverParts }> = [];
  for (const candidate of raw) {
    const parts = parseSemver(candidate);
    if (parts === undefined) continue;
    if (!meetsMinVersion(parts)) continue;
    parsed.push({ raw: candidate, parts });
  }
  // 按 semver 降序排列（最新在前）
  parsed.sort((a, b) => compareSemver(b.parts, a.parts));
  return parsed.map(item => item.raw);
}

/**
 * 探测 npm registry 上 `@deepseek-ai/dsh` 的已发布版本列表。
 *
 * 查询 registry 的 packument 接口（`/<scope>%2F<name>`，npm 标准 packument
 * URL），提取 versions 键名，过滤掉低于 0.2.0 的版本，按 semver 降序排列。
 * 进程内缓存（5 分钟 TTL）避免面板每次打开都打 registry。
 *
 * **降级语义**：registry 不可达、超时、返回非 JSON、解析失败——一律返回
 * `{ versions: [], latest: undefined }`，不抛错。面板降级为空 datalist，
 * 用户仍可手动输入任意版本号（如 dist-tag `next` 或自定义版本）。
 *
 * @returns 版本列表与最新版本号；探测失败返回空列表
 */
export async function fetchDshVersions(): Promise<DshVersionList> {
  // 1. 缓存命中：未过期直接复用
  const now = Date.now();
  if (cache !== undefined && cache.expiresAt > now) {
    return cache.list;
  }

  // 2. 镜像竞速查询 registry packument
  //    packument URL 用 %2F 编码 scope 分隔符（npm 标准）
  const pathSuffix = `/${PACKAGE_NAME.replace('/', '%2F')}`;
  const raced = await raceMirrors<unknown>(REGISTRY_MIRRORS, pathSuffix);
  if (raced === undefined) {
    // 全部镜像都失败——降级返回空列表
    return emptyResult();
  }
  const packument = raced.data;
  if (typeof packument !== 'object' || packument === null || Array.isArray(packument)) {
    log.warn('registry 返回非对象 packument');
    return emptyResult();
  }
  const versions = filterAndSortVersions((packument as Record<string, unknown>).versions);

  // latest 取过滤后降序列表的首项（filterAndSortVersions 已按 semver 降序排列，
  // versions[0] 即为最大值，无需二次遍历解析）
  const latest = versions.length > 0 ? versions[0] : undefined;
  const result: DshVersionList = {
    versions,
    ...(latest !== undefined ? { latest } : {}),
  };
  cache = { list: result, expiresAt: now + CACHE_TTL_MS };
  log.info('dsh 版本探测成功', { count: versions.length, latest });
  return result;
}

/**
 * 构造空探测结果（降级用）。
 *
 * @returns 空版本列表
 */
function emptyResult(): DshVersionList {
  return { versions: [] };
}

/**
 * 清除进程内缓存（测试用；面板路由不需要主动调用）。
 */
export function clearDshVersionCache(): void {
  cache = undefined;
}

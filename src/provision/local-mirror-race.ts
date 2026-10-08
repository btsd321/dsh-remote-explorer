/**
 * @file 本机镜像竞速
 * @description 并发请求多个候选镜像，取第一个成功返回有效 JSON 的响应。
 *              供 dsh-version-fetch / node-version-fetch 复用——本机查 registry
 *              或发行站时，官方源在中国大陆可能被墙或超时，需要镜像源竞速
 *              自适应。
 *
 *              与 mirror-selector.ts 的 {@link selectMirror} 不同：那条路径
 *              在**远端**通过 SSH 通道跑 curl 测速（安装期决策，有远端传输
 *              上下文）；本模块只在本机用 Node 原生 `fetch` 竞速，不依赖
 *              任何远端传输——面板路由跑在 dsh 宿主进程里。
 *
 * 设计要点：
 * - **竞速而非逐个测速**：并发请求全部候选，取首个成功响应，未完成的自动
 *   abort。比逐个测速更快——用户只需等最快的镜像，不是最慢的
 * - **逐个超时**：每个候选独立超时（AbortSignal.timeout），不会因一个慢
 *   镜像拖住整体；整体超时兜底防止全部候选都卡住
 * - **进程内缓存选中镜像**：竞速有代价（并发请求），缓存选中镜像的 baseUrl，
 *   缓存窗口内直接用该镜像，不重复竞速
 */

import { createLogger } from '../util/logger.js';
import type { MirrorCandidate } from './mirror-selector.js';

/** 模块日志器（竞速关键节点与失败告警） */
const log = createLogger('local-mirror-race');

/** 单个候选镜像的查询超时（毫秒）：被墙的表现是卡住而非快速失败，要短 */
const PER_MIRROR_TIMEOUT_MS = 8_000;

/** 镜像选中结果的进程内缓存有效期（毫秒） */
const SELECTED_CACHE_TTL_MS = 5 * 60 * 1_000;

/** 选中镜像的缓存条目 */
interface SelectedCacheEntry {
  /** 选中的候选 */
  candidate: MirrorCandidate;
  /** 缓存过期时间戳（epoch 毫秒） */
  expiresAt: number;
}

/** 按候选列表缓存的选中镜像（key = 候选列表的 baseUrl 拼接签名） */
const selectedCache = new Map<string, SelectedCacheEntry>();

/**
 * 并发请求多个候选镜像，取第一个成功返回合法 JSON 的响应。
 *
 * 对每个候选构造 `baseUrl + pathSuffix` 的 URL 并发 fetch，首个返回 2xx
 * 且 body 能解析为 JSON 的候选胜出，其余请求 abort。进程内缓存选中镜像
 * （5 分钟 TTL），缓存窗口内直接用该镜像。
 *
 * 候选列表应由调用方从 {@link getCandidates} 获取（单一数据源），与远端
 * 测速 {@link selectMirror} 共用同一份镜像清单，避免两处手动复制。
 *
 * **降级语义**：全部候选都失败（不可达、超时、非 JSON）时返回 undefined，
 * 不抛错——调用方降级为空列表。
 *
 * @param candidates - 候选镜像列表（至少一个）
 * @param pathSuffix - URL 路径后缀（拼在 baseUrl 后，如 `/index.json`）
 * @returns 胜出候选的 baseUrl 与解析后的 JSON；全部失败时 undefined
 */
export async function raceMirrors<T>(
  candidates: readonly MirrorCandidate[],
  pathSuffix: string,
): Promise<{ baseUrl: string; data: T } | undefined> {
  if (candidates.length === 0) return undefined;

  // 1. 缓存命中：候选列表签名匹配且未过期
  const cacheKey = candidates.map(c => c.baseUrl).join('|');
  const cached = selectedCache.get(cacheKey);
  if (cached !== undefined && cached.expiresAt > Date.now()) {
    // 缓存了选中镜像，直接用它查（不走竞速，但仍有一道单次请求超时）
    const url = `${cached.candidate.baseUrl.replace(/\/+$/, '')}${pathSuffix}`;
    try {
      const data = await fetchJson<T>(url);
      return { baseUrl: cached.candidate.baseUrl, data };
    } catch (error) {
      // 缓存的镜像这次失败了——清除缓存，走竞速重试
      selectedCache.delete(cacheKey);
      const msg = error instanceof Error ? error.message : String(error);
      log.warn('缓存镜像查询失败，清除缓存走竞速', { mirror: cached.candidate.name, url, error: msg });
    }
  }

  // 2. 并发竞速：全部候选同时请求，取首个成功的
  const controller = new AbortController();
  const tasks = candidates.map(async (candidate) => {
    const url = `${candidate.baseUrl.replace(/\/+$/, '')}${pathSuffix}`;
    try {
      // 每个候选独立超时 + 共享 abort（胜出者触发 abort 其余）
      const timeoutSignal = AbortSignal.timeout(PER_MIRROR_TIMEOUT_MS);
      // 合并自身超时与竞速 abort 信号
      const signals = [controller.signal, timeoutSignal];
      const combinedSignal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);
      const response = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: combinedSignal,
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const data = await response.json() as T;
      return { candidate, data, url };
    } catch (error) {
      // 失败一律 reject（Promise.any 会忽略 reject 继续等其他候选）。
      // 预期的 abort（竞速败者）不报 warn——只有真正的失败才记日志
      if (!controller.signal.aborted) {
        const msg = error instanceof Error ? error.message : String(error);
        log.warn('镜像查询失败', { mirror: candidate.name, url, error: msg });
      }
      throw error;
    }
  });

  // 真正的竞速：用 Promise.any 取首个 resolve（成功）的候选。
  // 不能用 for...of 顺序 await——那会按数组顺序阻塞，首候选慢（超时 8s）
  // 时即使后续候选早已成功（0.5s）也要干等首候选落定，违背竞速语义。
  // 全部 reject 时 Promise.any 抛 AggregateError，降级返回 undefined。
  try {
    const winner = await Promise.any(tasks);
    // 胜出：abort 其余请求 + 缓存选中镜像
    controller.abort();
    selectedCache.set(cacheKey, {
      candidate: winner.candidate,
      expiresAt: Date.now() + SELECTED_CACHE_TTL_MS,
    });
    log.info('镜像竞速选中', { mirror: winner.candidate.name, url: winner.url });
    return { baseUrl: winner.candidate.baseUrl, data: winner.data };
  } catch {
    // 全部候选都 reject——降级返回 undefined
  }

  // 全部失败
  log.warn('全部镜像查询失败，返回 undefined');
  return undefined;
}

/**
 * 单次 fetch + JSON 解析。
 *
 * @param url - 完整 URL
 * @returns 解析后的 JSON
 * @throws Error 非 2xx 或解析失败
 */
async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(PER_MIRROR_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return await response.json() as T;
}

/**
 * 清除全部镜像竞速缓存（测试用）。
 */
export function clearLocalMirrorCache(): void {
  selectedCache.clear();
}

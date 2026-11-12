/**
 * @file 代理路由匹配与上游 URL 换算（纯函数）
 * @description 反向隧道代理的路径换算唯一实现：按最长前缀选中供应商路由，
 *              再把远端请求路径换算成上游 URL。
 *
 * 路径换算契约（最容易写错的地方，写成空串会静默把前缀吃掉）：
 * - `route.prefix` 是**远端侧**前缀（远端 baseURL 的路径部分，如 `/api/v0`）
 * - `route.upstreamPath` 是**上游侧**替换目标；上游 URL = upstreamOrigin +
 *   upstreamPath + 前缀之后的剩余子路径 + 查询串
 * - 因此「远端与前缀同路径」的路由（DeepSeek 原生通道 `/anthropic`、平台通道
 *   `/auth-api`、`/api/v0`、通知通道 `/api/v0/users/notifications`）必须把
 *   upstreamPath 写成与 prefix 同值——写成空串会让上游收到缺少前缀的路径
 *   （如 `https://platform.deepseek.com/users/get_user_summary`），站点回落到
 *   SPA HTML，dsh 侧按 JSON 信封解析失败：表现为账号资料/余额加载失败。
 *
 * 分层约束：本文件属能力层（credential/），只依赖同层类型，零 IO。
 */

import type { ProxyRoute } from './provider-routes.js';

/**
 * 按最长前缀匹配路由。
 *
 * 最长前缀优先而不是注册顺序：`/api/v0/users/notifications`（通知，
 * harnessOrigin）必须压过 `/api/v0`（平台），否则通知请求会被送去平台站点。
 *
 * @param routes - 路由表
 * @param path - 请求路径（不含查询串）
 * @returns 匹配的路由；无匹配时 undefined
 */
export function matchRoute(routes: readonly ProxyRoute[], path: string): ProxyRoute | undefined {
  let best: ProxyRoute | undefined;
  for (const route of routes) {
    if (path !== route.prefix && !path.startsWith(`${route.prefix}/`)) continue;
    if (best === undefined || route.prefix.length > best.prefix.length) best = route;
  }
  return best;
}

/**
 * 把远端请求路径换算成上游 URL。
 *
 * 前缀之后的子路径原样保留（含前导斜杠），查询串原样追加。
 *
 * @param route - 命中的路由
 * @param path - 请求路径（不含查询串，已确认以 route.prefix 开头）
 * @param query - 查询串（含前导 `?`；无查询串时为空串）
 * @returns 上游 URL
 */
export function buildUpstreamUrl(route: ProxyRoute, path: string, query: string): string {
  const subPath = path.slice(route.prefix.length);
  return `${route.upstreamOrigin}${route.upstreamPath}${subPath}${query}`;
}

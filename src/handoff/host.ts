/**
 * @file handoff bundle 宿主半（运行在远端 dsh 进程内）
 * @description 引导期被写进会话 profile 的合成包 `dsh-remote-handoff` 的宿主入口：
 *              在远端 dsh 的已鉴权通道上注册同源路由 `/api/dsh-remote-handoff/*`，
 *              把远端页面的管理请求经**既有反向隧道**回调本机监督器：
 *
 * ```
 * 远端页面 ──同源 Cookie 鉴权──▶ 本模块路由 ──Bearer 代理令牌──▶
 *   127.0.0.1:<反向端口>/manage/* （本机反向代理，令牌闸门）──进程内──▶ 监督器
 * ```
 *
 * 反向端口与代理令牌从会话 `.runtime/` 落盘材料读（本进程 DSH_HOME 即会话目录，
 * 材料在远端 dsh 启动前已写好，权限 600 与本进程同用户）。读不到=材料缺失，
 * 路由返回 503 让远端菜单优雅降级，不影响远端 dsh 本体。
 *
 * 凭据纪律：令牌只进请求头、不进任何日志与错误消息。
 */

import { readFileSync } from 'node:fs';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-connection/client';
import { HANDOFF_ROUTE_PREFIX, MANAGE_PREFIX } from './protocol.js';

/** 管理回调的超时（反向隧道在本机回环对接，正常毫秒级） */
const MANAGE_TIMEOUT_MS = 5_000;

/** 会话运行时材料（反向端口 + 代理令牌）的缓存 */
interface ReverseMaterials {
  reversePort: number;
  proxyToken: string;
}

export const name = 'dsh-remote-handoff';

/** 只需要 connection 服务（已鉴权 fetch 通道） */
export const inject = ['connection'];

/**
 * bundle 激活入口。
 *
 * @param ctx - 远端 dsh 的 cordis 上下文
 */
export function apply(ctx: Context): void {
  ctx.inject(['connection'], (inner) => {
    const disposers = buildRoutes().map(route => inner.connection.fetch.register({
      path: route.path,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: route.fetch,
    }));
    inner.effect(() => () => {
      for (const dispose of disposers) void dispose();
    }, 'dsh-remote-handoff.fetch-routes');
  });
}

/** 一条路由定义（与本机面板路由同形状） */
interface RouteDef {
  path: string;
  fetch: (request: Request) => Promise<Response>;
}

/**
 * 构造路由表：三个操作都是「校验材料 → 反向回调 → 透传 JSON」。
 *
 * @returns 路由定义列表
 */
function buildRoutes(): RouteDef[] {
  const via = async (op: 'state' | 'log' | 'meta', request: Request): Promise<Response> => {
    const params = new URL(request.url).searchParams;
    const query = new URLSearchParams();
    const id = params.get('id');
    if (op !== 'meta') {
      if (id === null || id === '') return json({ code: 'bad_usage', message: '缺少 id 参数' }, 400);
      query.set('id', id);
    }
    if (op === 'log') query.set('since', params.get('since') ?? '0');
    return callManage(op, query);
  };
  return [
    { path: `${HANDOFF_ROUTE_PREFIX}/meta`, fetch: async req => via('meta', req) },
    { path: `${HANDOFF_ROUTE_PREFIX}/state`, fetch: async req => via('state', req) },
    { path: `${HANDOFF_ROUTE_PREFIX}/log`, fetch: async req => via('log', req) },
  ];
}

/**
 * 经反向隧道回调本机管理路由并透传 JSON 响应。
 *
 * @param op - 管理操作名
 * @param query - 查询参数（id/since）
 * @returns 本机响应原样透传；材料缺失 503、本机不可达 502
 */
async function callManage(op: string, query: URLSearchParams): Promise<Response> {
  const materials = readMaterials();
  if (materials === undefined) {
    return json(
      { code: 'handoff_unavailable', message: '会话运行时材料缺失（反向端口/代理令牌读不到）' },
      503,
    );
  }
  try {
    const upstream = await fetch(
      `http://127.0.0.1:${materials.reversePort}${MANAGE_PREFIX}/${op}?${query.toString()}`,
      {
        headers: { authorization: `Bearer ${materials.proxyToken}` },
        signal: AbortSignal.timeout(MANAGE_TIMEOUT_MS),
      },
    );
    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  } catch {
    // 本机代理不在（CLI 已退出/反向隧道断开）：远端菜单据此提示，不重试轰炸
    return json(
      { code: 'manager_unreachable', message: '本机管理通道不可达（本地 dsh 可能已退出）' },
      502,
    );
  }
}

/**
 * 读会话运行时材料（DSH_HOME 即会话目录；材料启动前已落盘）。
 *
 * @returns 材料；读不到或格式异常时 undefined
 */
function readMaterials(): ReverseMaterials | undefined {
  const home = process.env.DSH_HOME;
  if (home === undefined || home === '') return undefined;
  try {
    const port = Number.parseInt(readFileSync(`${home}/.runtime/reverse-port`, 'utf8').trim(), 10);
    const token = readFileSync(`${home}/.runtime/proxy-token`, 'utf8').trim();
    if (!Number.isFinite(port) || port <= 0 || token === '') return undefined;
    return { reversePort: port, proxyToken: token };
  } catch {
    return undefined;
  }
}

/**
 * JSON 响应快捷构造。
 *
 * @param body - 可序列化对象
 * @param status - 状态码
 * @returns 响应
 */
function json(body: unknown, status: number): Response {
  return Response.json(body, { status });
}

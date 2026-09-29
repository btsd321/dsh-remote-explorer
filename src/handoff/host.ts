/**
 * @file handoff bundle 宿主半（运行在远端 dsh 进程内）
 * @description 引导期被写进会话 profile 的合成包 `dsh-remote-handoff` 的宿主入口：
 *              在远端 dsh 的已鉴权通道上注册同源路由 `/api/dsh-remote-handoff/*`，
 *              把远端页面的管理请求经**既有反向隧道**回调本机监督器：
 *
 * ```
 * 远端页面 ──同源 Cookie 鉴权──▶ 本模块路由 ──Bearer 代理令牌──▶
 *   <反向主机>:<反向端口>/manage/* （本机反向代理，令牌闸门）──进程内──▶ 监督器
 * ```
 *
 * 反向端点（主机 + 端口）与代理令牌从会话 `.runtime/` 落盘材料读（本进程
 * DSH_HOME 即会话目录，材料在远端 dsh 启动前已写好，权限 600 与本进程同用户）。
 * 主机地址来自 `.runtime/reverse-host`——本机在每次连接时重写，WSL NAT 网络
 * 模式下是 NAT 网关侧的本机地址（如 172.30.96.1），mirrored/SSH 场景通常就是
 * 127.0.0.1；**文件缺失/为空/读异常一律回落 127.0.0.1**（硬性向后兼容契约：
 * 旧远端材料与 SSH 会话没有这个文件也必须照常工作）。端口与令牌读不到才是
 * 材料缺失，路由返回 503 让远端菜单优雅降级，不影响远端 dsh 本体。
 *
 * 凭据纪律：令牌只进请求头、不进任何日志与错误消息。
 */

import { readFileSync } from 'node:fs';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-connection/client';
import { HANDOFF_PROTOCOL_VERSION, HANDOFF_ROUTE_PREFIX, MANAGE_PREFIX } from './protocol.js';

/** 管理回调的超时（反向隧道在本机回环对接，正常毫秒级） */
const MANAGE_TIMEOUT_MS = 5_000;

/**
 * 反向端点主机地址的回落值。
 *
 * `.runtime/reverse-host` 缺失/为空/读异常时的缺省（旧远端材料、SSH 会话
 * 天然落在这里）——回落是硬性向后兼容契约，材料缺失绝不能升级成 503。
 */
const DEFAULT_REVERSE_HOST = '127.0.0.1';

/**
 * 会话运行时材料（反向端点 + 代理令牌）的形状。
 *
 * 注意不是缓存：`callManage` 每次现读——`reverse-host` 会被本机在每次连接时
 * 重写（WSL NAT 网关 IP 可能变化），缓存会让复用会话拿到过期地址。
 */
interface ReverseMaterials {
  /** 回调主机地址：`.runtime/reverse-host` 内容（NAT 网关 IP 或 127.0.0.1） */
  reverseHost: string;
  /** 反向端口：一经启用随会话固定；复用会话时读回落盘值，不重新生成 */
  reversePort: number;
  /** 代理令牌（只进请求头，绝不进日志与错误消息） */
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
  // 激活日志，对齐远端 dsh 里 dsh-oh-my-terminal 的做法（形如
  // `[terminal-host] 宿主半已激活；路由前缀 ...`）：走 cordis 的 logger 设施
  // ——ctx.logger 是 Context 的内建服务属性而非可选注入，远端 dsh 自带的
  // cordis 均提供；本 bundle 是独立自包含单文件（构建期内联进宿主半），
  // import 不了仓库的 createLogger，只能就地取 ctx 的日志能力。
  // 这是诊断「宿主半到底有没有加载」的关键探针：路由实际注册在下方
  // connection 注入回调内（服务就绪才挂），本日志打在 apply 顶部——
  // bundle 一被加载即留痕，即使 connection 迟迟不就绪也能定位到这一层。
  // 内容含路由前缀、反向端点（host:port 激活时刻快照，之后每次回调现读，
  // 因为 reverse-host 会被本机重写；**绝不打印令牌**）与协议版本。
  const materials = readMaterials();
  ctx.logger(name).info(
    `宿主半已激活；路由前缀 ${HANDOFF_ROUTE_PREFIX}；反向端点 ${
      materials === undefined
        ? '未知（端口/令牌材料缺失，回调时 503）'
        : `${materials.reverseHost}:${materials.reversePort}`
    }；协议版本 ${HANDOFF_PROTOCOL_VERSION}`,
  );
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
      `http://${materials.reverseHost}:${materials.reversePort}${MANAGE_PREFIX}/${op}?${query.toString()}`,
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
 * 每次现读、不缓存：`reverse-host` 会被本机在每次连接时重写，缓存会让
 * 复用会话（远端 dsh 存活、本机重连）拿到过期的 NAT 网关地址。
 *
 * @returns 材料；端口/令牌读不到或格式异常时 undefined（反向主机地址不参与
 *          判缺——它有 127.0.0.1 回落，见 {@link readReverseHost}）
 */
function readMaterials(): ReverseMaterials | undefined {
  const home = process.env.DSH_HOME;
  if (home === undefined || home === '') return undefined;
  try {
    const port = Number.parseInt(readFileSync(`${home}/.runtime/reverse-port`, 'utf8').trim(), 10);
    const token = readFileSync(`${home}/.runtime/proxy-token`, 'utf8').trim();
    if (!Number.isFinite(port) || port <= 0 || token === '') return undefined;
    return { reverseHost: readReverseHost(home), reversePort: port, proxyToken: token };
  } catch {
    return undefined;
  }
}

/**
 * 读反向端点回调主机地址（`.runtime/reverse-host`）。
 *
 * 契约：文件由本机在**每次连接**时重写——WSL NAT 网络模式写 NAT 网关侧的
 * 本机地址（如 172.30.96.1），mirrored/SSH 场景通常就是 127.0.0.1。
 * 文件可能不存在（并行实现之前的旧会话材料）。**缺失、为空或读取异常一律
 * 回落 127.0.0.1**——这是硬性向后兼容契约：旧远端材料与 SSH 会话没有这个
 * 文件也必须照常工作，绝不能让缺文件把材料判成缺失（503）。
 * 校验从宽：trim 后非空字符串即接受（内容来自本机写入，不是用户输入）。
 *
 * 路径硬编码与 src/provision/remote-paths.ts 的 sessionReverseHostFile 对齐
 * （与 reverse-port/proxy-token 同款写法）：本文件被打成独立自包含 bundle
 * （构建期内联进宿主半），不能 import 仓库其他模块取常量。
 *
 * @param home - 会话 DSH_HOME 目录（已判非空）
 * @returns 回调主机地址；缺省回落 127.0.0.1
 */
function readReverseHost(home: string): string {
  try {
    const host = readFileSync(`${home}/.runtime/reverse-host`, 'utf8').trim();
    return host === '' ? DEFAULT_REVERSE_HOST : host;
  } catch {
    // 文件不存在（旧远端材料/SSH 会话）或读取异常：回落回环——硬性兼容契约，
    // 缺文件绝不连累端口/令牌材料（不能让缺它把材料判成缺失、回调 503）
    return DEFAULT_REVERSE_HOST;
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

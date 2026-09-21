/**
 * @file 面板 /api 路由注册
 * @description Web 管理面板的宿主侧数据源。所有路由挂在 connection 服务的
 *              `/api` 已鉴权通道上（Host/Origin 栅栏 403 + 浏览器令牌/Cookie
 *              认证 401），**不注册裸 webServer 路由**——裸路由无任何鉴权，
 *              宿主若配 0.0.0.0 会把会话元数据与写操作暴露到全网卡。
 *
 * 冒烟判读：不带凭据 curl `/api/dsh-remote-explorer/ping` 得 **401** = 路由已
 * 注册且受保护；404 = 插件没挂上或 connection 服务缺席。
 *
 * connection 是反应式注入（ctx.inject）：它可能晚于本插件到达，绝不让面板
 * 路由阻塞插件激活；纯 headless 组合没有该服务，回调永不执行，自然降级。
 *
 * 凭据纪律：/connect 的 password 字段只进本进程内存（透传 openSession 的
 * fixed 模式），不落盘、不进日志缓冲、不出现在任何响应里。
 */

import type { Context } from '@deepseek-ai/cordis';
// 仅为激活 ctx.connection 的模块类型增广（HostConnectionHandle），不产生运行时代码
import type {} from '@deepseek-ai/dsh-client-connection';
import { listHosts, refreshConfig } from '../hosts/ssh-config-parser.js';
import { toErrorMessage } from '../util/errors.js';
import { SessionSupervisor, SupervisorError, type ConnectRequest, type SessionSnapshot } from './supervisor.js';

/**
 * 构建期注入的包版本号（scripts/build-plugin.ts 的 esbuild define）。
 * 插件只以 bundle 形态运行，不存在 tsx 直跑本文件的路径。
 */
declare const __PLUGIN_VERSION__: string;

/** 面板路由统一前缀（scripts/check-plugin.ts 强制所有路由挂在此前缀下） */
export const ROUTE_PREFIX = '/api/dsh-remote-explorer';

/** 一条路由定义 */
interface RouteDef {
  /** 完整路径（含前缀） */
  path: string;
  /** 允许的方法 */
  methods: ('GET' | 'POST')[];
  /** 处理器（已通过鉴权） */
  fetch: (request: Request) => Promise<Response>;
}

/**
 * 注册面板路由。
 *
 * @param ctx - 插件上下文
 * @param supervisor - 会话监督器
 */
export function registerPanelRoutes(ctx: Context, supervisor: SessionSupervisor): void {
  ctx.inject(['connection'], (inner) => {
    const disposers = buildRoutes(supervisor).map(route => inner.connection.fetch.register({
      path: route.path,
      methods: route.methods,
      requestBody: 'buffered',
      fetch: route.fetch,
    }));
    // register 返回异步 disposer；effect 清理函数里逐个触发，
    // fiber 卸载路径会 await 清理函数返回的 promise
    inner.effect(() => () => {
      for (const dispose of disposers) void dispose();
    }, 'dsh-remote-explorer.fetch-routes');
  });
}

/**
 * 构造路由表。
 *
 * @param supervisor - 会话监督器
 * @returns 路由定义列表
 */
function buildRoutes(supervisor: SessionSupervisor): RouteDef[] {
  return [
    {
      // 冒烟探针：401 = 已注册且受鉴权保护
      path: `${ROUTE_PREFIX}/ping`,
      methods: ['GET'],
      fetch: async () => Response.json({ ok: true, version: __PLUGIN_VERSION__ }),
    },
    {
      path: `${ROUTE_PREFIX}/hosts`,
      methods: ['GET'],
      fetch: async (request) => {
        try {
          // 面板的「刷新」按钮带 ?refresh=1；长驻进程里 config 可能随时被改
          if (new URL(request.url).searchParams.get('refresh') === '1') refreshConfig();
          return Response.json({ hosts: listHosts() });
        } catch (error) {
          return internalError(error);
        }
      },
    },
    {
      path: `${ROUTE_PREFIX}/sessions`,
      methods: ['GET'],
      fetch: async () => Response.json({ sessions: supervisor.list().map(toPanelSession) }),
    },
    {
      // 单会话详情 + 增量日志（面板 1.5s 轮询 ?id=<会话id>&since=<seq>）
      path: `${ROUTE_PREFIX}/session`,
      methods: ['GET'],
      fetch: async (request) => {
        const params = new URL(request.url).searchParams;
        const id = params.get('id') ?? '';
        const since = Number.parseInt(params.get('since') ?? '0', 10);
        const log = supervisor.getLog(id, Number.isFinite(since) ? since : 0);
        if (log === undefined) {
          return Response.json({ error: `没有会话 ${id}` }, { status: 404 });
        }
        const snapshot = supervisor.list().find(item => item.sessionId === id);
        return Response.json({
          ...(snapshot !== undefined ? { session: toPanelSession(snapshot) } : {}),
          log,
        });
      },
    },
    {
      path: `${ROUTE_PREFIX}/connect`,
      methods: ['POST'],
      fetch: async (request) => {
        try {
          const body = await readJsonBody(request);
          const hostAlias = stringField(body, 'hostAlias');
          if (hostAlias === undefined) {
            return Response.json({ code: 'bad_usage', message: '缺少 hostAlias 字段' }, { status: 400 });
          }
          const connectRequest: ConnectRequest = {
            hostAlias,
            ...(stringField(body, 'cwd') !== undefined ? { cwd: stringField(body, 'cwd') } : {}),
            ...(stringField(body, 'password') !== undefined ? { password: stringField(body, 'password') } : {}),
            ...(stringField(body, 'privateKey') !== undefined ? { privateKey: stringField(body, 'privateKey') } : {}),
            ...(numberField(body, 'localPort') !== undefined ? { localPort: numberField(body, 'localPort') } : {}),
            ...(booleanField(body, 'forceRestart') !== undefined ? { forceRestart: booleanField(body, 'forceRestart') } : {}),
            ...(booleanField(body, 'refreshMirrors') !== undefined ? { refreshMirrors: booleanField(body, 'refreshMirrors') } : {}),
            ...(stringField(body, 'nodeVersion') !== undefined ? { nodeVersion: stringField(body, 'nodeVersion') } : {}),
            ...(stringField(body, 'dshVersion') !== undefined ? { dshVersion: stringField(body, 'dshVersion') } : {}),
          };
          const snapshot = supervisor.startConnect(connectRequest);
          return Response.json({ ok: true, session: toPanelSession(snapshot) });
        } catch (error) {
          return supervisorError(error);
        }
      },
    },
    {
      path: `${ROUTE_PREFIX}/disconnect`,
      methods: ['POST'],
      fetch: async (request) => {
        try {
          const body = await readJsonBody(request);
          const target = stringField(body, 'target');
          if (target === undefined) {
            return Response.json({ code: 'bad_usage', message: '缺少 target 字段' }, { status: 400 });
          }
          // 默认连远端一起停（对齐 CLI Ctrl-C 语义）；面板勾选项传 stopRemote:false 保留
          const stopRemote = booleanField(body, 'stopRemote') ?? true;
          const sessionId = await supervisor.disconnect(target, stopRemote);
          return Response.json({ ok: true, sessionId, remoteStopped: stopRemote });
        } catch (error) {
          return supervisorError(error);
        }
      },
    },
  ];
}

/**
 * 把监督器快照压成面板出参（去掉日志尾部——详情走 /session 增量接口）。
 *
 * @param snapshot - 会话快照
 * @returns 面板会话对象
 */
function toPanelSession(snapshot: SessionSnapshot): Record<string, unknown> {
  const { logTail: _logTail, ...rest } = snapshot;
  return { ...rest };
}

/**
 * 解析 JSON 请求体。
 *
 * @param request - 已通过鉴权的请求（buffered 模式）
 * @returns 字段字典
 * @throws SupervisorError('bad_usage') 请求体不是 JSON 对象
 */
async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await request.json();
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new SupervisorError('bad_usage', '请求体必须是 JSON 对象');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof SupervisorError) throw error;
    throw new SupervisorError('bad_usage', `请求体解析失败：${toErrorMessage(error)}`);
  }
}

/**
 * 读字符串字段。
 * @param body - 请求体
 * @param key - 字段名
 * @returns 非空字符串值；缺失或类型不对时 undefined
 */
function stringField(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * 读数字字段。
 * @param body - 请求体
 * @param key - 字段名
 * @returns 有限数字；缺失或类型不对时 undefined
 */
function numberField(body: Record<string, unknown>, key: string): number | undefined {
  const value = body[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * 读布尔字段。
 * @param body - 请求体
 * @param key - 字段名
 * @returns 布尔值；缺失或类型不对时 undefined
 */
function booleanField(body: Record<string, unknown>, key: string): boolean | undefined {
  const value = body[key];
  return typeof value === 'boolean' ? value : undefined;
}

/**
 * 把监督器错误映射为 HTTP 响应（code 语义 → 状态码）。
 *
 * @param error - 捕获的异常
 * @returns JSON 响应
 */
function supervisorError(error: unknown): Response {
  if (error instanceof SupervisorError) {
    const status = error.code === 'not_found' ? 404
      : error.code === 'already_active' || error.code === 'still_connecting' ? 409
        : error.code === 'external_session' ? 403
          : 400;
    return Response.json({ code: error.code, message: error.message }, { status });
  }
  return internalError(error);
}

/**
 * 未归类异常的 500 响应。
 *
 * @param error - 捕获的异常
 * @returns JSON 响应
 */
function internalError(error: unknown): Response {
  return Response.json({ code: 'internal', message: toErrorMessage(error) }, { status: 500 });
}

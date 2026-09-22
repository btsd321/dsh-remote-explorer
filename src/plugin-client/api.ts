/**
 * @file 面板与宿主 /api 路由的通信层
 * @description 同源 fetch：浏览器已持有 dsh 的会话 Cookie（HttpOnly +
 *              SameSite=Strict），/api 前缀自动过 connection 的信任栅栏与
 *              认证——本层不带任何令牌，也拿不到。
 *
 * 类型说明：SessionSnapshot/LogEntry/SshHostSummary 用 `import type` 从宿主
 * 模块引入——esbuild 打包时类型导入整体擦除，浏览器 bundle 不会拖进任何
 * Node 依赖，形状与宿主出参天然同步（改一处编译期就报）。
 */

import type { LogEntry, SessionSnapshot } from '../plugin/supervisor.js';
import type { SshHostSummary } from '../hosts/ssh-config-parser.js';

/** 宿主路由前缀（与 src/plugin/routes.ts 的 ROUTE_PREFIX 一致，check 脚本盯住宿主侧） */
const BASE = '/api/dsh-remote-explorer';

/** 面板会话对象：宿主快照去掉 logTail（日志走增量接口） */
export type PanelSession = Omit<SessionSnapshot, 'logTail'>;

/** 宿主路由返回的业务错误（HTTP 4xx/5xx，body 带 code/message） */
export class ApiError extends Error {
  /**
   * @param code - 宿主错误类别（bad_usage/invalid_cwd/already_active/not_found/…）
   * @param message - 中文消息
   * @param status - HTTP 状态码
   */
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * 发起一次 /api 请求并解析 JSON。
 *
 * @param path - 路由（不含前缀）
 * @param init - fetch 选项；query 直接拼在 path 上
 * @returns 解析后的 JSON
 * @throws ApiError 非 2xx（body 有 code/message 时透传，否则按状态码归类）
 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE}${path}`, init);
  if (!response.ok) {
    let code = 'http_error';
    let message = `HTTP ${response.status}`;
    try {
      const body = await response.json() as { code?: string; message?: string };
      if (typeof body.code === 'string') code = body.code;
      if (typeof body.message === 'string') message = body.message;
    } catch { /* 非 JSON 错误体，用状态码兜底 */ }
    throw new ApiError(code, message, response.status);
  }
  return await response.json() as T;
}

/**
 * 拉主机列表。
 *
 * @param refresh - true 时让宿主先重读 ~/.ssh/config
 * @returns 主机摘要列表
 */
export async function fetchHosts(refresh = false): Promise<SshHostSummary[]> {
  const result = await request<{ hosts: SshHostSummary[] }>(`/hosts${refresh ? '?refresh=1' : ''}`);
  return result.hosts;
}

/**
 * 拉会话列表（本进程 + 其他本机进程的只读视图）。
 *
 * @returns 面板会话列表
 */
export async function fetchSessions(): Promise<PanelSession[]> {
  const result = await request<{ sessions: PanelSession[] }>('/sessions');
  return result.sessions;
}

/**
 * 拉单会话详情与增量日志。
 *
 * @param sessionId - 会话 id
 * @param since - 已收到的最大日志 seq（返回其后的增量）
 * @returns 详情与日志；会话已消失时 session 为 undefined
 */
export async function fetchSessionLog(
  sessionId: string,
  since: number,
): Promise<{ session?: PanelSession; log: LogEntry[] }> {
  const params = new URLSearchParams({ id: sessionId, since: String(since) });
  return request<{ session?: PanelSession; log: LogEntry[] }>(`/session?${params.toString()}`);
}

/** 面板连接请求体（与宿主 /connect 的字段一致） */
export interface ConnectBody {
  /** 主机别名或 user@host[:port] */
  hostAlias: string;
  /** 远端目录；空串 = 家目录 */
  cwd?: string;
  /** SSH 密码（仅内存语义，见面板警示文案） */
  password?: string;
  /** 私钥路径 */
  privateKey?: string;
  /** 本机端口 */
  localPort?: number;
  /** 强制重启远端 dsh */
  forceRestart?: boolean;
  /** 重测镜像 */
  refreshMirrors?: boolean;
  /** Node 版本覆盖 */
  nodeVersion?: string;
  /** dsh 版本覆盖 */
  dshVersion?: string;
  /** 本机管理页 origin（location.origin）：远端 handoff 组件的返回动作依赖它 */
  managerUrl?: string;
}

/**
 * 发起连接（宿主立即返回，引导在后台跑）。
 *
 * @param body - 连接请求
 * @returns 目标会话的即时快照
 * @throws ApiError invalid_cwd / already_active 等
 */
export async function postConnect(body: ConnectBody): Promise<PanelSession> {
  const result = await request<{ ok: boolean; session: PanelSession }>('/connect', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return result.session;
}

/**
 * 断开会话。
 *
 * @param target - 会话 id 或主机别名
 * @param stopRemote - 是否连远端一起停
 * @throws ApiError not_found / still_connecting 等
 */
export async function postDisconnect(target: string, stopRemote: boolean): Promise<void> {
  await request<{ ok: boolean }>('/disconnect', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ target, stopRemote }),
  });
}

/** 远端插件清单项（与宿主半 supervisor 的 RemotePluginInfo 同形状） */
export interface RemotePluginInfo {
  /** 包名 */
  name: string;
  /** 已装版本 */
  version: string;
  /** 是否 bundle（声明 dsh.bundle.patch） */
  bundle: boolean;
  /** 是否启用中（在 bundles 列表） */
  enabled: boolean;
}

/**
 * 拉远端会话 profile 的插件清单。
 *
 * @param sessionId - 会话 id
 * @returns 清单
 */
export async function fetchRemotePlugins(sessionId: string): Promise<RemotePluginInfo[]> {
  const result = await request<{ plugins: RemotePluginInfo[] }>(
    `/remote-plugins?session=${encodeURIComponent(sessionId)}`,
  );
  return result.plugins;
}

/** 远端插件动作（install 需 spec；remove/toggle 需 name；toggle 另需 enabled） */
export type RemotePluginAction =
  | { action: 'install'; spec: string }
  | { action: 'remove'; name: string }
  | { action: 'toggle'; name: string; enabled: boolean };

/**
 * 执行远端插件动作（宿主半经会话 SSH 通道在远端 profile 内操作）。
 *
 * @param sessionId - 会话 id
 * @param op - 动作
 * @returns 动作后的清单
 */
export async function postRemotePluginAction(
  sessionId: string,
  op: RemotePluginAction,
): Promise<RemotePluginInfo[]> {
  const result = await request<{ plugins: RemotePluginInfo[] }>('/remote-plugins', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session: sessionId, ...op }),
  });
  return result.plugins;
}

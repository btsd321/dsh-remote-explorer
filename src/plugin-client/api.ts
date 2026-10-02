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
import type { StoredJumpEntry } from '../plugin/advanced-store.js';
import type { JumpEntry, SshHostSummary } from '../hosts/ssh-config-parser.js';

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
 * 把未知异常归一成展示文本。
 *
 * @param error - 捕获值
 * @returns 中文消息
 */
export function messageOf(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
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

/** WSL 发行版摘要（宿主半从 wsl --list --verbose 解析） */
export interface WslDistroSummary {
  /** 发行版名称（如 Ubuntu-24.04） */
  name: string;
  /** 运行状态（Running / Stopped 等原始值） */
  state: string;
  /** WSL 版本号（1 或 2） */
  version: number;
  /** 是否默认发行版 */
  isDefault: boolean;
}

/** 高级选项配置的读取形态（GET /advanced 出参，与宿主 advanced-store 同步） */
export interface AdvancedPayload {
  /** 注入远端 dsh 的用户环境变量 */
  env: Record<string, string>;
  /** 代理 URL；未配置时缺省 */
  proxy?: string;
  /** 直连主机跳板机条目（落盘子集，无密码）；未配置时缺省 */
  jumpHosts?: StoredJumpEntry[];
}

/**
 * 高级选项的保存形态（POST /advanced 入参）。**部分更新语义**：只需携带本
 * 弹窗的编辑面，缺省字段保持存储原值；显式空值 = 清除该字段（env 空对象 /
 * proxy 空串 / jumpHosts 空数组）
 */
export interface AdvancedSaveBody {
  /** 环境变量键值对（携带时整组替换） */
  env?: Record<string, string>;
  /** 代理 URL（空串 = 清除） */
  proxy?: string;
  /** 直连主机跳板机条目（落盘子集；空数组 = 清除） */
  jumpHosts?: StoredJumpEntry[];
}

/** 面板连接请求体（与宿主 /connect 的字段一致） */
export interface ConnectBody {
  /** 主机别名或 user@host[:port]（SSH 传输时必填） */
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
  /** 传输类型：ssh（默认）或 wsl */
  transportType?: 'ssh' | 'wsl';
  /** WSL 发行版名称（transportType='wsl' 时必填） */
  distroName?: string;
  /** WSL 用户名（留空 = 发行版默认用户） */
  wslUser?: string;
  /**
   * 直连主机的跳板机条目（弹窗保存后的完整快照，含内存态密码）。
   * 仅 user@host 直连主机生效；密码随本请求内存传递，绝不持久化
   */
  jumpHosts?: JumpEntry[];
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

/**
 * 拉高级选项配置（连接表单弹窗的「上一次输入」，**按传输形态分域**——SSH
 * 域三项 env/proxy/jumpHosts，WSL 域只有 env；域内不按主机区分）。
 *
 * @param transportType - 传输形态（域键）：'ssh' 读 SSH 域，'wsl' 读 WSL 域
 * @returns 配置（env 键值对、可选 proxy、可选跳板机条目；wsl 域只有 env）；
 *          未配置过返回空 env
 * @throws ApiError bad_usage / http_error
 */
export async function fetchAdvanced(transportType: 'ssh' | 'wsl'): Promise<AdvancedPayload> {
  return request<AdvancedPayload>(`/advanced?transportType=${transportType}`);
}

/**
 * 保存高级选项配置（存宿主侧 0600 文件，下一次连接时注入远端 dsh 进程）。
 *
 * POST 是**部分更新**语义（按域）：缺省字段保持该域存储原值（弹窗各管一个
 * 字段，互不清除对方）；显式空值 = 清除该字段（env 空对象 / proxy 空串 /
 * jumpHosts 空数组）。jumpHosts 只传落盘子集（target + identityFile）——
 * **密码绝不发往此接口**（宿主侧对带 password 的条目直接 400），密码只随
 * /connect 请求内存传递。transportType='wsl' 时 body 携带 proxy/jumpHosts
 * 会被宿主侧 400（WSL 仅支持环境变量）——浏览器半的 wsl 弹窗本就不带。
 *
 * @param transportType - 传输形态（域键）：'ssh' 写 SSH 域，'wsl' 写 WSL 域
 * @param payload - 待更新字段（只需携带本弹窗的编辑面）
 * @throws ApiError bad_usage（校验失败，中文消息透传到弹窗展示）
 */
export async function postAdvanced(
  transportType: 'ssh' | 'wsl',
  payload: AdvancedSaveBody,
): Promise<void> {
  await request<{ ok: true }>('/advanced', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ transportType, ...payload }),
  });
}

/**
 * 拉 WSL 发行版列表。
 *
 * @param refresh - true 时让宿主重新执行 wsl --list --verbose
 * @returns 发行版摘要列表
 */
export async function fetchWslDistros(refresh = false): Promise<WslDistroSummary[]> {
  const result = await request<{ distros: WslDistroSummary[] }>(
    `/wsl-distros${refresh ? '?refresh=1' : ''}`,
  );
  return result.distros;
}

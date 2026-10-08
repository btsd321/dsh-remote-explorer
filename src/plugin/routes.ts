/**
 * @file 面板 /api 路由注册
 * @description Web 管理面板的宿主侧数据源。所有路由挂在 connection 服务的
 *              `/api` 已鉴权通道上（Host/Origin 栅栏 403 + 浏览器令牌/Cookie
 *              认证 401），**不注册裸 webServer 路由**——裸路由无任何鉴权，
 *              宿主若配 0.0.0.0 会把会话元数据与写操作暴露到全网卡。
 *
 * 冒烟判读（实测修正）：不带凭据 curl `/api/dsh-remote-explorer/ping` 得 401
 * 只证明 /api 鉴权门在工作——对未注册路由同样 401，不能当挂载证据；带会话
 * Cookie 得 **200** 才是路由已注册的证明，带 Cookie 仍 404 = 插件没挂上
 * 或 connection 服务缺席。
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
import { listHosts, refreshConfig, type JumpEntry } from '../hosts/ssh-config-parser.js';
import { listWslDistros, refreshWslCache } from '../hosts/wsl-distro-parser.js';
import { fetchDshVersions } from '../provision/dsh-version-fetch.js';
import { toErrorMessage } from '../util/errors.js';
import { SessionSupervisor, SupervisorError, type ConnectRequest, type SessionSnapshot } from './supervisor.js';
import {
  readAdvancedConfig, validateAdvancedConfig, writeAdvancedConfig, type AdvancedConfig,
} from './advanced-store.js';

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
      // WSL 发行版列表：面板「新建 WSL 连接」下拉框的数据源
      path: `${ROUTE_PREFIX}/wsl-distros`,
      methods: ['GET'],
      fetch: async (request) => {
        try {
          // ?refresh=1 时刷新缓存（安装/卸载发行版后）
          if (new URL(request.url).searchParams.get('refresh') === '1') refreshWslCache();
          const distros = await listWslDistros();
          return Response.json({ distros });
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
      // dsh 已发布版本列表：面板版本下拉框的数据源（本机直接查 npm registry，
      // 不走远端——面板路由跑在 dsh 宿主进程，没有 SSH 通道）。探测失败由
      // fetchDshVersions 内部 catch 返回空列表（降级为空 datalist，用户仍可
      // 手动输入），不会抛错——此处无需 try/catch
      path: `${ROUTE_PREFIX}/dsh-versions`,
      methods: ['GET'],
      fetch: async () => Response.json(await fetchDshVersions()),
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
        // getLog 命中即证明会话在 supervisor 内存中，快照直接内存直查——
        // 不再经 list() 读会话表（readFileSync + JSON.parse + 逐条 pid 探活），
        // 该路由每 1.5s 轮询一次，读盘纯属浪费。快照缺失（已断开的会话）
        // 时保持降级：仍返回 log
        const snapshot = supervisor.snapshotById(id);
        return Response.json({
          ...(snapshot !== undefined ? { session: toPanelSession(snapshot) } : {}),
          log,
        });
      },
    },
    {
      // 高级选项配置（连接表单弹窗的「上一次输入」，本机
      // ~/.dsh/remote-advanced.json，**按传输形态分域**——SSH 域三项
      // env/proxy/jumpHosts，WSL 域只有 env；域内不按主机区分）：
      // GET 带 ?transportType=（缺省 'ssh'）读回该域 {env, proxy?, jumpHosts?}
      // （wsl 域只有 env）；POST body 带 transportType（缺省 'ssh'）部分
      // 更新对应域——**缺省字段保持域内原值**（弹窗各管一个字段，互不清除
      // 对方），显式空值 = 清除该字段（env 空对象 / proxy 空串 / jumpHosts
      // 空数组）。POST 目标为 wsl 域时 body 出现 proxy/jumpHosts → 400
      // （WSL 不支持这两项，仅环境变量）。
      // 值可能含代理认证信息——读写两侧都只打键名/字段名不打值
      path: `${ROUTE_PREFIX}/advanced`,
      methods: ['GET', 'POST'],
      fetch: async (request) => {
        try {
          if (request.method === 'GET') {
            const param = new URL(request.url).searchParams.get('transportType');
            if (param !== null && param !== 'ssh' && param !== 'wsl') {
              return Response.json(
                { code: 'bad_usage', message: `transportType 必须是 'ssh' 或 'wsl'，收到 '${param}'` },
                { status: 400 },
              );
            }
            return Response.json(readAdvancedConfig(param === 'wsl' ? 'wsl' : 'ssh'));
          }
          const body = await readJsonBody(request);
          // 传输形态（域键）：缺省 'ssh'；非法值 400
          const transportTypeRaw: unknown = body.transportType;
          let transportType: 'ssh' | 'wsl';
          switch (transportTypeRaw) {
            case 'wsl': transportType = 'wsl'; break;
            case 'ssh': case undefined: transportType = 'ssh'; break;
            default:
              return Response.json(
                { code: 'bad_usage', message: `transportType 必须是 'ssh' 或 'wsl'，收到 '${String(transportTypeRaw)}'` },
                { status: 400 },
              );
          }
          // 形状收窄：env 必须是对象且键值都是 string（语义校验交给 validateAdvancedConfig）
          const envRaw: unknown = body.env;
          if (envRaw !== undefined
            && (typeof envRaw !== 'object' || envRaw === null || Array.isArray(envRaw))) {
            return Response.json({ code: 'bad_usage', message: 'env 必须是对象' }, { status: 400 });
          }
          const env: Record<string, string> = {};
          if (envRaw !== undefined) {
            for (const [key, value] of Object.entries(envRaw as Record<string, unknown>)) {
              if (typeof value !== 'string') {
                return Response.json(
                  { code: 'bad_usage', message: `env['${key}'] 的值必须是字符串` },
                  { status: 400 },
                );
              }
              env[key] = value;
            }
          }
          // proxy/jumpHosts 可选；类型不对返回 400。jumpHosts 是落盘子集
          // （target + identityFile），带 password 字段的条目会被
          // validateAdvancedConfig 拒绝——密码只经连接请求内存传递
          const proxyRaw: unknown = body.proxy;
          if (proxyRaw !== undefined && typeof proxyRaw !== 'string') {
            return Response.json({ code: 'bad_usage', message: 'proxy 必须是字符串' }, { status: 400 });
          }
          const jumpRaw: unknown = body.jumpHosts;
          if (jumpRaw !== undefined
            && (!Array.isArray(jumpRaw)
              || jumpRaw.some(item => typeof item !== 'object' || item === null || Array.isArray(item)))) {
            return Response.json(
              { code: 'bad_usage', message: 'jumpHosts 必须是对象数组（每条含 target 字段）' },
              { status: 400 },
            );
          }
          // WSL 域只有 env：body 出现 proxy/jumpHosts 一律 400（域契约，
          // 存储层写侧还有一道防御性抛错）
          if (transportType === 'wsl' && (proxyRaw !== undefined || jumpRaw !== undefined)) {
            return Response.json(
              { code: 'bad_usage', message: 'WSL 连接不支持代理/跳板机配置，仅支持环境变量' },
              { status: 400 },
            );
          }
          // 部分更新合并（按域）：缺省字段沿用当前域存储值；显式空值（'' / []）按清除
          const current = readAdvancedConfig(transportType);
          const merged: AdvancedConfig = {
            env: envRaw !== undefined ? env : current.env,
            ...(proxyRaw !== undefined && proxyRaw !== '' ? { proxy: proxyRaw } : {}),
            ...(jumpRaw !== undefined && jumpRaw.length > 0 ? { jumpHosts: jumpRaw } : {}),
          };
          const validation = validateAdvancedConfig(merged);
          if (validation !== undefined) {
            return Response.json({ code: 'bad_usage', message: validation }, { status: 400 });
          }
          writeAdvancedConfig(transportType, merged);
          return Response.json({ ok: true });
        } catch (error) {
          return supervisorError(error);
        }
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
          // 传输类型校验：只接受已知值，未知值返回 400。
          // 新增传输类型时在此添加 case
          const transportTypeRaw = stringField(body, 'transportType');
          let transportType: 'ssh' | 'wsl';
          switch (transportTypeRaw) {
            case 'wsl': transportType = 'wsl'; break;
            case 'ssh': case undefined: transportType = 'ssh'; break;
            default:
              return Response.json(
                { code: 'bad_usage', message: `transportType 必须是 'ssh' 或 'wsl'，收到 '${transportTypeRaw}'` },
                { status: 400 },
              );
          }
          const distroName = stringField(body, 'distroName');
          if (transportType === 'wsl' && distroName === undefined) {
            return Response.json(
              { code: 'bad_usage', message: 'transportType=wsl 时 distroName 必填' },
              { status: 400 },
            );
          }
          const connectRequest: ConnectRequest = {
            hostAlias,
            transportType,
            ...(distroName !== undefined ? { distroName } : {}),
            ...(stringField(body, 'wslUser') !== undefined ? { wslUser: stringField(body, 'wslUser') } : {}),
            ...(stringField(body, 'cwd') !== undefined ? { cwd: stringField(body, 'cwd') } : {}),
            ...(stringField(body, 'password') !== undefined ? { password: stringField(body, 'password') } : {}),
            ...(stringField(body, 'privateKey') !== undefined ? { privateKey: stringField(body, 'privateKey') } : {}),
            ...(numberField(body, 'localPort') !== undefined ? { localPort: numberField(body, 'localPort') } : {}),
            ...(booleanField(body, 'forceRestart') !== undefined ? { forceRestart: booleanField(body, 'forceRestart') } : {}),
            ...(booleanField(body, 'refreshMirrors') !== undefined ? { refreshMirrors: booleanField(body, 'refreshMirrors') } : {}),
            ...(stringField(body, 'nodeVersion') !== undefined ? { nodeVersion: stringField(body, 'nodeVersion') } : {}),
            ...(stringField(body, 'dshVersion') !== undefined ? { dshVersion: stringField(body, 'dshVersion') } : {}),
            // 跳板机条目（面板跳板机弹窗保存后的完整快照；含内存态密码，
            // 绝不落盘——advanced store 只持久化 target/identityFile 子集）。
            // 深校验（条目可解析性）由连接时的 resolveJumpChain 负责
            ...(parseJumpEntries(body.jumpHosts) !== undefined
              ? { jumpHosts: parseJumpEntries(body.jumpHosts) }
              : {}),
            // 管理页 origin：面板带 location.origin，供远端 handoff 组件
            // 渲染「返回/关闭并返回」动作；CLI/命令发起不带，远端菜单只读
            ...(stringField(body, 'managerUrl') !== undefined ? { managerUrl: stringField(body, 'managerUrl') } : {}),
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
 * 解析 /connect 请求的跳板机条目（完整快照：target + 可选认证覆盖，含
 * 内存态密码）。形状不对返回 undefined（视为未携带，不报错——面板之外
 * 的入口本就不带）；深校验（条目可解析性）由连接时的 resolveJumpChain
 * 负责，坏条目以带定位的连接错误暴露。
 *
 * @param raw - 请求体的 jumpHosts 字段（unknown）
 * @returns 合法形状的条目数组；字段缺失或形状不对时 undefined
 */
function parseJumpEntries(raw: unknown): JumpEntry[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const entries: JumpEntry[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return undefined;
    const record = item as Record<string, unknown>;
    if (typeof record.target !== 'string' || record.target === '') return undefined;
    if (record.identityFile !== undefined && typeof record.identityFile !== 'string') return undefined;
    if (record.password !== undefined && typeof record.password !== 'string') return undefined;
    entries.push({
      target: record.target,
      ...(record.identityFile !== undefined && record.identityFile !== ''
        ? { identityFile: record.identityFile } : {}),
      ...(record.password !== undefined && record.password !== ''
        ? { password: record.password } : {}),
    });
  }
  return entries;
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

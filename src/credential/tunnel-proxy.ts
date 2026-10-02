/**
 * @file 反向隧道 LLM 代理（多供应商）
 * @description 持有真实 API key 的本机 HTTP 代理：远端 dsh 的模型请求经
 *              SSH 反向隧道回到这里，校验代理令牌、按路径前缀匹配供应商路由、
 *              换成该供应商的真实 key、转发到上游，响应流式回传。
 *
 * 凭据路径（与 PLAN 第三章的架构图一致，多供应商泛化）：
 *
 * ```
 * 远端 dsh → 远端 127.0.0.1:<反向端口>/r/<供应商> → SSH 反向通道 → 本代理
 *            （占位令牌随请求头）                      └─ 前缀 /anthropic → api.deepseek.com
 *                                                      （按路由换成对应真实 key）
 * ```
 *
 * WSL 变体：反向端点 host 参数化为 reverseHost（NAT 模式 = 默认路由网关 IP，
 * mirrored = 127.0.0.1），监听由 tunnel 层的 ReverseListener 在 Windows 侧持有。
 *
 * 三个实现要点：
 *
 * 1. **不能把 ssh2 通道直接喂给 http.Server。** `emit('connection', stream)`
 *    这类技巧依赖通道实现完整的 Socket 接口（`setTimeout` 等），ssh2 的
 *    ClientChannel 并不保证。所以代理在本机回环起一个真实的 http.Server
 *    （监听临时端口），反向通道与一条本机 TCP 连接对接——多一跳本地回环，
 *    换来完全标准的 socket 语义（keep-alive、chunked、流式都由 Node 自己处理）。
 *    临时端口只绑 127.0.0.1，且无有效令牌的请求一律 401。
 *
 * 2. **认证头按原样替换而非统一改写。** dsh 的 `messages` 协议用
 *    `x-api-key` 头，openai 系协议用 `authorization: Bearer`。请求头里带来的
 *    是代理令牌，转发时在**原来出现的头**里替换成匹配路由的真实 key——
 *    各种协议都能走通，不需要远端告知自己用的哪种。
 *
 * 3. **路由按路径前缀匹配，前缀换上游路径。** 远端 baseURL 的路径部分
 *    标识供应商（`/anthropic` 或 `/r/<名>`），转发时把前缀替换成上游
 *    自己的路径，
 *    剩余子路径原样保留。
 */

import { createConnection, type Socket } from 'node:net';
import http from 'node:http';
import { Readable } from 'node:stream';
import type { Duplex } from 'node:stream';
import { appendFileSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { MANAGE_PREFIX, type ManageHandlers } from '../handoff/protocol.js';
import { tokenEquals } from './token.js';
import { createLogger } from '../util/logger.js';
import type { ProxyRoute } from './provider-routes.js';
import type { CredentialPatchEntry, CredentialStrategy } from './types.js';

const logProxy = createLogger('tunnel-proxy');

/** 代理诊断日志落盘路径（与 remote-advanced/remote-sessions 同目录同前缀） */
const PROXY_LOG_PATH = join(homedir(), '.dsh', 'remote-proxy.log');

/** 落盘诊断日志的体积上限：超过即清空重开（诊断日志可丢，防无限增长） */
const PROXY_LOG_MAX_BYTES = 5 * 1024 * 1024;

/**
 * 把代理的失败事件追加落盘到 `~/.dsh/remote-proxy.log`。
 *
 * 动机：console 输出在插件形态跑进 dsh 桌面进程（GUI 无 stdout），CLI 形态
 * 混在会话日志里——代理的失败细节（上游 4xx/5xx、令牌校验失败、本机凭据
 * 缺失）此前对用户完全不可见，远端 dsh 界面只报「(502)」不透传响应体。
 * 文件是第二落点：console 照打（logProxy），失败事件再加一行落盘。
 *
 * **只记失败分支**（直接导致对话失败且界面看不到原因的场景）：令牌校验
 * 失败、本机凭据缺失、上游 4xx/5xx、转发异常。成功路径与非失败事件
 * （代理启动、路由 404 等）不落盘——失败日志才有信号密度。
 *
 * 纪律与 {@link createLogger} 一致：不落任何凭据值（令牌、key、account
 * token 的内容一律不进 data——只打种类/状态码/路径）。
 *
 * 容错：落盘失败静默（诊断手段不能反过来打断代理主流程）。
 *
 * @param message - 消息
 * @param data - 附加数据（须只含非敏感字段）
 */
function proxyDiary(message: string, data?: unknown): void {
  try {
    try {
      if (statSync(PROXY_LOG_PATH).size > PROXY_LOG_MAX_BYTES) {
        // 超限清空重开：诊断日志的价值密度在近期，整份丢弃可接受
        rmSync(PROXY_LOG_PATH);
      }
    } catch { /* 文件不存在：首写，无需轮转 */ }
    const line = `[${new Date().toISOString()}] [WARN] [tunnel-proxy] ${message}`
      + (data === undefined ? '' : ` ${JSON.stringify(data)}`) + '\n';
    appendFileSync(PROXY_LOG_PATH, line, 'utf8');
  } catch { /* 落盘失败不影响代理 */ }
}

/** DeepSeek 原生通道的 patch 条目 id 与路由前缀（与 provider-routes 的约定一致） */
const DEEPSEEK_PATCH_ID = 'llm-deepseek';
const DEEPSEEK_PREFIX = '/anthropic';

/** DeepSeek 账号通道的 patch 条目 id（llm-deepseek-account 插件，走同一路由前缀） */
const DEEPSEEK_ACCOUNT_PATCH_ID = 'llm-deepseek-account';

/** DeepSeek 平台通道的 patch 条目 id 与路由前缀 */
const DEEPSEEK_ACCOUNT_PLATFORM_PATCH_ID = 'deepseek-account';
/**
 * Platform API 的路径前缀。`platformOrigin` 必须是纯 origin（不含路径），
 * 所以隧道代理根据请求路径前缀来路由：`/auth-api/` 和 `/api/v0/` 开头的
 * 请求转发到 `https://platform.deepseek.com`。
 */
const PLATFORM_PREFIXES = ['/auth-api', '/api/v0'];
const PLATFORM_ORIGIN = 'https://platform.deepseek.com';

/** 三种代理令牌可出现的认证头（extractToken 的覆盖面，诊断日志用） */
const AUTH_HEADER_KINDS = ['authorization', 'x-api-key', 'x-dsh-auth-token'] as const;

/** 转发请求时不应透传的请求头（按小写比较） */
const HOP_REQUEST_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding',
  'upgrade', 'host', 'content-length',
]);

/** 转发响应时不应透传的响应头（按小写比较） */
const HOP_RESPONSE_HEADERS = new Set([
  'connection', 'keep-alive', 'transfer-encoding', 'upgrade',
  // undici 的 fetch 会自动解压响应体，但响应头里的 content-encoding 仍在——
  // 透传它会让浏览器按 gzip 再解压一次已解压的内容；content-length 同理失真
  'content-encoding', 'content-length',
]);

/**
 * 反向隧道代理。
 *
 * 生命周期独立于 SSH 传输：重连只重挂 `forwardIn`（由编排层负责），
 * 代理实例与本机监听跨重连存活。
 */
export class TunnelProxyCredential implements CredentialStrategy {
  readonly kind = 'tunnel-proxy';

  private readonly server: http.Server;
  /** 本机回环监听端口；`start()` 之后可用 */
  private localPort = 0;
  /** 反向端点主机；WSL 重连网关变化时经 updateReverseHost 更新 */
  private _reverseHost: string;
  /** 完整路由表（构造时传入 + accountToken 存在时自动加 platform 路由） */
  private readonly allRoutes: readonly ProxyRoute[];
  /** 活跃的反向通道对接（close 时统一销毁） */
  private readonly pipes = new Set<{ channel: Duplex; socket: Socket }>();
  private started = false;
  private stopped = false;

  /**
   * @param proxyToken - 代理令牌（远端占位凭据，所有供应商共用）
   * @param reversePort - 反向隧道在远端占用的端口
   * @param reverseHost - 反向端点主机（远端 dsh 回连目标）：SSH 恒 127.0.0.1；
   *                     WSL NAT 模式为默认路由网关 IP（随 WSL 重启可能变化）
   * @param routes - 供应商路由表（含 DeepSeek 原生通道与 pi-ai 供应商）
   * @param hostAlias - 主机别名（诊断与日志用）
   * @param localCredentials - 本机 `.credentials.yaml` 的 refs 映射（环境变量名 → 密钥值）；
   *                           作为 `process.env` 的回退源，对齐 dsh 自身的凭据解析优先级
   * @param manage - 远端 handoff 组件的管理回调（监督器闭包）；缺省时
   *                 `/manage/*` 返回 404——CLI 形态不传，行为不变
   * @param accountToken - 本机 DeepSeek 账号的 grant token（从 records 段读取）；
   *                       远端 dsh 的 `llm-deepseek-account` 适配器用它发 `x-dsh-auth-token`
   *                       头请求 `api.deepseek.com`——与 refs 段的 `DEEPSEEK_API_KEY` 在安全
   *                       层面等价（都是模型调用认证密钥），走同一隧道代理替换，不出本机。
   *                       undefined 表示本机未登录 DeepSeek 账号——account 通道不可用，
   *                       但 API key 通道不受影响。
   */
  constructor(
    private readonly proxyToken: string,
    readonly reversePort: number,
    reverseHost: string,
    private readonly routes: readonly ProxyRoute[],
    private readonly hostAlias: string,
    private readonly localCredentials: Map<string, string>,
    private readonly manage?: ManageHandlers,
    private readonly accountToken?: string,
  ) {
    this._reverseHost = reverseHost;
    // 本机已登录 DeepSeek 账号时，自动加 platform 路由——让 platform.deepseek.com
    // 的 profile/balance/bonuses 请求也走隧道代理（占位令牌 → 真实 account token）
    this.allRoutes = accountToken !== undefined
      ? [...routes, ...platformRoutes()]
      : routes;
    this.server = http.createServer((req, res) => { void this.handle(req, res); });
    // 客户端在请求中途断开属正常（会话取消），别让它掀翻进程
    this.server.on('clientError', (_error, socket) => { socket.destroy(); });
  }

  /** 反向端点主机（诊断与链路自检用；值即落盘 `.runtime/reverse-host` 的内容） */
  get reverseHost(): string {
    return this._reverseHost;
  }

  /**
   * 更新反向端点主机（WSL 重连时 NAT 网关变化）。
   *
   * 只影响后续 `remotePatches()` 渲染的 baseURL——运行中的远端进程认的是
   * 启动时导入的旧值，材料重写后需重启远端进程才会消费新端点。
   *
   * @param host - 新的反向端点主机
   */
  updateReverseHost(host: string): void {
    this._reverseHost = host;
  }

  /** 路由总数（诊断展示用） */
  get routeCount(): number {
    return this.allRoutes.length;
  }

  /** 本机是否已登录 DeepSeek 账号（重连时判断是否需要重写 credentials.yaml） */
  get accountTokenAvailable(): boolean {
    return this.accountToken !== undefined;
  }

  /**
   * 本机缺失真实 key 的路由的环境变量名列表。
   *
   * 解析优先级：`process.env[keyEnv]` > `.credentials.yaml` refs[keyEnv]。
   * 两处都缺才算 missing——对应供应商的请求会得到明确的 502，其余不受影响。
   */
  get missingKeyEnvs(): string[] {
    return this.allRoutes
      .map(route => route.keyEnv)
      .filter((keyEnv): keyEnv is string => keyEnv !== undefined)
      .filter(keyEnv => !this.resolveApiKey(keyEnv));
  }

  /**
   * 按优先级解析一条路由的真实 key。
   *
   * 优先级：`process.env[keyEnv]` > `.credentials.yaml` refs[keyEnv]。
   * 对齐 dsh 自身的凭据解析顺序（环境变量 > 文件存储），确保本机代理
   * 与远端 dsh 使用同一把 key。
   *
   * @param keyEnv - 环境变量名
   * @returns 密钥值；两处都缺时 undefined
   */
  private resolveApiKey(keyEnv: string): string | undefined {
    const fromEnv = process.env[keyEnv];
    if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
    const fromFile = this.localCredentials.get(keyEnv);
    if (fromFile !== undefined && fromFile.length > 0) return fromFile;
    return undefined;
  }

  /** 注入远端进程的环境变量：每条路由的 keyEnv 都放占位令牌 */
  remoteEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const route of this.routes) {
      if (route.keyEnv !== undefined) env[route.keyEnv] = this.proxyToken;
    }
    return env;
  }

  /**
   * 会话 patch：DeepSeek 原生通道与账号通道的 baseURL 都指向反向端点。
   *
   * host 部分 = reverseHost（SSH 恒 127.0.0.1；WSL NAT 为网关 IP）——
   * NAT 模式下远端 dsh 连 127.0.0.1 是自己的 loopback，连不到 Windows 侧
   * 监听，必须走网关地址。
   *
   * 两条通道共用 `/anthropic` 前缀——它们的请求最终都发往 `api.deepseek.com`，
   * 认证头不同（`x-api-key` vs `x-dsh-auth-token`）但路径相同。代理按请求头
   * 里实际出现的认证头各自替换，不冲突。
   *
   * - `llm-deepseek`：API key 通道，远端发 `x-api-key`（占位令牌）→ 代理替换为真实 key
   * - `llm-deepseek-account`：账号 token 通道，远端发 `x-dsh-auth-token`（占位令牌）
   *   → 代理替换为真实 account token（仅本机已登录时；未登录时不写此 patch，
   *   远端 account 适配器因 resolveToken 返回 undefined 而不发起请求）
   *
   * - `deepseek-account`：平台通道（platformOrigin 指向隧道 /platform 前缀），
   *   远端 dsh 的 `deepseek-account-platform` 插件用它请求 platform.deepseek.com
   *   的 profile/balance/bonuses API——这些请求带 `x-dsh-auth-token`（占位令牌），
   *   经隧道代理替换为真实 account token 转发上游。
   *   同时 patch `inferenceOrigin`（同样指向隧道代理 origin）——这是
   *   `llm-deepseek-account` 适配器能取到 token 的**成立条件**：适配器每次请求
   *   调 `resolveToken(connection.baseURL)`，dsh 的实现要求「请求目标的 origin
   *   必须等于 inferenceOrigin」，且 inferenceOrigin 非生产 api.deepseek.com 时
   *   还要求「grant record 的 issuer 等于 platformOrigin」。baseURL 已指向隧道
   *   而不 patch inferenceOrigin（默认 `https://api.deepseek.com`）时 origin 不
   *   匹配，resolveToken 返回 undefined——适配器抛「需要登录 DeepSeek」错误、
   *   账号模型从远端模型选择器中整组消失（discoverModels 把该错误折叠为空列表）
   *
   * pi-ai 供应商不走 patch——它们的 baseURL 由远端镜像的 settings.yaml
   * 重定向（见 provider-routes 的 mirrorSettingsForTunnel）。
   */
  remotePatches(): CredentialPatchEntry[] {
    const patches: CredentialPatchEntry[] = [
      {
        id: DEEPSEEK_PATCH_ID,
        config: { baseURL: `http://${this._reverseHost}:${this.reversePort}${DEEPSEEK_PREFIX}` },
      },
    ];
    // 本机已登录 DeepSeek 账号时才 patch account 通道——未登录时远端
    // llm-deepseek-account 的 resolveToken 返回 undefined，不发起请求，
    // patch 也就无意义（且能避免远端因 baseURL 指向隧道而报连接错误）
    if (this.accountToken !== undefined) {
      patches.push({
        id: DEEPSEEK_ACCOUNT_PATCH_ID,
        config: { baseURL: `http://${this._reverseHost}:${this.reversePort}${DEEPSEEK_PREFIX}` },
      });
      // 平台通道：platformOrigin 指向隧道代理（纯 origin，不含路径）。
      // 隧道代理根据请求路径前缀（/auth-api/ /api/v0/）路由到 platform.deepseek.com。
      // allowLoopbackHttp: true 允许 HTTP（隧道代理不携带 TLS）。
      // inferenceOrigin 必须等于 llm-deepseek-account patch 的 baseURL origin（隧道
      // 代理地址）——resolveToken 用它校验「请求目标允许账号认证」，不匹配则账号
      // 通道整体不可用（详见 remotePatches 的条目注释）。非生产 inferenceOrigin
      // 下 issuer 校验改查「issuer === platformOrigin」，占位 grant 的 issuer 与
      // platformOrigin 同为隧道地址，恰好闭环。
      patches.push({
        id: DEEPSEEK_ACCOUNT_PLATFORM_PATCH_ID,
        config: {
          platformOrigin: `http://${this._reverseHost}:${this.reversePort}`,
          allowLoopbackHttp: true,
          inferenceOrigin: `http://${this._reverseHost}:${this.reversePort}`,
        },
      });
    }
    return patches;
  }

  /**
   * 启动本机回环监听。
   *
   * @throws Error 监听失败
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.localPort = await new Promise<number>((resolve, reject) => {
      const cleanup = (): void => {
        this.server.off('error', onError);
        this.server.off('listening', onListening);
      };
      const onError = (error: Error): void => { cleanup(); reject(error); };
      const onListening = (): void => {
        cleanup();
        const address = this.server.address();
        if (address === null || typeof address === 'string') {
          reject(new Error('代理监听地址异常，无法确定端口'));
          return;
        }
        resolve(address.port);
      };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen(0, '127.0.0.1');
    });
    this.started = true;
  }

  /** 停止监听并断开全部对接；幂等 */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const pipe of this.pipes) {
      pipe.channel.destroy();
      pipe.socket.destroy();
    }
    this.pipes.clear();
    await new Promise<void>((resolve) => { this.server.close(() => resolve()); });
    // Node 18.2+ 提供；关掉残留的 keep-alive 连接，否则 close 回调迟迟不来
    this.server.closeAllConnections?.();
  }

  /**
   * 接收一条反向隧道连接，对接到本机代理。
   *
   * @param stream - 反向通道的双向流
   */
  handleReverseConnection(stream: Duplex): void {
    if (this.stopped || !this.started) {
      stream.destroy();
      return;
    }

    const socket = createConnection({ host: '127.0.0.1', port: this.localPort });
    const pipe = { channel: stream, socket };
    this.pipes.add(pipe);

    const teardown = (): void => {
      this.pipes.delete(pipe);
      stream.destroy();
      socket.destroy();
    };
    stream.on('error', teardown);
    socket.on('error', teardown);
    stream.once('close', teardown);
    socket.once('close', teardown);

    stream.pipe(socket).pipe(stream);
  }

  /**
   * 处理一条（已到达本机代理的）HTTP 请求。
   *
   * @param req - 请求
   * @param res - 响应
   */
  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      // 请求路径（去查询串）——失败诊断日志与路由共用
      const reqPath = (req.url ?? '/').split('?')[0];
      // 高频路径纪律：成功链路不打 info（每轮对话十数次模型请求），诊断
      // 信息降 debug；info/warn 只留给失败路径
      logProxy.debug('收到请求', { method: req.method, path: reqPath });

      // 1. 校验代理令牌：请求头里带来的占位凭据必须与本地一致
      const presented = extractToken(req);
      if (presented === undefined || !tokenEquals(this.proxyToken, presented)) {
        // 记录带了哪几种认证头（只记种类不记值）——账号通道只带 x-dsh-auth-token，
        // 401 时它是否在场直接指向 extractToken 的覆盖面问题
        const headerKinds = AUTH_HEADER_KINDS.filter(kind => req.headers[kind] !== undefined);
        logProxy.warn('令牌校验失败', { path: reqPath, headerKinds });
        proxyDiary('令牌校验失败', { path: reqPath, headerKinds });
        res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('dsh-remote-explorer proxy: invalid proxy token');
        return;
      }

      // 2. 按路径前缀匹配供应商路由（最长前缀优先，防止 /r/a 误吞 /r/ab）
      const requestUrl = req.url ?? '/';
      const queryIndex = requestUrl.indexOf('?');
      const path = queryIndex >= 0 ? requestUrl.slice(0, queryIndex) : requestUrl;
      const query = queryIndex >= 0 ? requestUrl.slice(queryIndex) : '';

      // 2a. 管理路由族：远端 handoff 组件经反向隧道回调本机监督器。
      //     与 LLM 路由同令牌闸门（上面的 1. 已校验）、同回环监听；
      //     响应只含会话状态/日志/元信息，不含任何凭据内容
      if (path === MANAGE_PREFIX || path.startsWith(`${MANAGE_PREFIX}/`)) {
        await this.handleManage(path, query, res);
        return;
      }

      const route = matchRoute(this.allRoutes, path);
      if (!route) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(`dsh-remote-explorer proxy: 无匹配的供应商路由（${path}）。`
          + `可用前缀：${this.allRoutes.map(r => r.prefix).join('、')}`);
        return;
      }

      // 3. 解析本机持有的真实凭据。同一 `/anthropic` 路由可能承载两种认证：
      //    - API key 通道：请求带 `x-api-key`/`authorization`，用路由的 keyEnv 从
      //      process.env / .credentials.yaml 解析真实 key
      //    - 账号 token 通道：请求带 `x-dsh-auth-token`，用构造时传入的 accountToken
      //    两种凭据各自独立——用户可能只用其中一种。缺 API key 不阻断 account 通道
      //    （反之亦然），只有「请求带了这个头但本机没有对应真实值」时才报 502。
      //    platform 路由（/platform 前缀）无 keyEnv——只走 x-dsh-auth-token 替换路径。
      const apiKey = route.keyEnv !== undefined ? this.resolveApiKey(route.keyEnv) : undefined;
      const accountToken = this.accountToken;
      const hasApiKey = req.headers['x-api-key'] !== undefined || req.headers.authorization !== undefined;
      const hasAccountToken = req.headers['x-dsh-auth-token'] !== undefined;

      if (hasApiKey && apiKey === undefined) {
        proxyDiary('本机缺少 API key，无法代理该供应商调用', {
          path: reqPath, route: route.label, keyEnv: route.keyEnv, hostAlias: this.hostAlias,
        });
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(`dsh-remote-explorer proxy: 本机未设置 ${route.keyEnv}（供应商 ${route.label}），`
          + '无法代理该供应商的调用。请在环境变量或 ~/.dsh/.credentials.yaml 中配置后重连');
        return;
      }
      if (hasAccountToken && accountToken === undefined) {
        proxyDiary('本机未登录 DeepSeek 账号，账号通道 502', {
          path: reqPath, hostAlias: this.hostAlias,
        });
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('dsh-remote-explorer proxy: 本机未登录 DeepSeek 账号（records 段无 grant token），'
          + '无法代理账号通道的调用。请在本地 dsh 登录 DeepSeek 账号后重连');
        return;
      }

      // 4. 构造上游请求：逐头透传，跳过逐跳头；认证头换成真实凭据
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (HOP_REQUEST_HEADERS.has(name)) continue;
        if (Array.isArray(value)) {
          for (const item of value) headers.append(name, item);
        } else if (value !== undefined) {
          headers.set(name, value);
        }
      }
      // 请求里出现过的认证头才替换——各自替换各自的头：
      // - x-api-key / authorization：API key 通道（messages 协议 / openai 系协议）
      // - x-dsh-auth-token：账号 token 通道（llm-deepseek-account 适配器）
      if (req.headers['x-api-key'] !== undefined && apiKey !== undefined) {
        headers.set('x-api-key', apiKey);
      }
      if (req.headers.authorization !== undefined && apiKey !== undefined) {
        headers.set('authorization', `Bearer ${apiKey}`);
      }
      if (req.headers['x-dsh-auth-token'] !== undefined && accountToken !== undefined) {
        headers.set('x-dsh-auth-token', accountToken);
      }

      const init: RequestInit = {
        method: req.method,
        headers,
        redirect: 'error',
      };
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        // 请求体整体缓冲后转发，不能流式直传：本机 Node v24.14.0 的 fetch
        // （undici）对一切流式 body（ReadableStream / 异步生成器）都抛
        // "expected non-null body source"，实测四种传法皆然，只有
        // Buffer/字符串可行。代价是大体积请求（如 dsh 文件上传）会整份落在
        // 本机内存——而模型调用的请求体是 KB 级 JSON，不受影响。
        // 流式真正要紧的是响应侧（SSE），那边保持 pipe 直传。
        // ⚠ 若未来 dsh 经此代理路径传大附件（图片/文档），需评估改为流式
        // 转发或加体积上限，避免大请求撑爆本机内存。
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        init.body = Buffer.concat(chunks);
      }

      // 5. 转发并流式回传。路径换算：请求前缀 → 上游自身路径，剩余子路径原样
      const subPath = path.slice(route.prefix.length);
      const upstreamUrl = `${route.upstreamOrigin}${route.upstreamPath}${subPath}${query}`;
      const upstream = await fetch(upstreamUrl, init);
      // 失败才告警：上游 4xx/5xx 是「真实凭据被上游拒绝」的第一手证据
      // （如本机账号 token 过期时上游回 401）；成功链路按高频路径纪律不打 info
      if (upstream.status >= 400) {
        logProxy.warn('上游返回错误状态', { path: reqPath, route: route.label, status: upstream.status });
        // 失败细节落盘（401 = 真实凭据被上游拒绝的第一手证据，如账号 token 过期）
        proxyDiary('上游返回错误状态', {
          path: reqPath, route: route.label, status: upstream.status, hostAlias: this.hostAlias,
        });
      }
      res.writeHead(upstream.status, this.filteredResponseHeaders(upstream));
      if (upstream.body !== null) {
        const body = Readable.fromWeb(upstream.body as unknown as import('node:stream/web').ReadableStream);
        body.pipe(res);
        body.on('error', () => { res.destroy(); });
      } else {
        res.end();
      }
    } catch (error) {
      // 上游不可达、请求体损坏等都归为网关错误，带上原因链方便诊断
      proxyDiary('转发失败', {
        path: (req.url ?? '/').split('?')[0], hostAlias: this.hostAlias,
        reason: describeError(error),
      });
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      }
      res.end(`dsh-remote-explorer proxy: 转发失败（${describeError(error)}）`);
    }
  }

  /**
   * 处理 `/manage/*` 管理路由：按操作名分派到监督器闭包，JSON 回应。
   *
   * 操作集：`state`（?id=）、`log`（?id=&since=）、`meta`。监督器抛错
   * （如 not_found）转 404——远端组件按「会话已消失」收敛选中态。
   *
   * @param path - 请求路径（不含查询串）
   * @param query - 查询串（含前导 ?）
   * @param res - 响应对象
   */
  private async handleManage(path: string, query: string, res: http.ServerResponse): Promise<void> {
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };
    if (this.manage === undefined) {
      send(404, { code: 'manage_unavailable', message: '本进程未启用管理回调' });
      return;
    }
    const op = path.slice(MANAGE_PREFIX.length).replace(/^\//, '');
    const params = new URLSearchParams(query.startsWith('?') ? query.slice(1) : query);
    const id = params.get('id') ?? '';
    try {
      if (op === 'meta') {
        send(200, this.manage.meta());
        return;
      }
      if (id === '') {
        send(400, { code: 'bad_usage', message: '缺少 id 参数' });
        return;
      }
      if (op === 'state') {
        send(200, this.manage.state(id));
        return;
      }
      if (op === 'log') {
        const since = Number.parseInt(params.get('since') ?? '0', 10);
        send(200, { log: this.manage.log(id, Number.isFinite(since) ? since : 0) });
        return;
      }
      send(404, { code: 'bad_usage', message: `未知管理操作 ${op}` });
    } catch (error) {
      // 监督器的 not_found 归 404（远端组件按「会话已消失」收敛选中态）；
      // 其余运行时错误归 500——原来一律 404 会让远端误判非 not_found 错误为会话消失。
      // 不跨层 import SupervisorError（credential 层不依赖 plugin 层），
      // 按结构化特征判定：监督器错误带 code 属性且值为 'not_found'
      if (error instanceof Error && (error as { code?: string }).code === 'not_found') {
        send(404, { code: 'not_found', message: describeError(error) });
      } else {
        send(500, { code: 'internal', message: describeError(error) });
      }
    }
  }

  /**
   * 收集可透传的响应头。
   *
   * @param upstream - 上游响应
   * @returns 头对象
   */
  private filteredResponseHeaders(upstream: Response): Record<string, string | string[]> {
    const result: Record<string, string | string[]> = {};
    // 显式 .entries() 而非直接 for...of：tsconfig 加了 DOM lib（插件浏览器半需要）后，
    // DOM 的 Headers 类型没有 Symbol.iterator，直接迭代会报 TS2488；.entries() 两套类型都兼容
    for (const [name, value] of upstream.headers.entries()) {
      if (HOP_RESPONSE_HEADERS.has(name.toLowerCase())) continue;
      if (name in result) {
        const existing = result[name]!;
        result[name] = Array.isArray(existing) ? [...existing, value] : [existing, value];
      } else {
        result[name] = value;
      }
    }
    return result;
  }
}

/**
 * DeepSeek 平台路由（profile/balance/bonuses 请求）。
 *
 * upstream = `https://platform.deepseek.com`，多个前缀（`/auth-api` 和 `/api/v0`）。
 * 请求带 `x-dsh-auth-token` 头（占位令牌），代理替换为真实 account token。
 * 无 keyEnv——不走 API key 替换路径。
 */
function platformRoutes(): ProxyRoute[] {
  return PLATFORM_PREFIXES.map(prefix => ({
    prefix,
    upstreamOrigin: PLATFORM_ORIGIN,
    upstreamPath: '',
    label: 'DeepSeek Platform',
  }));
}

/**
 * 按最长前缀匹配路由。
 *
 * @param routes - 路由表
 * @param path - 请求路径（不含查询串）
 * @returns 匹配的路由；无匹配时 undefined
 */
function matchRoute(routes: readonly ProxyRoute[], path: string): ProxyRoute | undefined {
  let best: ProxyRoute | undefined;
  for (const route of routes) {
    if (path !== route.prefix && !path.startsWith(`${route.prefix}/`)) continue;
    if (best === undefined || route.prefix.length > best.prefix.length) best = route;
  }
  return best;
}

/**
 * 从请求头提取代理令牌。
 *
 * 三种认证头按 dsh 各通道的习惯各自出现：`authorization: Bearer`（openai 系
 * 协议）、`x-api-key`（messages 协议 / llm-deepseek）、`x-dsh-auth-token`
 * （llm-deepseek-account 适配器与平台路由——这两条通道**只**带这个头，不带
 * 前两种）。漏认 x-dsh-auth-token 会被代理 401，而 dsh 侧把「请求带了
 * x-dsh-auth-token 却收到 401」判定为账号认证被拒：删除占位 grant、发出
 * 退出登录事件——运行中的任务以「已因退出 DeepSeek 登录而停止」终止。
 *
 * @param req - 请求
 * @returns 令牌；三种认证头都没有时 undefined
 */
function extractToken(req: http.IncomingMessage): string | undefined {
  const authorization = req.headers.authorization;
  if (typeof authorization === 'string' && authorization.startsWith('Bearer ')) {
    return authorization.slice('Bearer '.length);
  }
  // x-api-key 与 x-dsh-auth-token 可能同现（理论上不会，但任一匹配即可放行）
  for (const name of ['x-api-key', 'x-dsh-auth-token'] as const) {
    const value = req.headers[name];
    if (typeof value === 'string') return value;
  }
  return undefined;
}

/**
 * 展开错误的 cause 链——undici 的「fetch failed」本身不带任何信息，
 * 真正的原因（DNS、TLS、连接被拒）在 cause 里。
 *
 * @param error - 捕获的错误
 * @returns 逐层拼接的消息
 */
function describeError(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    parts.push(current.message);
    current = (current as Error & { cause?: unknown }).cause;
  }
  return parts.join(' ← ') || String(error);
}

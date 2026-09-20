/**
 * @file 反向隧道 LLM 代理
 * @description 持有真实 API key 的本机 HTTP 代理：远端 dsh 的模型请求经
 *              SSH 反向隧道回到这里，校验代理令牌、换成真实 key、转发到
 *              DeepSeek 上游，响应流式回传。
 *
 * 凭据路径（与 PLAN 第三章的架构图一致）：
 *
 * ```
 * 远端 dsh → 远端 127.0.0.1:<反向端口> → SSH 反向通道 → 本代理 → api.deepseek.com
 *            （占位令牌随请求头）          （此处换成真实 key）
 * ```
 *
 * 两个实现要点：
 *
 * 1. **不能把 ssh2 通道直接喂给 http.Server。** `emit('connection', stream)`
 *    这类技巧依赖通道实现完整的 Socket 接口（`setTimeout` 等），ssh2 的
 *    ClientChannel 并不保证。所以代理在本机回环起一个真实的 http.Server
 *    （监听临时端口），反向通道与一条本机 TCP 连接对接——多一跳本地回环，
 *    换来完全标准的 socket 语义（keep-alive、chunked、流式都由 Node 自己处理）。
 *    临时端口只绑 127.0.0.1，且无有效令牌的请求一律 401。
 *
 * 2. **认证头按原样替换而非统一改写。** dsh 的 `messages` 协议（默认）用
 *    `x-api-key` 头，其余协议用 `authorization: Bearer`。请求头里带来的是
 *    代理令牌，转发时在**原来出现的头**里替换成真实 key——两种协议都能走通，
 *    不需要远端告知自己用的哪种。
 */

import { createConnection, type Socket } from 'node:net';
import http from 'node:http';
import { Readable } from 'node:stream';
import type { Duplex } from 'node:stream';
import { tokenEquals } from './token.js';
import type { CredentialPatchEntry, CredentialStrategy } from './types.js';

/** DeepSeek 公网 API 根地址 */
const UPSTREAM_BASE = 'https://api.deepseek.com';

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
  /** 活跃的反向通道对接（close 时统一销毁） */
  private readonly pipes = new Set<{ channel: Duplex; socket: Socket }>();
  private started = false;
  private stopped = false;

  /**
   * @param proxyToken - 代理令牌（远端占位凭据）
   * @param reversePort - 反向隧道在远端占用的端口
   * @param apiKey - 真实 API key；本机没有 DEEPSEEK_API_KEY 时为 undefined，
   *                 代理仍会启动但每个请求都返回明确错误
   * @param hostAlias - 主机别名（诊断与日志用）
   */
  constructor(
    private readonly proxyToken: string,
    readonly reversePort: number,
    private readonly apiKey: string | undefined,
    private readonly hostAlias: string,
  ) {
    this.server = http.createServer((req, res) => { void this.handle(req, res); });
    // 客户端在请求中途断开属正常（会话取消），别让它掀翻进程
    this.server.on('clientError', (_error, socket) => { socket.destroy(); });
  }

  /** 真实 key 是否就位 */
  get hasApiKey(): boolean {
    return this.apiKey !== undefined && this.apiKey.length > 0;
  }

  /** 注入远端进程的环境变量：占位凭据就是代理令牌 */
  remoteEnv(): Record<string, string> {
    return { DEEPSEEK_API_KEY: this.proxyToken };
  }

  /** 会话 patch：baseURL 指向反向端口，路径后缀与 messages 协议的上游一致 */
  remotePatches(): CredentialPatchEntry[] {
    return [
      {
        id: 'llm-deepseek',
        config: { baseURL: `http://127.0.0.1:${this.reversePort}/anthropic` },
      },
    ];
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
      // 1. 校验代理令牌：请求头里带来的占位凭据必须与本地一致
      const presented = extractToken(req);
      if (presented === undefined || !tokenEquals(this.proxyToken, presented)) {
        res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('dsh-remote proxy: invalid proxy token');
        return;
      }

      // 2. 真实 key 必须就位——缺 key 时给出能定位到本机的明确错误
      if (!this.hasApiKey) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('dsh-remote proxy: 本机未设置 DEEPSEEK_API_KEY，无法代理模型调用。'
          + '请在启动 dsh-remote 的环境中导出该变量后重连');
        return;
      }

      // 3. 构造上游请求：逐头透传，跳过逐跳头；认证头换成真实 key
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (HOP_REQUEST_HEADERS.has(name)) continue;
        if (Array.isArray(value)) {
          for (const item of value) headers.append(name, item);
        } else if (value !== undefined) {
          headers.set(name, value);
        }
      }
      // 请求里出现过的认证头才替换——messages 协议带 x-api-key，
      // 其余协议带 authorization；两者都出现时都替换
      if (req.headers['x-api-key'] !== undefined) headers.set('x-api-key', this.apiKey!);
      if (req.headers.authorization !== undefined) {
        headers.set('authorization', `Bearer ${this.apiKey}`);
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
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        init.body = Buffer.concat(chunks);
      }

      // 4. 转发并流式回传
      const upstream = await fetch(`${UPSTREAM_BASE}${req.url ?? '/'}`, init);
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
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      }
      res.end(`dsh-remote proxy: 转发失败（${describeError(error)}）`);
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
    for (const [name, value] of upstream.headers) {
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
 * 从请求头提取代理令牌。
 *
 * @param req - 请求
 * @returns 令牌；两种认证头都没有时 undefined
 */
function extractToken(req: http.IncomingMessage): string | undefined {
  const authorization = req.headers.authorization;
  if (typeof authorization === 'string' && authorization.startsWith('Bearer ')) {
    return authorization.slice('Bearer '.length);
  }
  const apiKey = req.headers['x-api-key'];
  if (typeof apiKey === 'string') return apiKey;
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

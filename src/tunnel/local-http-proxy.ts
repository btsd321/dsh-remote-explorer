/**
 * @file 本机 HTTP 代理服务器（local_resource_download 的代理隧道本机侧）
 * @description 远端无网时让远端的 curl/npm install 走本机网络：本机起一个 HTTP
 *              CONNECT 代理，经 SSH 反向转发（{@link RemoteTransport.forwardIn}）
 *              映射到远端端口，远端设 `http_proxy=http://127.0.0.1:<远端端口>` 后，
 *              curl/npm 的出站请求经远端端口 → SSH 反向隧道 → 本机代理 → 公网。
 *
 *              纯 JS 用 Node 原生 `http`/`net` 模块实现，跑在 dsh 宿主进程内，
 *              不引入外部依赖。
 *
 * 实现：标准 `http.Server` 监听 127.0.0.1:0（OS 分配端口），处理 HTTP CONNECT
 * 方法（HTTPS/HTTP 代理的标准握手）。SSH `forwardIn` 的入站 stream 经
 * `server.emit('connection', stream)` 喂给同一个 server——这样代理逻辑只有一份，
 * 远端反向隧道与本机直连都走同一条 CONNECT 处理路径。
 *
 * 生命周期：provision 阶段开始前 start()，provision 完成后 stop()。代理只在
 * 引导期存活——dsh 启动后远端不再需要代理（dsh 自己的代理走 collectProxyEnv）。
 *
 * 安全约束：
 * - 监听只绑 127.0.0.1——不挂到全网卡（代理可访问公网，绑全网卡等于开放中继）
 * - SSH 反向转发也绑远端 127.0.0.1（forwardIn 默认行为）——远端其他用户不可用
 * - 不记日志请求内容与目标 URL——CONNECT 只记 host:port（诊断级别 debug）
 * - **不设目标白名单**：远端同权限用户仍可通过本机出口访问任意站点（与凭据
 *   代理是同族已知残余风险——他们拿不到 key，但能借用你的网络出口）。这使
 *   代理只在引导期存活的理由之一；多用户远端主机上需自行评估。
 *
 * 分层约束：本文件属能力层（tunnel/），向下使用基础层（util/logger）；不依赖
 * 编排层（session/）或入口层。
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect as netConnect, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { createLogger } from '../util/logger.js';

const log = createLogger('local-http-proxy');

/** CONNECT 请求的连接超时（毫秒）：目标不可达时应快速失败 */
const CONNECT_TIMEOUT_MS = 30_000;

/**
 * 本机 HTTP 代理服务器。
 *
 * 用标准 `http.Server` 处理 CONNECT 方法。SSH 反向隧道的入站 stream 经
 * `handleStream()` 喂给同一个 server——远端请求与本机直连共用同一套
 * CONNECT 处理逻辑。
 */
export class LocalHttpProxy {
  /** 底层 HTTP 服务器（处理 CONNECT 方法） */
  private readonly server: Server;
  /** 本机监听端口（start() 后可用；0 = 尚未启动） */
  private _localPort = 0;
  /** 活跃的上游连接（stop 时全部销毁） */
  private readonly activeUpstreams = new Set<Socket>();
  /**
   * 注入进来的客户端侧流（SSH 反向隧道入站）。
   *
   * `stop()` 必须显式销毁它们：`server.close()` 会等所有连接结束才回调，
   * 而 SSH 通道流的生命周期不归本机管——漏登记就是 provision 收尾时永久挂起。
   */
  private readonly injectedStreams = new Set<Duplex>();

  constructor() {
    this.server = createServer((req, res) => {
      // 非 CONNECT 的普通 HTTP 请求——代理不处理普通 GET/POST（只做 CONNECT 隧道），
      // 返回 405 让客户端知道要用 CONNECT。npm/curl 的代理走的是 CONNECT
      this.handleHttpRequest(req, res);
    });
    // CONNECT 方法是 HTTP 代理的核心——HTTPS 与 HTTP 代理隧道都走它
    this.server.on('connect', (req, clientSocket) => {
      this.handleConnect(req, clientSocket);
    });
    this.server.on('error', (error) => {
      log.error('本机 HTTP 代理服务器错误', { error: error.message });
    });
  }

  /** 本机监听端口；start() 后可用 */
  get localPort(): number {
    return this._localPort;
  }

  /**
   * 启动代理服务器，监听 127.0.0.1:0（OS 分配端口）。
   *
   * @returns 监听端口
   * @throws Error 端口绑定失败
   */
  async start(): Promise<number> {
    if (this._localPort > 0) return this._localPort;
    return new Promise<number>((resolve, reject) => {
      const onError = (error: Error): void => {
        reject(new Error(`本机 HTTP 代理启动失败：${error.message}`));
      };
      this.server.once('error', onError);
      this.server.listen(0, '127.0.0.1', () => {
        this.server.off('error', onError);
        const addr = this.server.address();
        if (addr === null || typeof addr === 'string') {
          reject(new Error('本机 HTTP 代理监听地址异常'));
          return;
        }
        this._localPort = addr.port;
        log.info(`本机 HTTP 代理已启动（127.0.0.1:${this._localPort}）`);
        resolve(this._localPort);
      });
    });
  }

  /**
   * 把一条 SSH 反向隧道的入站 stream 喂给代理服务器。
   *
   * SSH `forwardIn` 的回调收到的 stream 是一条 SSH 通道双向流。经
   * `server.emit('connection', stream)` 让 Node 的 HTTP 解析器接管它——
   * stream 上的数据按 HTTP 协议解析，CONNECT 方法触发 'connect' 事件。
   * 这样远端反向隧道的请求与本机直连请求走同一套处理路径。
   *
   * @param stream - SSH 反向隧道的入站双向流
   */
  handleStream(stream: NodeJS.ReadableStream & NodeJS.WritableStream): void {
    // Node 的 http.Server 接受任意双工流作为 connection——它用内部 HTTP 解析器
    // 把流当成本机 TCP 连接处理。SSH stream 是全双工的，语义等价
    const duplex = stream as unknown as Duplex;
    this.injectedStreams.add(duplex);
    // 流结束时自动移出登记表，避免集合随连接数无限增长
    duplex.once('close', () => { this.injectedStreams.delete(duplex); });
    this.server.emit('connection', stream as unknown as Socket);
  }

  /**
   * 停止代理服务器，销毁所有活跃连接。
   *
   * 幂等：多次调用安全。provision 完成后调用——代理只在引导期存活。
   *
   * 先显式销毁全部在飞连接（上游 socket + 注入的 SSH 流），再 `close()`：
   * `server.close()` 只停止接受新连接并等待现有连接自行结束，若远端还有
   * 半开的隧道连接，回调永不触发——而 provision 的 finally 正 await 这个
   * 方法，整个连接流程会挂死。
   */
  async stop(): Promise<void> {
    if (this._localPort === 0) return;
    // 1. 销毁所有活跃的上游连接（正在传输的代理请求）
    for (const upstream of this.activeUpstreams) {
      upstream.destroy();
    }
    this.activeUpstreams.clear();
    // 2. 销毁注入的 SSH 流——它们的关闭不由本机驱动
    for (const stream of this.injectedStreams) {
      stream.destroy();
    }
    this.injectedStreams.clear();
    // 3. 兜底清掉本机监听侧可能残留的空闲连接（keep-alive）
    this.server.closeAllConnections();
    return new Promise<void>((resolve) => {
      this.server.close(() => {
        this._localPort = 0;
        resolve();
      });
    });
  }

  /**
   * 处理 HTTP CONNECT 方法（代理隧道核心）。
   *
   * CONNECT host:port HTTP/1.1 后，客户端（curl/npm）在隧道里发 TLS/HTTP。
   * 代理建立到 host:port 的 TCP 连接，回复 `200 Connection Established`，
   * 双向桥接两个流。
   *
   * @param req - CONNECT 请求（req.url = 'host:port'）
   * @param clientSocket - 客户端侧双工流（SSH stream 或本机 TCP socket）
   */
  private handleConnect(req: IncomingMessage, clientSocket: Duplex): void {
    const target = req.url ?? '';
    if (target === '') {
      clientSocket.destroy();
      return;
    }
    // 解析 host:port
    const colonIndex = target.lastIndexOf(':');
    if (colonIndex < 0) {
      clientSocket.destroy();
      return;
    }
    const host = target.slice(0, colonIndex);
    const port = Number.parseInt(target.slice(colonIndex + 1), 10);
    if (host === '' || !Number.isFinite(port) || port < 1 || port > 65535) {
      clientSocket.destroy();
      return;
    }

    log.debug(`CONNECT ${target}`);

    // 建立到目标的上游 TCP 连接
    const upstream = netConnect({ host, port });
    upstream.setTimeout(CONNECT_TIMEOUT_MS, () => {
      upstream.destroy(new Error(`连接 ${target} 超时`));
    });

    /**
     * 是否已回复 200 并进入隧道态。
     *
     * 隧道建立之后不能再往客户端写 HTTP 响应——那段字节会混进已加密的
     * 隧道流里污染数据。故 502 只在握手阶段写。
     */
    let established = false;

    upstream.on('error', (error) => {
      log.debug(`CONNECT ${target} 失败：${error.message}`);
      if (established) return;
      // 握手阶段失败：回复 502 让客户端知道目标不可达
      clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      clientSocket.destroy();
    });

    upstream.on('connect', () => {
      // 上游连接就绪：回复 200，开始双向桥接
      established = true;
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      this.activeUpstreams.add(upstream);
      // 双向 pipe——任一方关闭时另一方也关闭
      clientSocket.pipe(upstream);
      upstream.pipe(clientSocket);
      const cleanup = (): void => {
        this.activeUpstreams.delete(upstream);
        upstream.destroy();
        clientSocket.destroy();
      };
      clientSocket.on('close', cleanup);
      clientSocket.on('error', cleanup);
      upstream.on('close', cleanup);
      upstream.on('error', cleanup);
    });
  }

  /**
   * 处理非 CONNECT 的普通 HTTP 请求（GET/POST 等）。
   *
   * 代理只做 CONNECT 隧道，不处理普通 HTTP 转发——curl/npm 的 HTTPS 请求
   * 走 CONNECT，但个别 HTTP（非 HTTPS）请求可能走 GET。对这类请求回复
   * 405，让客户端改用 CONNECT 或直连。实际上 npm/curl 的代理行为都走 CONNECT，
   * 这里只是防御性处理。
   */
  private handleHttpRequest(_req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('Proxy supports CONNECT only. Use http_proxy for HTTPS requests.\n');
  }
}

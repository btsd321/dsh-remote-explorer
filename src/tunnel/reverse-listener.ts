/**
 * @file Windows 侧反向监听器（分配即绑定）
 * @description WSL 路径的反向隧道监听。核心语义是**分配即绑定**——真实
 *              `createServer().listen()` 成功的端口才允许写进会话材料，
 *              彻底消灭「探测时空闲、绑定时被占」的竞态与端口命名空间分裂。
 *
 * 背景问题（实测复现）：Windows 侧 47xxx 段端口会被 VS Code / WSL relay
 * 机制**静默保留**——netstat 查无监听但 bind 报 EADDRINUSE。旧流程在
 * WSL 命名空间内探测空闲端口（两边命名空间不一致），绑定时被幽灵占用后
 * 仅静默降级，结果是会话照常建立、handoff meta 回调 502、LLM 凭据代理
 * 全断，用户只看到「pill 不渲染」而无任何告警。
 *
 * 核心设计：
 *
 * - **绑定保持**：`bind()` 成功后监听器持续存活；连接 handler 可后挂
 *   （`setHandler`）。分配阶段远端 dsh 尚未启动，不会有合法连接；提前到达
 *   的杂散连接（探测、扫描）直接 destroy。
 * - **首选既有端口**：优先尝试会话落盘的 reversePort（复用语义——反向端口
 *   写进了 patch 的 baseURL，运行中的远端进程认它）；绑不上再换候选并让
 *   调用方触发材料重写。
 * - **多地址绑定**：NAT 模式需同时绑 127.0.0.1 与网关 IP（vEthernet 宿主
 *   地址）——地址列表由编排层探测后传入（本模块不做网络探测）。附加地址
 *   绑定失败仅告警降级为仅 127.0.0.1。
 * - **幂等 close**：随会话关闭释放；跨重连存活（监听不依赖任何传输实例）。
 *
 * 安全约束：
 * - 主绑定只绑 `127.0.0.1`——绑全网卡等于把凭据代理挂到网上；附加地址
 *   是 NAT 网关（WSL → Windows 的定向路径），同样不是对外暴露面
 * - raw TCP socket 的 error 监听器必须在任何 destroy 之前挂上，否则进程崩溃
 *
 * 分层约束：本文件属能力层（tunnel/），纯 Node 实现不依赖传输层运行时，
 * 仅从 transport/types 导入 ReverseConnection 连接类型（tunnel→transport
 * 的类型导入既有先例：port-allocator、forward-local）；其余依赖仅限基础层
 * （util/）与同层（port-allocator 的候选策略）。
 */

import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { Duplex } from 'node:stream';
import type { ReverseConnection } from '../transport/types.js';
import { RemoteError, toErrorMessage } from '../util/errors.js';
import { createLogger } from '../util/logger.js';
import { PORT_RANGE_SIZE, PORT_RANGE_START, randomPortCandidate } from './port-allocator.js';

const log = createLogger('reverse-listener');

/**
 * 绑定尝试上限（含首选端口的首次尝试）。
 *
 * 候选区间 47000–48999 共 2000 个端口随机抽取，20 次仍全部被占说明区间被
 * 系统性静默占用（实测形态见 bind 步骤 3 注释）——此时不再继续人肉抽签，
 * 转入 OS 分配端口兜底，而非报错或无限重试。
 */
const MAX_BIND_ATTEMPTS = 20;

/** 主绑定地址：回环，绝不能让反向端口对外可见 */
const PRIMARY_HOST = '127.0.0.1';

/** 触发换候选重试的绑定错误码：端口被占（含幽灵保留）或权限拒绝 */
const RETRYABLE_BIND_CODES = new Set(['EADDRINUSE', 'EACCES']);

/** 反向连接处理器（编排层挂接凭据代理用；入参即传输层的 ReverseConnection） */
export type ReverseConnectionHandler = (connection: ReverseConnection) => void;

/** 绑定选项 */
export interface ReverseBindOptions {
  /** 优先尝试的端口（会话落盘的既有 reversePort；绑不上换候选） */
  preferredPort?: number;
  /**
   * 附加绑定地址（NAT 模式的网关 IP）。
   * 与主绑定共用同一端口；单个地址绑定失败仅告警降级，不影响整体成功。
   */
  extraHosts?: readonly string[];
}

/**
 * Windows 侧反向监听器。
 *
 * 生命周期：`bind()` → `setHandler()`（顺序可互换，handler 后挂是核心能力）
 * → `close()`。跨传输重连存活：监听不依赖任何远端连接，重连无需重建；
 * NAT 网关变化时用 {@link setExtraHosts} 增量调整附加地址。
 */
export class ReverseListener {
  /** 已绑定的 server（地址 → server）；主绑定与附加地址并列 */
  private readonly servers = new Map<string, Server>();
  /** 已绑定的端口；未绑定或已关闭时 undefined */
  private boundPort: number | undefined;
  /** 连接处理器；未挂接时到达的连接视为杂散连接直接销毁 */
  private handler: ReverseConnectionHandler | undefined;
  /** 活跃的入站连接；close() 时统一销毁以便释放端口 */
  private readonly sockets = new Set<Socket>();
  private closed = false;

  /**
   * @param hostAlias - 主机别名（日志与错误消息的定位信息）
   */
  constructor(private readonly hostAlias: string) {}

  /** 已绑定的端口；未绑定或已关闭时 undefined */
  get port(): number | undefined {
    return this.boundPort;
  }

  /** 当前实际监听的全部地址（日志与诊断用） */
  get hosts(): readonly string[] {
    return [...this.servers.keys()];
  }

  /**
   * 分配并绑定反向监听端口。
   *
   * 候选序列：preferredPort（复用语义）优先，其后在 47000–48999 区间随机
   * 抽取，总尝试上限 {@link MAX_BIND_ATTEMPTS}。主地址 127.0.0.1 绑定失败
   * （EADDRINUSE/EACCES，含幽灵占用）即换下一候选；其他错误（如参数非法）
   * 直接抛出。**候选全部耗尽时不报错**——回退 OS 分配端口（listen 传 0，
   * 操作系统在动态端口区给出保证可绑定的口），绑定对「区间被整段静默
   * 占用」免疫。附加地址逐个尝试，失败仅告警降级。
   *
   * @param options - 绑定选项
   * @returns 实际绑定的端口（写进会话材料的唯一真值）
   * @throws RemoteError('CONNECT_FAILED') 已绑定/已关闭/不可重试错误/OS 分配亦失败
   */
  async bind(options: ReverseBindOptions = {}): Promise<number> {
    this.assertNotClosed();
    if (this.boundPort !== undefined) {
      throw new RemoteError(
        'CONNECT_FAILED',
        `反向监听器已绑定端口 ${this.boundPort}，不允许重复绑定`,
        { hostAlias: this.hostAlias },
      );
    }

    // 1. 组装候选序列：首选既有端口 → 随机候选（去重），总量封顶
    const candidates = new Set<number>();
    if (options.preferredPort !== undefined) candidates.add(options.preferredPort);
    while (candidates.size < MAX_BIND_ATTEMPTS) {
      candidates.add(randomPortCandidate());
    }

    let lastError: Error | undefined;
    let attempts = 0;
    for (const port of candidates) {
      attempts += 1;
      const server = createServer((socket: Socket) => this.handleConnection(socket));
      try {
        await this.listenOnce(server, PRIMARY_HOST, port);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        const code = (lastError as NodeJS.ErrnoException).code;
        if (code !== undefined && RETRYABLE_BIND_CODES.has(code)) {
          // 幽灵占用/权限拒绝都在预期内：换候选重试（含 Windows 端口排除段）
          log.debug(`反向监听候选 ${PRIMARY_HOST}:${port} 绑定被拒（${code}），换下一候选`, {
            hostAlias: this.hostAlias,
          });
          continue;
        }
        throw new RemoteError(
          'CONNECT_FAILED',
          `反向监听 ${PRIMARY_HOST}:${port} 绑定失败（主机 ${this.hostAlias}）: ${toErrorMessage(error)}`,
          { cause: error, hostAlias: this.hostAlias },
        );
      }

      // 2. 主绑定成功：登记、挂常驻 error 兜底、补附加地址
      return await this.registerBound(server, port, options);
    }

    // 3. 候选区间整体被占：回退 OS 分配端口（listen 传 0）。实测形态是
    //    VS Code 的输出扫描端口转发会把终端输出里出现过的端口号静默占住
    //    （netstat 查无监听、netsh 排除区无记录，bind 即 EADDRINUSE），
    //    终端里打印过大量 47xxx 候选的机器可被吞噬整段区间；OS 分配是
    //    唯一不受该机制影响的来源。代价仅是端口落入动态区（首次打开的
    //    会话材料本就随后写入，无复用预期可破坏）
    const osServer = createServer((socket: Socket) => this.handleConnection(socket));
    try {
      await this.listenOnce(osServer, PRIMARY_HOST, 0);
    } catch (error) {
      // 连 OS 分配都失败：系统级端口/句柄枯竭（EMFILE 等），如实上抛
      throw new RemoteError(
        'CONNECT_FAILED',
        `在主机 ${this.hostAlias} 上尝试 ${attempts} 个候选端口仍无法绑定反向监听`
          + `${PRIMARY_HOST}（候选区间 ${PORT_RANGE_START}–${PORT_RANGE_START + PORT_RANGE_SIZE - 1}），`
          + `且 OS 分配端口同样失败（${toErrorMessage(error)}）：疑似系统级端口或句柄枯竭，`
          + '请检查本机进程数与端口策略后重试',
        { cause: lastError ?? error, hostAlias: this.hostAlias },
      );
    }
    const assigned = (osServer.address() as AddressInfo | null)?.port ?? 0;
    if (assigned === 0) {
      // address() 拿不回端口的异常形态（理论不可达）：按绑定失败处理，宁停勿错
      osServer.close();
      throw new RemoteError(
        'CONNECT_FAILED',
        `在主机 ${this.hostAlias} 上 OS 分配端口后无法读取实际端口号，反向监听中止`,
        { hostAlias: this.hostAlias },
      );
    }
    log.info(
      `反向监听候选区间 ${PORT_RANGE_START}–${PORT_RANGE_START + PORT_RANGE_SIZE - 1} 全部被占`
        + `（疑似 VS Code / WSL relay 静默保留：终端输出出现过的端口号会被自动转发占用），`
        + `已回退 OS 分配端口 ${PRIMARY_HOST}:${assigned}`,
      { hostAlias: this.hostAlias },
    );
    return await this.registerBound(osServer, assigned, options);
  }

  /**
   * 主绑定成功后的登记与附加地址绑定。
   *
   * bind 的候选命中路径与 OS 分配回退路径共用：登记 server 与端口、挂
   * server 级常驻 error 监听（监听期错误只告警不掀翻进程）、逐个补绑
   * 附加地址（NAT 网关，失败降级告警）。
   *
   * @param server - 已完成 listen 的主地址 server
   * @param port - 实际绑定端口（OS 分配路径由调用方读回）
   * @param options - 绑定选项（取 extraHosts）
   * @returns 实际绑定的端口
   */
  private async registerBound(
    server: Server,
    port: number,
    options: ReverseBindOptions,
  ): Promise<number> {
    this.servers.set(PRIMARY_HOST, server);
    this.boundPort = port;
    server.on('error', (error: Error) => {
      log.warn(`反向监听 ${PRIMARY_HOST}:${port} 发生错误: ${error.message}`, {
        hostAlias: this.hostAlias,
      });
    });
    log.info(`反向监听已绑定 ${PRIMARY_HOST}:${port}`, { hostAlias: this.hostAlias });

    // 附加地址（NAT 网关）：同端口绑定，失败降级仅 127.0.0.1 并告警
    for (const host of options.extraHosts ?? []) {
      if (host === PRIMARY_HOST) continue;
      await this.bindExtraHost(host, port);
    }
    return port;
  }

  /**
   * 追加一个附加绑定地址（与已绑定端口同端口）。
   *
   * @param host - 附加地址（NAT 网关 IP）
   * @returns 是否绑定成功；失败已按降级语义告警
   * @throws RemoteError('CONNECT_FAILED') 未绑定/已关闭
   */
  async addHost(host: string): Promise<boolean> {
    this.assertNotClosed();
    if (this.boundPort === undefined) {
      throw new RemoteError(
        'CONNECT_FAILED',
        `反向监听器尚未绑定端口，无法追加地址 ${host}`,
        { hostAlias: this.hostAlias },
      );
    }
    if (host === PRIMARY_HOST || this.servers.has(host)) return true;
    return await this.bindExtraHost(host, this.boundPort);
  }

  /**
   * 按计划对齐附加绑定地址（重连时 NAT 网关变化的增量调整）。
   *
   * 主绑定 127.0.0.1 与端口**保持不变**（远端材料认的就是它）；不在计划内
   * 的附加地址关闭监听，计划内尚未绑定的地址尝试补绑（失败降级告警）。
   * 幂等：集合无变化时不产生任何网络操作。
   *
   * @param hosts - 期望的附加地址集合（NAT 为 [网关 IP]，mirrored 为空）
   * @throws RemoteError('CONNECT_FAILED') 未绑定/已关闭
   */
  async setExtraHosts(hosts: readonly string[]): Promise<void> {
    this.assertNotClosed();
    if (this.boundPort === undefined) {
      throw new RemoteError(
        'CONNECT_FAILED',
        '反向监听器尚未绑定端口，无法调整附加地址',
        { hostAlias: this.hostAlias },
      );
    }
    const desired = new Set(hosts.filter(host => host !== PRIMARY_HOST));

    // 1. 关闭不再需要的附加地址（如 NAT → mirrored 时摘掉旧网关）
    for (const host of [...this.servers.keys()]) {
      if (host === PRIMARY_HOST || desired.has(host)) continue;
      await this.closeServerOf(host);
      log.info(`反向监听附加地址已移除 ${host}:${this.boundPort}`, { hostAlias: this.hostAlias });
    }

    // 2. 补绑新增地址（此前绑定失败的自愈重试也在这一步）
    for (const host of desired) {
      if (this.servers.has(host)) continue;
      await this.bindExtraHost(host, this.boundPort);
    }
  }

  /**
   * 挂接连接处理器（可后挂）。
   *
   * handler 挂接前到达的连接都被当作杂散连接销毁；挂接后到达的连接经
   * Duplex 包装交给 handler 接管。
   *
   * @param handler - 连接处理器
   */
  setHandler(handler: ReverseConnectionHandler): void {
    this.handler = handler;
  }

  /**
   * 关闭全部监听并断开所有连接；幂等。
   *
   * 会话关闭路径调用；跨重连场景**不要**调用（监听器是会话级资源）。
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.boundPort = undefined;
    this.handler = undefined;

    // 先销毁活跃连接再关 server：Windows 上半开连接会拖住端口释放
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();

    const servers = [...this.servers.values()];
    this.servers.clear();
    await Promise.all(servers.map(server => new Promise<void>(resolve => {
      server.close(() => resolve());
    })));
    log.info('反向监听已关闭', { hostAlias: this.hostAlias });
  }

  /**
   * 在指定地址上执行一次 listen。
   *
   * @param server - 目标 server
   * @param host - 绑定地址
   * @param port - 端口
   */
  private listenOnce(server: Server, host: string, port: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        server.off('error', onError);
        server.off('listening', onListening);
      };
      const onError = (error: Error): void => { cleanup(); reject(error); };
      const onListening = (): void => { cleanup(); resolve(); };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    });
  }

  /**
   * 绑定一个附加地址（同端口）。
   *
   * @param host - 附加地址
   * @param port - 已绑定端口
   * @returns 是否成功；失败按降级语义告警（NAT 下 WSL 将无法经网关回连）
   */
  private async bindExtraHost(host: string, port: number): Promise<boolean> {
    const server = createServer((socket: Socket) => this.handleConnection(socket));
    try {
      await this.listenOnce(server, host, port);
    } catch (error) {
      // 降级不是静默：地址、端口、原因全部进日志（用户点名要的可观测性）
      log.warn(
        `反向监听附加地址 ${host}:${port} 绑定失败，降级为仅 ${PRIMARY_HOST}`
        + `（NAT 模式下 WSL 将无法经网关回连，反向链路自检会再次告警）: ${toErrorMessage(error)}`,
        { hostAlias: this.hostAlias },
      );
      return false;
    }
    server.on('error', (error: Error) => {
      log.warn(`反向监听附加地址 ${host}:${port} 发生错误: ${error.message}`, {
        hostAlias: this.hostAlias,
      });
    });
    this.servers.set(host, server);
    log.info(`反向监听已绑定附加地址 ${host}:${port}`, { hostAlias: this.hostAlias });
    return true;
  }

  /**
   * 处理一条入站连接（所有地址的 server 共用）。
   *
   * @param socket - 入站 socket
   */
  private handleConnection(socket: Socket): void {
    // error 监听器必须在任何 destroy 之前挂上：无监听器的 socket 被带
    // error 参数 destroy 时，未处理 error 事件会直接掀翻进程
    socket.on('error', () => { /* 对端中途断开等无害错误，静默忽略 */ });
    this.sockets.add(socket);
    socket.once('close', () => this.sockets.delete(socket));

    if (this.closed) {
      socket.destroy();
      return;
    }
    const handler = this.handler;
    if (handler === undefined) {
      // 分配阶段远端 dsh 尚未启动，不存在合法连接；提前到达的杂散连接
      // （连通性探测、端口扫描）直接销毁
      socket.destroy();
      return;
    }
    const stream = Duplex.from({ readable: socket, writable: socket });
    // Duplex 包装在 socket 未发 FIN 就关闭时会以 ERR_STREAM_PREMATURE_CLOSE
    // 终止可读侧；消费者（凭据代理）有自己的 error 处理，但本层不能依赖
    // 「消费者一定挂了监听」——零 error 监听器的流抛 error 会掀翻宿主进程
    stream.on('error', (error: Error) => {
      log.debug(`反向连接流错误（多为对端中途断开）: ${error.message}`, {
        hostAlias: this.hostAlias,
      });
      socket.destroy();
    });
    handler({
      remoteAddr: socket.remoteAddress ?? 'unknown',
      remotePort: socket.remotePort ?? 0,
      stream,
    });
  }

  /**
   * 关闭并移除某地址的 server。
   *
   * @param host - 地址
   */
  private async closeServerOf(host: string): Promise<void> {
    const server = this.servers.get(host);
    if (server === undefined) return;
    this.servers.delete(host);
    await new Promise<void>(resolve => { server.close(() => resolve()); });
  }

  /**
   * 断言监听器未关闭。
   *
   * @throws RemoteError('CONNECT_FAILED') 已关闭
   */
  private assertNotClosed(): void {
    if (this.closed) {
      throw new RemoteError(
        'CONNECT_FAILED',
        `反向监听器已关闭（主机 ${this.hostAlias}）`,
        { hostAlias: this.hostAlias },
      );
    }
  }
}

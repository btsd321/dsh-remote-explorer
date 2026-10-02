/**
 * @file 会话编排
 * @description 把连接、引导、启动远端 dsh、建隧道、凭据代理、心跳、重连串成一个会话对象。
 *
 * 会话的生命周期：
 *
 * ```
 * open()  连接 → 读凭据材料 ┬ 已有 → 复用令牌与反向端口
 *                          └ 没有 → 生成令牌、绑定反向端口
 *         → 引导（patch 让 baseURL 指向反向端点）
 *         → 探既有远端进程 ┬ 命中 → 复用（跳过启动）
 *                          └ 未命中 → 启动 dsh（环境注入占位凭据）
 *         → 起本机 LLM 代理 → 挂反向转发 → 建正向隧道 → 登记 → 心跳
 * 心跳丢失达阈值 → 重连（有限次指数退避；远端进程存活则只换传输）
 * close() 停心跳 → 关隧道 → 撤反向转发 → 停代理 → 注销 →（可选）停远端
 * ```
 *
 * 凭据路径的关键约束：
 *
 * - **代理令牌与反向端口随会话固定**，落盘在远端 `.runtime/` 下（令牌 600 权限）。
 *   反向端口写进了 patch 的 baseURL，运行中的远端进程认它；换端口必须重启远端。
 *   复用会话、重连、换一个本机 CLI，读回的都是同一组值，代理校验才能通过。
 * - **代理实例与本机正向监听一样跨重连存活**：重连只重挂 `forwardIn`。
 * - 多个本机视图共享同一会话时，反向端口只能被一个传输持有（sshd 拒绝重复
 *   绑定）。后启动的视图挂不上反向转发时降级为警告——凭据路径由先来的视图维持。
 *
 * WSL 路径的反向端点编排（网络模式探测、ReverseListener「分配即绑定」、
 * 重连期端点重探与材料重写、反向链路自检）是与「会话生命周期」无关的独立
 * 变化轴，收口在同层模块 wsl-reverse.ts——本文件只在各阶段方法里分流调用，
 * SSH 路径行为不变。
 *
 * **远端 dsh 默认不随 CLI 退出而停止。** 它是 detach 的，下次连接可直接复用。
 * 要真正停掉需 `close({ stopRemote: true })` 或 `dsh-remote-explorer kill`。
 *
 * 模块导览（open 流水线按阶段拆分到子目录；本文件只做编排与生命周期，
 * open() 是流水线编排控制器，语句序与错误处理即契约）：
 *
 * - options.ts                    选项契约与 TransportType（本文件 re-export）
 * - transport/factory.ts          传输实例化与 SSH/WSL 认证准备
 * - open-pipeline/prepare.ts      阶段一：准备传输并连接（含各阶段上下文类型）
 * - open-pipeline/probe.ts        阶段二：探测环境/凭据材料/既有进程；
 *                                 阶段四：启动或复用远端进程
 * - open-pipeline/provision.ts    阶段三：引导与凭据配置
 * - open-pipeline/tunnels.ts      阶段五：隧道（含 launch 与反向转发挂接）
 *
 * 各阶段函数与传输工厂原为本文件私有静态方法/模块私有函数，拆分后为同层
 * 导出；函数体与契约注释随函数迁移，行为零变化。
 *
 * 分层：本文件属编排层，可用能力层与传输层。
 */

import { writeRemoteTextFile } from '../transport/write-text.js';
import { isAuthFailure } from '../transport/ssh-transport.js';
import type { ReverseHandle, RemoteTransport } from '../transport/types.js';
import type { ProvisionResult } from '../provision/provisioner.js';
import type { RemotePaths } from '../provision/remote-paths.js';
import { allocateRemotePorts } from '../tunnel/port-allocator.js';
import type { ReverseListener } from '../tunnel/reverse-listener.js';
import type { LocalForward } from '../tunnel/forward-local.js';
import { computeSessionId } from '../util/session-id.js';
import { RemoteError, toErrorMessage } from '../util/errors.js';
import type { PasswordProvider } from '../util/password-prompt.js';
import { probeExistingSession, stopRemoteDsh, type RemoteProcessInfo } from './remote-process.js';
import { Heartbeat, type HeartbeatResult } from './heartbeat.js';
import { backoffDelay, wait, DEFAULT_RECONNECT_CONFIG, type ReconnectConfig } from './reconnect.js';
import {
  DEFAULT_LIFECYCLE_CONFIG, INITIAL_STATE, describeState, isTerminal, transition,
  type LifecycleConfig, type SessionEvent, type SessionState,
} from './lifecycle-state.js';
import { removeSession, upsertSession } from './session-registry.js';
import { createTransport, resolveSshHost, type SshPrepareContext } from './transport/factory.js';
import { prepareTransport } from './open-pipeline/prepare.js';
import { probeAndReadCredentials, probeOrStartRemote } from './open-pipeline/probe.js';
import { provisionAndConfigure } from './open-pipeline/provision.js';
import { attachReverseForward, launch, setupTunnels } from './open-pipeline/tunnels.js';
import { checkWslReverseLink, refreshWslReverseOnReconnect } from './wsl-reverse.js';
import type { ProxySecret } from '../credential/proxy-secret.js';
import type { TunnelProxyCredential } from '../credential/tunnel-proxy.js';
import type { CloseSessionOptions, OpenSessionOptions } from './options.js';
import { createLogger } from '../util/logger.js';

// 选项契约已拆至同层 options.ts（类型宿主不再是本文件，无循环依赖风险）；
// re-export 维持 cli/plugin 等既有 import 路径零改动
export type { TransportType, OpenSessionOptions, CloseSessionOptions } from './options.js';

const log = createLogger('session-manager');

/**
 * RemoteSession 构造所需的内部依赖集合。
 *
 * 将原本散落的 10 个位置参数收进单一对象，避免长参数列表导致的
 * 可读性与维护性问题。仅在本文件内部使用，不对外导出。
 */
interface SessionInternals {
  /** 当前传输实例（重连时会被替换） */
  transport: RemoteTransport;
  /** 引导结果 */
  provisioned: ProvisionResult;
  /** 远端进程信息 */
  process: RemoteProcessInfo;
  /** 正向隧道 */
  forward: LocalForward;
  /** 凭据材料；undefined 表示该会话不带凭据路径。重连时 reverseHost 可能更新（WSL NAT 网关变化） */
  secret: ProxySecret | undefined;
  /** 凭据代理实例；无凭据路径时 undefined */
  credential: TunnelProxyCredential | undefined;
  /** 初始的反向转发句柄；挂在 transport 上（SSH 路径），重连时重挂 */
  reverseHandle: ReverseHandle | undefined;
  /**
   * WSL 反向监听（Windows 侧，分配即绑定）。
   *
   * 会话级资源：跨重连存活（不依赖传输实例），close 时释放；
   * SSH 路径恒 undefined（反向转发走 transport.forwardIn）。
   */
  reverseListener: ReverseListener | undefined;
  /** 重连配置 */
  reconnectConfig: ReconnectConfig;
  /** 生命周期参数 */
  lifecycleConfig: LifecycleConfig;
  /**
   * 会话级密码提供器：首次连接交互提示（或 --password 固定值），
   * 重连静默复用缓存；close 时清空
   */
  passwords: PasswordProvider | undefined;
}

/**
 * 一个已打开的远程会话。
 *
 * 通过 {@link openSession} 创建，不要直接 new——构造后还需要一系列
 * 异步初始化步骤，分开会让"半初始化的会话"成为可表达状态。
 */
export class RemoteSession {
  private state: SessionState = INITIAL_STATE;
  private heartbeat: Heartbeat | undefined;
  private closed = false;
  /** 重连串行化：避免多次心跳失败并发触发重连 */
  private reconnecting: Promise<void> | undefined;

  // --- 以下字段由 SessionInternals 注入 ---
  private transport: RemoteTransport;
  private provisioned: ProvisionResult;
  private process: RemoteProcessInfo;
  private readonly forward: LocalForward;
  /** 重连时 WSL 网关变化会更新 reverseHost，故非 readonly */
  private secret: ProxySecret | undefined;
  private credential: TunnelProxyCredential | undefined;
  private reverseHandle: ReverseHandle | undefined;
  /** WSL 反向监听；SSH 路径恒 undefined */
  private reverseListener: ReverseListener | undefined;
  private readonly reconnectConfig: ReconnectConfig;
  private readonly lifecycleConfig: LifecycleConfig;
  private readonly passwords: PasswordProvider | undefined;

  /**
   * @param sessionId - 会话 id
   * @param options - 打开选项
   * @param internals - 内部依赖集合（传输、引导结果、进程信息、隧道、凭据等）
   */
  private constructor(
    readonly sessionId: string,
    private readonly options: OpenSessionOptions,
    internals: SessionInternals,
  ) {
    this.transport = internals.transport;
    this.provisioned = internals.provisioned;
    this.process = internals.process;
    this.forward = internals.forward;
    this.secret = internals.secret;
    this.credential = internals.credential;
    this.reverseHandle = internals.reverseHandle;
    this.reverseListener = internals.reverseListener;
    this.reconnectConfig = internals.reconnectConfig;
    this.lifecycleConfig = internals.lifecycleConfig;
    this.passwords = internals.passwords;
  }

  /**
   * 窄 exec 委托：监督器的远端插件管理复用当前传输。
   *
   * 重连换传输由本类内部维护，调用方拿到的永远是活的那条；不暴露
   * transport 本体，避免上层绕过编排层直接改连接状态。
   *
   * @param command - 远端命令（不经 sh -c 之外的包装，与 exec 语义一致）
   * @param options - exec 选项
   * @returns exec 结果
   */
  exec(
    command: string,
    options?: Parameters<RemoteTransport['exec']>[1],
  ): ReturnType<RemoteTransport['exec']> {
    return this.transport.exec(command, options);
  }

  /**
   * 远端路径集合（引导结果的一部分）：监督器的远端插件管理要拼
   * profile 目录与 mirror-cache 位置，收口在这里避免上层自己拼路径。
   */
  get remotePaths(): RemotePaths {
    return this.provisioned.paths;
  }

  /**
   * 写远端文本文件委托（SFTP 主路径）：监督器改远端 profile 清单用。
   *
   * @param path - 远端绝对路径
   * @param content - 文本内容
   */
  async writeRemoteFile(path: string, content: string): Promise<void> {
    await writeRemoteTextFile(this.transport, path, content, {});
  }

  /** 浏览器访问地址（含令牌） */
  get url(): string {
    return `http://127.0.0.1:${this.forward.localPort}/?token=${this.process.token}`;
  }

  /** 本机转发端口 */
  get localPort(): number {
    return this.forward.localPort;
  }

  /** 远端监听端口 */
  get remotePort(): number {
    return this.process.port;
  }

  /** 远端 dsh 进程 pid */
  get remotePid(): number {
    return this.process.pid;
  }

  /** 反向隧道端口；无凭据路径时 undefined */
  get reversePort(): number | undefined {
    return this.secret?.reversePort;
  }

  /**
   * 本机缺失真实 key 的环境变量名列表（跨全部路由）。
   *
   * 空列表表示所有供应商的 key 都已就位。
   */
  get missingKeyEnvs(): string[] {
    return this.credential?.missingKeyEnvs ?? [];
  }

  /** 代理路由数（含 DeepSeek 原生通道与 pi-ai 供应商） */
  get routeCount(): number {
    return this.credential?.routeCount ?? 0;
  }

  /** 当前状态 */
  get currentState(): SessionState {
    return this.state;
  }

  /** 引导结果（版本信息等） */
  get provisionResult(): ProvisionResult {
    return this.provisioned;
  }

  /**
   * 打开一个会话。
   *
   * 编排入口：按阶段顺序调用 open-pipeline 各导出函数，自身只做流程串联
   * 与资源兜底。
   *
   * @param options - 打开选项
   * @returns 已就绪的会话
   */
  static async open(options: OpenSessionOptions): Promise<RemoteSession> {
    const sessionId = computeSessionId(options.hostAlias, options.remoteCwd);
    const reconnectConfig = { ...DEFAULT_RECONNECT_CONFIG, ...options.reconnect };
    const lifecycleConfig = { ...DEFAULT_LIFECYCLE_CONFIG, ...options.lifecycle };

    // 1. 准备传输并连接
    const { transport, passwords } = await prepareTransport(options);

    let session: RemoteSession | undefined;
    let reverseListener: ReverseListener | undefined;
    try {
      // 2. 探测远端环境、读取/生成凭据材料、探既有进程
      const probeCtx = await probeAndReadCredentials(
        transport, sessionId, options,
      );
      reverseListener = probeCtx.reverseListener;

      // 3. 引导、配置凭据策略、同步 settings、落盘新材料
      const provisionCtx = await provisionAndConfigure(
        transport, sessionId, options, probeCtx,
      );

      // 4. 启动或复用远端进程
      const processInfo = await probeOrStartRemote(
        transport, sessionId, options, probeCtx.processInfo, probeCtx.webPort,
        provisionCtx.provisioned, provisionCtx.credential,
      );

      // 5. 建隧道（反向转发 + 正向隧道）
      const tunnelCtx = await setupTunnels(
        transport, options, processInfo, provisionCtx.credential, probeCtx.reverseListener,
      );

      // 6. 构造会话对象并注册
      session = new RemoteSession(sessionId, options, {
        transport,
        provisioned: provisionCtx.provisioned,
        process: processInfo,
        forward: tunnelCtx.forward,
        secret: probeCtx.secret,
        credential: provisionCtx.credential,
        reverseHandle: tunnelCtx.reverseHandle,
        reverseListener: probeCtx.reverseListener,
        reconnectConfig,
        lifecycleConfig,
        passwords,
      });
      session.apply({ type: 'connect-ready' });
      session.register();
      session.startHeartbeat();
      log.info(`会话完全就绪: sessionId=${sessionId}, url=${session.url}`);
      return session;
    } catch (error) {
      // 打开失败要释放已建立的资源：SSH 连接、反向监听（分配即绑定——
      // 绑定后不释放就泄漏端口，正是旧幽灵占用问题的镜像面）
      await transport.dispose();
      await reverseListener?.close().catch(() => { /* 关闭失败不影响错误上抛 */ });
      throw error;
    }
  }

  /**
   * 关闭会话。
   *
   * @param options - 关闭选项
   */
  async close(options: CloseSessionOptions = {}): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    this.heartbeat?.stop();
    await this.forward.close();
    await this.detachReverseForward();
    // WSL 反向监听随会话释放（幂等；SSH 的反向转发已在上一行经句柄撤销）
    await this.reverseListener?.close().catch(() => { /* 关闭失败不影响其余清理 */ });
    await this.credential?.stop();
    // 会话结束即丢弃缓存密码的引用（字符串不可清零，只能靠 GC 回收）
    this.passwords?.clear();
    removeSession(this.sessionId, process.pid);

    if (options.stopRemote === true) {
      try {
        await stopRemoteDsh(
          { transport: this.transport, paths: this.provisioned.paths },
          { sessionId: this.sessionId, port: this.process.port },
        );
      } catch { /* 停远端失败不应阻碍本机清理 */ }
    }

    await this.transport.dispose();
    this.apply({ type: 'disconnect' });
  }

  /** 登记到本机会话表 */
  private register(): void {
    upsertSession({
      sessionId: this.sessionId,
      hostAlias: this.options.hostAlias,
      remoteCwd: this.options.remoteCwd,
      localPort: this.forward.localPort,
      remotePort: this.process.port,
      ...(this.secret ? { reversePort: this.secret.reversePort } : {}),
      remotePid: this.process.pid,
      localPid: process.pid,
      startedAt: new Date().toISOString(),
    });
  }

  /** 启动心跳循环 */
  private startHeartbeat(): void {
    this.heartbeat = new Heartbeat(
      () => this.transport,
      // 令牌随取随用：重连可能换进程（新令牌），取实时值
      () => ({ pid: this.process.pid, port: this.process.port, token: this.process.token }),
      (result) => this.onHeartbeat(result),
    );
    this.heartbeat.start();
  }

  /**
   * 处理一次心跳结果。
   *
   * @param result - 心跳结果
   */
  private onHeartbeat(result: HeartbeatResult): void {
    if (this.closed) return;

    const before = this.state.tag;
    this.apply(result.isHealthy
      ? { type: 'heartbeat-ok' }
      : { type: 'heartbeat-fail' });

    // 状态机判定该重连了（heartbeat-fail 达阈值会转成 reconnecting）
    if (before !== 'reconnecting' && this.state.tag === 'reconnecting') {
      void this.beginReconnect();
    }
  }

  /**
   * 启动重连流程；并发调用会复用同一次。
   */
  private async beginReconnect(): Promise<void> {
    this.reconnecting ??= this.runReconnect().finally(() => { this.reconnecting = undefined; });
    return this.reconnecting;
  }

  /**
   * 执行有限次指数退避重连。
   */
  private async runReconnect(): Promise<void> {
    this.heartbeat?.stop();

    if (!this.reconnectConfig.enabled) {
      this.apply({ type: 'fail', error: '自动重连已禁用' });
      return;
    }

    for (let attempt = 1; attempt <= this.reconnectConfig.maxAttempts; attempt += 1) {
      if (this.closed) return;

      this.apply({ type: 'reconnect-start' });
      try {
        await wait(backoffDelay(attempt, this.reconnectConfig));
        await this.reconnectOnce();
        this.apply({ type: 'reconnect-ok' });
        this.register();
        this.startHeartbeat();
        return;
      } catch (error) {
        this.apply({ type: 'reconnect-fail', error: toErrorMessage(error) });
        // 密码/密钥被服务端拒绝：等退避再试也不会好，直接终结重连
        if (isAuthFailure(error)) {
          this.apply({ type: 'fail', error: '认证失败：密码或密钥已失效，请重新 connect' });
          break;
        }
        if (isTerminal(this.state)) break;
      }
    }

    // 重连用尽：注销本进程这条视图，让 status 不再显示一个已死的隧道。
    // 远端 dsh 可能仍在跑——它是 detach 的，下次 connect 会探到并复用
    removeSession(this.sessionId, process.pid);
  }

  /**
   * 执行一次重连。
   *
   * 远端 dsh 是 detach 的，SSH 断了它通常还活着，所以先探测复用；
   * 只有确认它已退出才重新启动。
   */
  private async reconnectOnce(): Promise<void> {
    // 按传输类型各自准备重连上下文。
    // 新增传输类型时在此添加对应 case，不影响已有分支
    let sshCtx: SshPrepareContext;
    switch (this.options.transportType ?? 'ssh') {
      case 'ssh': {
        // 无人值守：只复用已缓存的密码（peek），绝不弹交互提示
        const resolved = resolveSshHost(this.options);
        sshCtx = {
          resolved,
          getPassword: (hostKey, label, attempt) =>
            Promise.resolve(this.passwords?.peek(hostKey, label, attempt)),
        };
        break;
      }
      case 'wsl': {
        // WSL 重连无需重新解析主机或提供密码
        sshCtx = { resolved: undefined as never, getPassword: async () => undefined };
        break;
      }
    }
    const next = createTransport(this.options, sshCtx);

    try {
      await next.connect();

      // WSL：重探网络模式。NAT 网关 IP 随 WSL 重启变化，端点变化必须在
      // 重启远端进程之前完成材料刷新（reverse-host 与 patch 里的 baseURL）
      if (this.options.transportType === 'wsl' && this.secret) {
        await this.refreshWslReverseOnReconnect(next);
      }

      const existing = await probeExistingSession(
        { transport: next, paths: this.provisioned.paths },
        this.sessionId,
      );
      if (existing) {
        this.process = existing;
      } else {
        // 远端进程确实没了，重新启动。引导结果仍有效（安装未变），不必重跑引导。
        // 凭据材料保持不变（落盘的令牌与反向端口），占位凭据继续生效
        const exclude = this.credential ? [this.credential.reversePort] : [];
        const [port] = await allocateRemotePorts(next, 1, { exclude });
        if (port === undefined) {
          throw new RemoteError(
            'CONNECT_FAILED',
            `重连时为主机 ${this.options.hostAlias} 分配远端端口失败`,
            { hostAlias: this.options.hostAlias },
          );
        }
        // 重连重启远端进程时同样注入用户 env 与代理（open() 的同一合并语义）
        // 与 WSL 用户名；不传 stage 回调——重连是后台行为，不向前端重复报
        // 阶段进度（既有语义）
        this.process = await launch(
          next, this.provisioned, this.sessionId,
          {
            ...(this.options.extraEnv !== undefined ? { extraEnv: this.options.extraEnv } : {}),
            ...(this.options.proxy !== undefined ? { proxy: this.options.proxy } : {}),
            ...(this.options.wslUser !== undefined ? { wslUser: this.options.wslUser } : {}),
          },
          port, this.credential,
        );
      }

      // 重挂反向转发：旧句柄随旧传输失效，代理实例不动。
      // WSL 的 ReverseListener 跨重连存活（不依赖传输实例），handler 指向
      // 同一代理实例无需重挂——只做一次链路自检确认新链路可用
      await this.detachReverseForward();
      if (this.credential) {
        if (this.reverseListener !== undefined) {
          // 重连是后台行为：不报阶段进度，自检结果只进运行日志
          await checkWslReverseLink(next, this.credential, {});
        } else {
          this.reverseHandle = await attachReverseForward(next, this.credential, this.options);
        }
      }
    } catch (error) {
      await next.dispose();
      throw error;
    }

    // 换掉传输：旧连接已失效，隧道监听器保持不变（端口不变，浏览器无需刷新）
    const previous = this.transport;
    this.transport = next;
    this.forward.swapTransport(next);
    await previous.dispose();
  }

  /**
   * WSL 重连的反向端点刷新（薄委托）。
   *
   * 每次重连都重新探测网络模式（契约：NAT 网关 IP 随 WSL 重启变化）。
   * host 变化时：调整监听的附加绑定（主绑定 127.0.0.1 与端口不动——远端
   * 材料认的就是它们）、更新会话记录与凭据策略、重写远端材料
   * （reverse-host、profile patch、settings 镜像、home patch）。材料重写
   * 必须先于远端进程（重）启动，所以本方法只在 reconnectOnce 探测/启动
   * 远端进程之前调用。
   *
   * 纯网络探测/材料重写逻辑在同层模块 wsl-reverse 的同名导出函数；本方法
   * 把会话状态（secret/credential/provisioned/listener）以参数显式传入，
   * 并把返回的更新后 secret 回写会话字段。
   *
   * @param next - 重连后的新传输实例（探测与材料写入都走它）
   */
  private async refreshWslReverseOnReconnect(next: RemoteTransport): Promise<void> {
    const listener = this.reverseListener;
    const secret = this.secret;
    if (listener === undefined || secret === undefined) return;
    this.secret = await refreshWslReverseOnReconnect(next, {
      sessionId: this.sessionId,
      provisioned: this.provisioned,
      secret,
      credential: this.credential,
      listener,
    });
  }

  /**
   * 撤掉当前的反向转发句柄（不停止代理本身）。
   */
  private async detachReverseForward(): Promise<void> {
    const handle = this.reverseHandle;
    this.reverseHandle = undefined;
    if (handle) {
      await handle.close().catch(() => { /* 连接已断时撤销失败，远端监听随连接消失 */ });
    }
  }

  /**
   * 应用状态机事件并通知回调。
   *
   * @param event - 事件
   */
  private apply(event: SessionEvent): void {
    const next = transition(this.state, event, this.lifecycleConfig);
    if (next === this.state) return;
    this.state = next;
    this.options.onStateChange?.(next, describeState(next));
  }
}

/**
 * 打开一个远程会话。
 *
 * @param options - 打开选项
 * @returns 已就绪的会话
 */
export async function openSession(options: OpenSessionOptions): Promise<RemoteSession> {
  return RemoteSession.open(options);
}

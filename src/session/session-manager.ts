/**
 * @file 会话编排
 * @description 把连接、引导、启动远端 dsh、建隧道、心跳、重连串成一个会话对象。
 *
 * 会话的生命周期：
 *
 * ```
 * open()  连接 → 探既有会话 ┬ 命中 → 复用（跳过引导与启动）
 *                          └ 未命中 → 引导 → 分配端口 → 启动 dsh
 *         → 建正向隧道 → 登记会话表 → 启动心跳
 * 心跳丢失达阈值 → 重连（有限次指数退避）
 *         ┬ 远端 dsh 仍存活 → 换传输、复用进程
 *         └ 远端 dsh 已退出 → 重新启动
 * close() 停心跳 → 关隧道 → 注销会话表 →（可选）停远端 dsh
 * ```
 *
 * **远端 dsh 默认不随 CLI 退出而停止。** 它是 detach 的，CLI 退出后仍在跑，
 * 下次连接可直接复用——这正是 detach 的目的，也让"本机网络切换"这类
 * 常见中断不至于丢失远端状态。要真正停掉需显式调用 `close({ stopRemote: true })`。
 *
 * 分层：本文件属编排层，可用能力层与传输层。
 */

import { assertConnectable, resolveHost } from '../hosts/ssh-config-parser.js';
import { SshTransport } from '../transport/ssh-transport.js';
import { provision, type ProvisionResult } from '../provision/provisioner.js';
import { allocateRemotePorts } from '../tunnel/port-allocator.js';
import { LocalForward } from '../tunnel/forward-local.js';
import { computeSessionId } from '../util/session-id.js';
import { RemoteError, toErrorMessage } from '../util/errors.js';
import { probeExistingSession, startRemoteDsh, stopRemoteDsh, type RemoteProcessInfo } from './remote-process.js';
import { Heartbeat, type HeartbeatResult } from './heartbeat.js';
import { backoffDelay, wait, DEFAULT_RECONNECT_CONFIG, type ReconnectConfig } from './reconnect.js';
import {
  DEFAULT_LIFECYCLE_CONFIG, INITIAL_STATE, describeState, isTerminal, transition,
  type LifecycleConfig, type SessionEvent, type SessionState,
} from './lifecycle-state.js';
import { removeSession, upsertSession } from './session-registry.js';
import type { RemoteTransport } from '../transport/types.js';

/** 会话打开选项 */
export interface OpenSessionOptions {
  /** 主机别名 */
  hostAlias: string;
  /** 远端工作目录；参与会话 id 计算 */
  remoteCwd: string;
  /** 目标 Node 版本 */
  nodeVersion?: string;
  /** 目标 dsh 版本或 dist-tag */
  dshVersion?: string;
  /** 本机期望端口；0 表示由 OS 分配 */
  localPort?: number;
  /** 强制重新启动远端 dsh，即便既有会话可用 */
  forceRestart?: boolean;
  /** 强制重测镜像 */
  refreshMirrors?: boolean;
  /** 重连配置 */
  reconnect?: Partial<ReconnectConfig>;
  /** 生命周期参数 */
  lifecycle?: Partial<LifecycleConfig>;
  /** 阶段进度回调 */
  onStageStart?: (stage: string) => void;
  /** 阶段完成回调 */
  onStageDone?: (detail?: string) => void;
  /** 阶段跳过回调 */
  onStageSkip?: (reason: string) => void;
  /** 状态变化回调 */
  onStateChange?: (state: SessionState, description: string) => void;
}

/** 会话关闭选项 */
export interface CloseSessionOptions {
  /** 是否同时停止远端 dsh 进程；默认 false（保留以便下次复用） */
  stopRemote?: boolean;
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

  /**
   * @param sessionId - 会话 id
   * @param options - 打开选项
   * @param transport - 当前传输实例（重连时会被替换）
   * @param provisioned - 引导结果
   * @param process - 远端进程信息
   * @param forward - 正向隧道
   * @param reconnectConfig - 重连配置
   * @param lifecycleConfig - 生命周期参数
   */
  private constructor(
    readonly sessionId: string,
    private readonly options: OpenSessionOptions,
    private transport: RemoteTransport,
    private provisioned: ProvisionResult,
    private process: RemoteProcessInfo,
    private readonly forward: LocalForward,
    private readonly reconnectConfig: ReconnectConfig,
    private readonly lifecycleConfig: LifecycleConfig,
  ) {}

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
   * @param options - 打开选项
   * @returns 已就绪的会话
   */
  static async open(options: OpenSessionOptions): Promise<RemoteSession> {
    const resolved = resolveHost(options.hostAlias);
    assertConnectable(resolved, options.hostAlias);
    const sessionId = computeSessionId(options.hostAlias, options.remoteCwd);

    const reconnectConfig = { ...DEFAULT_RECONNECT_CONFIG, ...options.reconnect };
    const lifecycleConfig = { ...DEFAULT_LIFECYCLE_CONFIG, ...options.lifecycle };

    options.onStageStart?.('建立 SSH 连接');
    const transport = new SshTransport(options.hostAlias, resolved);
    await transport.connect();
    options.onStageDone?.(`${transport.platform.rawOs} ${transport.platform.rawArch}`);

    let session: RemoteSession | undefined;
    try {
      // 引导。已装则各步复用，很快
      const provisioned = await provision(transport, {
        sessionId,
        ...(options.nodeVersion ? { nodeVersion: options.nodeVersion } : {}),
        ...(options.dshVersion ? { dshVersion: options.dshVersion } : {}),
        ...(options.refreshMirrors ? { refreshMirrors: true } : {}),
        ...(options.onStageStart ? { onStageStart: options.onStageStart } : {}),
        ...(options.onStageDone ? { onStageDone: options.onStageDone } : {}),
        ...(options.onStageSkip ? { onStageSkip: options.onStageSkip } : {}),
      });

      // 探既有会话：命中则跳过启动，直接接管
      options.onStageStart?.('检查既有远端会话');
      let processInfo: RemoteProcessInfo | undefined;
      if (options.forceRestart === true) {
        await stopRemoteDsh(transport, provisioned.paths, { sessionId });
        options.onStageSkip?.('已按要求重启');
      } else {
        processInfo = await probeExistingSession(transport, provisioned.paths, sessionId);
        if (processInfo) options.onStageDone?.(`复用 pid ${processInfo.pid}`);
        else options.onStageSkip?.('无可用会话，将启动新实例');
      }

      if (!processInfo) {
        processInfo = await RemoteSession.launch(transport, provisioned, sessionId, options);
      }

      // 建正向隧道。监听器跨重连存活，端口从此不再变化
      options.onStageStart?.('建立正向隧道');
      const forward = new LocalForward(transport, '127.0.0.1', processInfo.port);
      const localPort = await forward.listen(options.localPort ?? 0);
      options.onStageDone?.(`127.0.0.1:${localPort} → 远端 ${processInfo.port}`);

      session = new RemoteSession(
        sessionId, options, transport, provisioned, processInfo,
        forward, reconnectConfig, lifecycleConfig,
      );
      session.apply({ type: 'connect-ready' });
      session.register();
      session.startHeartbeat();
      return session;
    } catch (error) {
      // 打开失败要释放已建立的资源，否则 SSH 连接会泄漏
      await transport.dispose();
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
    // 只注销本进程这一条视图：同一远端会话可能还有别的 CLI 在维持隧道
    removeSession(this.sessionId, process.pid);

    if (options.stopRemote === true) {
      try {
        await stopRemoteDsh(this.transport, this.provisioned.paths, {
          sessionId: this.sessionId,
          port: this.process.port,
        });
      } catch { /* 停远端失败不应阻碍本机清理 */ }
    }

    await this.transport.dispose();
    this.apply({ type: 'disconnect' });
  }

  /**
   * 启动远端 dsh。
   *
   * 端口分配有固有竞态（探到空闲与实际绑定之间存在窗口），
   * 所以失败后换端口重试一次。
   *
   * @param transport - 传输实例
   * @param provisioned - 引导结果
   * @param sessionId - 会话 id
   * @param options - 打开选项
   * @returns 远端进程信息
   */
  private static async launch(
    transport: RemoteTransport,
    provisioned: ProvisionResult,
    sessionId: string,
    options: Pick<OpenSessionOptions, 'onStageStart' | 'onStageDone'>,
  ): Promise<RemoteProcessInfo> {
    const tried: number[] = [];
    let lastError: unknown;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const [port] = await allocateRemotePorts(transport, 1, { exclude: tried });
      tried.push(port!);

      options.onStageStart?.(`启动远端 dsh（端口 ${port}）`);
      try {
        const info = await startRemoteDsh(transport, provisioned.paths, {
          sessionId,
          dshBin: provisioned.dsh.dshBin,
          dshHome: provisioned.profile.dshHome,
          profileName: provisioned.profile.profileName,
          nodeBinDir: provisioned.node.binDir,
          port: port!,
          ...(provisioned.profile.patchFile ? { patchFile: provisioned.profile.patchFile } : {}),
        });
        options.onStageDone?.(`pid ${info.pid}`);
        return info;
      } catch (error) {
        lastError = error;
        // 端口冲突是预期内的竞态，换端口重试；其他错误重试也无意义，但
        // 区分成本高于收益——第二次失败就会如实抛出
      }
    }

    throw new RemoteError(
      'EXEC_FAILED',
      `在主机 ${transport.hostAlias} 上启动远端 dsh 失败（已试端口 ${tried.join('、')}）：`
        + toErrorMessage(lastError),
      { cause: lastError, hostAlias: transport.hostAlias },
    );
  }

  /** 登记到本机会话表 */
  private register(): void {
    upsertSession({
      sessionId: this.sessionId,
      hostAlias: this.options.hostAlias,
      remoteCwd: this.options.remoteCwd,
      localPort: this.forward.localPort,
      remotePort: this.process.port,
      remotePid: this.process.pid,
      localPid: process.pid,
      startedAt: new Date().toISOString(),
    });
  }

  /** 启动心跳循环 */
  private startHeartbeat(): void {
    this.heartbeat = new Heartbeat(
      () => this.transport,
      () => ({ pid: this.process.pid, port: this.process.port }),
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
    const resolved = resolveHost(this.options.hostAlias);
    const next = new SshTransport(this.options.hostAlias, resolved);

    try {
      await next.connect();

      const existing = await probeExistingSession(next, this.provisioned.paths, this.sessionId);
      if (existing) {
        this.process = existing;
      } else {
        // 远端进程确实没了，重新启动。引导结果仍有效（安装未变），不必重跑引导
        this.process = await RemoteSession.launch(next, this.provisioned, this.sessionId, {});
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

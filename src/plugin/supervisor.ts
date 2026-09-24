/**
 * @file 插件会话监督器
 * @description 插件宿主进程内的会话簿记：非阻塞发起连接、把 openSession 的
 *              五个回调收进有界日志缓冲、维护状态快照，供 slash 命令、agent
 *              工具与面板路由三个消费面共用。
 *
 * 与 CLI 的关系：编排逻辑全部复用 session/ 层（openSession + 回调），本模块
 * 只做「进程内多会话的登记表 + 日志缓冲」，等价于 CLI 里 connect.ts 的
 * ProgressReporter 接线 + session-registry 的角色，但呈现通道换成快照轮询。
 *
 * 落盘会话表（~/.dsh/remote-sessions.json）继续由 openSession 内部维护：
 * 插件宿主下 process.pid 是 dsh 进程的 pid，(sessionId, localPid) 主键语义
 * 恰好成立——一个宿主进程 = 一个本机视图。CLI `status` 与插件面板因此能
 * 互相看见对方维持的会话（对方进程的行标记 external，只读）。
 *
 * 凭据纪律：password 只随 ConnectRequest 存在于本进程内存（透传给
 * openSession 的 fixed 模式），绝不进日志缓冲、快照与错误消息。
 */

import { openSession, type RemoteSession, type TransportType } from '../session/session-manager.js';
import { HANDOFF_PROTOCOL_VERSION, type ManageHandlers } from '../handoff/protocol.js';
import { listSessions } from '../session/session-registry.js';
import { INITIAL_STATE, type SessionState } from '../session/lifecycle-state.js';
import { computeSessionId } from '../util/session-id.js';
import { normalizeRemoteCwd, validateRemoteCwd } from '../util/remote-cwd.js';
import { toErrorMessage } from '../util/errors.js';
import { RemotePluginStore, type PluginStoreHost } from './remote-plugin-store.js';

/** 每会话日志缓冲上限（超出丢最旧；面板按 seq 增量拉取，够用即可） */
const MAX_LOG_ENTRIES = 1_000;

/** 快照里附带的日志尾部条数（列表视图用，详情走增量接口） */
const LOG_TAIL_SIZE = 20;

/** 日志条目类别（只允许 info/warn/error + state 生命周期） */
export type LogKind =
  /** 生命周期状态变化 */
  | 'state'
  /** 错误（连接失败、转发失败等） */
  | 'error'
  /** 警告 */
  | 'warn'
  /** 一般信息（含阶段进度，以 [开始]/[完成]/[跳过] 前缀区分） */
  | 'info';

/** 一条面板/命令可读的日志 */
export interface LogEntry {
  /** 单调递增序号（增量拉取用 ?since=seq） */
  seq: number;
  /** ISO 8601 时间戳 */
  ts: string;
  /** 类别 */
  kind: LogKind;
  /** 内容（中文；绝不含密码/令牌） */
  text: string;
}

/** 会话快照（命令文本、工具 JSON、面板路由的共用数据形状） */
export interface SessionSnapshot {
  /** 会话 id（远端身份，主机别名+目录算出） */
  sessionId: string;
  /** 主机别名或 user@host[:port] */
  hostAlias: string;
  /** 远端工作目录；空串 = 远端家目录 */
  remoteCwd: string;
  /** 传输类型 */
  transportType: TransportType;
  /** 生命周期状态 */
  state: SessionState;
  /** 是否正在后台连接中（openSession 尚未返回） */
  connecting: boolean;
  /** 连接失败原因；成功后清空 */
  connectError?: string;
  /** 本机转发端口（就绪后可用） */
  localPort?: number;
  /** 远端 dsh 监听端口 */
  remotePort?: number;
  /** 远端 dsh 进程 pid */
  remotePid?: number;
  /** 浏览器访问地址（含远端令牌；就绪后可用） */
  url?: string;
  /** 发起时间（ISO 8601） */
  startedAt: string;
  /** 本机缺失真实 key 的环境变量名（就绪后可用） */
  missingKeyEnvs?: string[];
  /** 是否其他本机进程维持的视图（只读；管理请用 CLI 或对应进程） */
  external?: boolean;
  /** 日志尾部（列表视图用） */
  logTail?: LogEntry[];
}

/** 发起连接的请求（命令/工具/面板路由统一入口） */
export interface ConnectRequest {
  /** 主机别名或 user@host[:port]（必填） */
  hostAlias: string;
  /** 远端工作目录；缺省用插件配置的 cwd */
  cwd?: string;
  /** 传输类型；默认 'ssh' */
  transportType?: TransportType;
  /** WSL 发行版名称（transportType='wsl' 时必需） */
  distroName?: string;
  /** WSL 用户名 */
  wslUser?: string;
  /** 本机端口；0/缺省 = 插件配置或 OS 分配 */
  localPort?: number;
  /** 强制重启远端 dsh */
  forceRestart?: boolean;
  /** 强制重测镜像 */
  refreshMirrors?: boolean;
  /** Node 版本覆盖 */
  nodeVersion?: string;
  /** dsh 版本覆盖 */
  dshVersion?: string;
  /** 私钥路径覆盖（面板高级项） */
  privateKey?: string;
  /** 密码（面板表单；只存本进程内存，绝不进日志） */
  password?: string;
  /**
   * 本机管理页 origin（面板发起连接时带 location.origin）。
   * 经 meta 路由交给远端 handoff 组件渲染「返回/并返回」动作；缺省则远端菜单只读
   */
  managerUrl?: string;
}

// 构建期注入（build-plugin.ts 的 define，ping 路由同款）；dev 流程不会调到 meta 闭包
declare const __PLUGIN_VERSION__: string;

/** 监督器错误的机器可读类别（agent 工具按 code 分支，不解析消息） */
export type SupervisorErrorCode =
  /** 调用方用法错误（缺参数等） */
  | 'bad_usage'
  /** 远端目录非法（含 MSYS 改写防御） */
  | 'invalid_cwd'
  /** 同会话正在连接或已连接 */
  | 'already_active'
  /** 找不到目标会话 */
  | 'not_found'
  /** 会话仍在连接中，不能断开（等它成功或失败） */
  | 'still_connecting'
  /** 目标是其他进程维持的视图，本进程无权断开 */
  | 'external_session'
  /** 远端插件操作失败（pnpm 退出非零、清单损坏等） */
  | 'remote_plugin';

/**
 * 监督器错误：带机器可读 code 的 Error。
 */
export class SupervisorError extends Error {
  /**
   * @param code - 错误类别
   * @param message - 中文消息（含定位信息）
   */
  constructor(readonly code: SupervisorErrorCode, message: string) {
    super(message);
    this.name = 'SupervisorError';
  }
}

/** 远端插件清单项（profile inventory 投影，形状对齐 harness ProfilePluginInventory） */
export interface RemotePluginInfo {
  /** 包名 */
  name: string;
  /** 已装版本（node_modules 里 package.json 的 version） */
  version: string;
  /** 是否声明 dsh.bundle.patch（是 bundle 而非普通依赖） */
  bundle: boolean;
  /** 是否在 bundles 列表里（启用中） */
  enabled: boolean;
}

/** 监督器的默认值来源（插件 Config 的子集） */
export interface SupervisorDefaults {
  /** 默认远端工作目录 */
  cwd: string;
  /** 默认本机端口（0 = OS 分配） */
  localPort: number;
  /** 默认 Node 版本（空 = provisioner 默认） */
  nodeVersion: string;
  /** 默认 dsh 版本（空 = provisioner 默认） */
  dshVersion: string;
  /** 默认强制重启 */
  forceRestart: boolean;
  /** 默认重测镜像 */
  refreshMirrors: boolean;
}

/** 一个被监督的会话（进程内登记项） */
interface SupervisedSession {
  /** 会话 id */
  sessionId: string;
  /** 主机别名 */
  hostAlias: string;
  /** 归一化后的远端目录 */
  remoteCwd: string;
  /** 传输类型 */
  transportType: TransportType;
  /** 生命周期状态（回调驱动更新） */
  state: SessionState;
  /** 是否正在连接 */
  connecting: boolean;
  /** 连接失败原因 */
  connectError: string | undefined;
  /** 就绪的会话对象 */
  session: RemoteSession | undefined;
  /** 日志缓冲（有界） */
  log: LogEntry[];
  /** 下一条日志的序号 */
  seq: number;
  /** 发起时间 */
  startedAt: string;
  /** 本机管理页 origin（面板连接时带来；CLI/命令发起缺省） */
  managerUrl: string | undefined;
}

/**
 * 进程内会话监督器。
 *
 * 生命周期与插件 fiber 一致：apply 时创建，dispose effect 里 disposeAll。
 * 所有公开方法都是同步返回或快速返回——耗时的 openSession 在后台跑，
 * 进度经日志缓冲暴露，消费面轮询。
 */
export class SessionSupervisor {
  private readonly sessions = new Map<string, SupervisedSession>();
  /** 远端插件包管理器（从本类拆出，经回调注入会话访问能力） */
  private readonly pluginStore: RemotePluginStore;

  /**
   * @param defaults - 插件配置提供的默认值
   */
  constructor(private readonly defaults: SupervisorDefaults) {
    // 构造 host 适配器：把监督器的内部能力投影成 PluginStoreHost 窄接口，
    // 让 RemotePluginStore 不直接依赖 SessionSupervisor 类
    const host: PluginStoreHost = {
      getReadySession: (sessionId) => this.requireReadySession(sessionId).session,
      pushLog: (sessionId, kind, text) => {
        const record = this.sessions.get(sessionId);
        if (record !== undefined) this.push(record, kind, text);
      },
      makeError: (code, message) => new SupervisorError(code, message),
    };
    this.pluginStore = new RemotePluginStore(host);
  }

  /**
   * 非阻塞发起连接。
   *
   * @param request - 连接请求
   * @returns 目标会话的即时快照（state=connecting）
   * @throws SupervisorError('invalid_cwd') 远端目录非法
   * @throws SupervisorError('already_active') 同会话已在连接或已连接
   */
  startConnect(request: ConnectRequest): SessionSnapshot {
    // 1. 目录校验与归一化（MSYS 防御与 CLI 同一份逻辑）
    const rawCwd = request.cwd ?? this.defaults.cwd;
    const cwdError = validateRemoteCwd(rawCwd);
    if (cwdError !== undefined) {
      throw new SupervisorError('invalid_cwd', cwdError);
    }
    const remoteCwd = normalizeRemoteCwd(rawCwd);
    const sessionId = computeSessionId(request.hostAlias, remoteCwd);

    // 2. 去重：同会话正在连接或已连接时拒绝（复用既有会话请加 forceRestart
    //    前先断开，或直接打开已有会话的 url）
    const existing = this.sessions.get(sessionId);
    if (existing !== undefined && (existing.connecting || existing.session !== undefined)) {
      throw new SupervisorError(
        'already_active',
        `会话 ${request.hostAlias}:${remoteCwd || '~'} 已在${existing.connecting ? '连接中' : '运行中'}（${sessionId.slice(0, 12)}…）`,
      );
    }

    // 3. 登记 + 后台打开
    const transportType: TransportType = request.transportType ?? 'ssh';
    const record: SupervisedSession = {
      sessionId,
      hostAlias: request.hostAlias,
      remoteCwd,
      transportType,
      state: INITIAL_STATE,
      connecting: true,
      connectError: undefined,
      session: undefined,
      log: [],
      seq: 0,
      startedAt: new Date().toISOString(),
      managerUrl: request.managerUrl,
    };
    this.sessions.set(sessionId, record);
    this.push(record, 'info', `发起连接 ${request.hostAlias} → ${remoteCwd || '远端家目录'}`);
    void this.runOpen(record, request);
    return this.snapshotOf(record);
  }

  /**
   * 断开一个会话。
   *
   * @param target - 会话 id 或主机别名（别名命中多条时取活跃的那条）
   * @param stopRemote - 是否同时停止远端 dsh（默认 true，对齐 CLI Ctrl-C 语义）
   * @returns 被断开会话的 id
   * @throws SupervisorError not_found / still_connecting
   */
  async disconnect(target: string, stopRemote = true): Promise<string> {
    const record = this.find(target);
    if (record.connecting) {
      throw new SupervisorError(
        'still_connecting',
        `会话 ${record.hostAlias} 仍在连接中，等它完成或失败后再断开（进度见 status）`,
      );
    }
    const session = record.session;
    record.session = undefined;
    if (session !== undefined) {
      this.push(record, 'info', stopRemote ? '断开并停止远端 dsh…' : '断开（保留远端 dsh）…');
      await session.close({ stopRemote });
    }
    this.push(record, 'info', '已断开');
    record.state = { ...record.state, tag: 'disconnected' };
    return record.sessionId;
  }

  /**
   * 全部会话快照：本进程登记的（权威）+ 会话表里其他本机进程的（external 只读）。
   *
   * @returns 快照列表（本进程在前，按发起时间升序）
   */
  list(): SessionSnapshot[] {
    const own = [...this.sessions.values()]
      .filter(record => record.connecting || record.session !== undefined
        || record.state.tag !== 'disconnected')
      .map(record => this.snapshotOf(record));
    const ownIds = new Set(own.map(item => `${item.sessionId}`));

    // 其他本机进程（CLI 或另一个 dsh）维持的视图：只读展示，
    // 让面板与 CLI `status` 互相可见（主键 (sessionId, localPid) 的既定语义）
    const external: SessionSnapshot[] = [];
    for (const record of listSessions()) {
      if (record.localPid === process.pid) continue; // 本进程的行由内存 Map 权威呈现
      if (ownIds.has(record.sessionId)) continue;
      external.push({
        sessionId: record.sessionId,
        hostAlias: record.hostAlias,
        remoteCwd: record.remoteCwd,
        // 外部视图来自会话表，目前只有 SSH 会话会登记（WSL 暂不走 registry）
        transportType: 'ssh',
        state: { tag: 'connected', missedHeartbeats: 0, reconnectAttempts: 0 },
        connecting: false,
        localPort: record.localPort,
        remotePort: record.remotePort,
        remotePid: record.remotePid,
        startedAt: record.startedAt,
        external: true,
      });
    }
    return [...own, ...external];
  }

  /**
   * 取某会话自 seq 之后的增量日志。
   *
   * @param sessionId - 会话 id
   * @param since - 起始序号（不含）；0 = 全部
   * @returns 日志条目；会话不存在时 undefined
   */
  getLog(sessionId: string, since = 0): LogEntry[] | undefined {
    const record = this.sessions.get(sessionId);
    if (record === undefined) return undefined;
    return record.log.filter(entry => entry.seq > since);
  }

  /**
   * 关闭全部会话（插件 dispose 路径）。
   *
   * 逐个 close 用 allSettled：一个失败不阻断其余；external 视图不归本进程管，
   * 不触碰。
   *
   * @param stopRemote - 是否连远端一起停（Config.keepRemoteOnDispose 取反）
   */
  async disposeAll(stopRemote: boolean): Promise<void> {
    const active = [...this.sessions.values()].filter(record => record.session !== undefined);
    await Promise.allSettled(active.map(async (record) => {
      const session = record.session;
      record.session = undefined;
      if (session !== undefined) await session.close({ stopRemote });
    }));
    this.sessions.clear();
  }

  /**
   * 后台执行 openSession，把回调收进日志缓冲。
   *
   * @param record - 登记项
   * @param request - 连接请求
   */
  private async runOpen(record: SupervisedSession, request: ConnectRequest): Promise<void> {
    this.push(record, 'info', `runOpen 开始: transportType=${record.transportType}, hostAlias=${request.hostAlias}, distroName=${request.distroName ?? '(无)'}`);
    try {
      const session = await openSession({
        hostAlias: request.hostAlias,
        remoteCwd: record.remoteCwd,
        // 传输类型与 WSL 参数透传；缺省 'ssh' 保持向后兼容
        transportType: record.transportType,
        ...(request.distroName ? { distroName: request.distroName } : {}),
        ...(request.wslUser ? { wslUser: request.wslUser } : {}),
        // 端口：请求覆盖 > 插件配置 > 0（OS 分配）——openSession 对 0 的语义
        // 就是自动分配，直接透传
        localPort: request.localPort ?? this.defaults.localPort,
        forceRestart: request.forceRestart ?? this.defaults.forceRestart,
        refreshMirrors: request.refreshMirrors ?? this.defaults.refreshMirrors,
        ...(this.defaults.nodeVersion ? { nodeVersion: this.defaults.nodeVersion } : {}),
        ...(this.defaults.dshVersion ? { dshVersion: this.defaults.dshVersion } : {}),
        ...(request.privateKey ? { privateKey: request.privateKey } : {}),
        ...(request.password !== undefined ? { password: request.password } : {}),
        onStageStart: (stage) => { this.push(record, 'info', `[开始] ${stage}`); },
        onStageDone: (detail) => {
          this.push(record, 'info', `[完成] ${detail ?? ''}`);
        },
        onStageSkip: (reason) => { this.push(record, 'info', `[跳过] ${reason}`); },
        onStateChange: (state, description) => {
          record.state = state;
          this.push(record, 'state', description);
        },
        onForwardError: (message) => { this.push(record, 'error', message); },
        // 远端 handoff 组件经反向隧道 /manage/* 回调的闭包：state/log 走本
        // 监督器的登记项，meta 带管理页地址与协议版本（版本戳供远端判级）
        manageHandlers: this.manageHandlersFor(record),
      });
      record.session = session;
      record.state = session.currentState;
      this.push(record, 'info', `会话就绪：http://127.0.0.1:${session.localPort}（远端 pid ${session.remotePid}）`);
    } catch (error) {
      // 失败不留死记录：connecting 收尾、错误进日志与快照，用户可重试
      record.connectError = toErrorMessage(error);
      this.push(record, 'error', `连接失败：${record.connectError}`);
    } finally {
      record.connecting = false;
    }
  }

  /**
   * 按会话 id 或主机别名找登记项。
   *
   * @param target - 会话 id（全串或 ≥8 位前缀）或主机别名
   * @returns 登记项
   * @throws SupervisorError('not_found') 无匹配
   */
  private find(target: string): SupervisedSession {
    const direct = this.sessions.get(target);
    if (direct !== undefined) return direct;
    const matches = [...this.sessions.values()].filter(record =>
      record.sessionId.startsWith(target) || record.hostAlias === target);
    const unique = matches.length === 1 ? matches[0] : undefined;
    if (unique !== undefined) return unique;
    // 多条命中时优先活跃的（连接中或已连接）
    const active = matches.filter(record => record.connecting || record.session !== undefined);
    const uniqueActive = active.length === 1 ? active[0] : undefined;
    if (uniqueActive !== undefined) return uniqueActive;
    throw new SupervisorError(
      'not_found',
      matches.length > 1
        ? `'${target}' 命中 ${matches.length} 个会话，请用完整会话 id 指定：${matches.map(record => record.sessionId).join('、')}`
        : `没有匹配 '${target}' 的会话（用 status 查看现有会话）`,
    );
  }

  /**
   * 追加一条日志（有界环形：超限丢最旧）。
   *
   * @param record - 登记项
   * @param kind - 类别
   * @param text - 内容（不得含密码/令牌）
   */
  private push(record: SupervisedSession, kind: LogKind, text: string): void {
    record.seq += 1;
    record.log.push({ seq: record.seq, ts: new Date().toISOString(), kind, text });
    if (record.log.length > MAX_LOG_ENTRIES) {
      record.log.splice(0, record.log.length - MAX_LOG_ENTRIES);
    }
  }

  /**
   * 构造登记项的快照。
   *
   * @param record - 登记项
   * @returns 快照（就绪字段仅在会话对象存在时出现）
   */
  private snapshotOf(record: SupervisedSession): SessionSnapshot {
    const session = record.session;
    return {
      sessionId: record.sessionId,
      hostAlias: record.hostAlias,
      remoteCwd: record.remoteCwd,
      transportType: record.transportType,
      state: record.state,
      connecting: record.connecting,
      ...(record.connectError !== undefined ? { connectError: record.connectError } : {}),
      ...(session !== undefined
        ? {
          localPort: session.localPort,
          remotePort: session.remotePort,
          remotePid: session.remotePid,
          url: session.url,
          missingKeyEnvs: session.missingKeyEnvs,
        }
        : {}),
      startedAt: record.startedAt,
      logTail: record.log.slice(-LOG_TAIL_SIZE),
    };
  }

  /**
   * 构造一个会话的管理回调闭包（交给 openSession → 反向代理 /manage/*）。
   *
   * @param record - 登记项（meta 的管理页地址与版本戳从它取）
   * @returns 管理回调集合
   */
  private manageHandlersFor(record: SupervisedSession): ManageHandlers {
    return {
      state: (sessionId) => {
        const target = this.sessions.get(sessionId);
        if (target === undefined) {
          throw new SupervisorError('not_found', `没有会话 ${sessionId}`);
        }
        return this.manageSnapshot(target);
      },
      log: (sessionId, since) => this.getLog(sessionId, since) ?? [],
      meta: () => ({
        sessionId: record.sessionId,
        ...(record.managerUrl !== undefined ? { managerUrl: record.managerUrl } : {}),
        protocolVersion: HANDOFF_PROTOCOL_VERSION,
        packageVersion: __PLUGIN_VERSION__,
      }),
    };
  }

  /**
   * 管理通道的裁剪快照：去掉 logTail（日志走 log 操作增量拉）与 url
   * （远端页面本身就持有自己的访问令牌，不需要经管理通道再给一次）。
   *
   * @param record - 登记项
   * @returns 裁剪后的快照
   */
  private manageSnapshot(record: SupervisedSession): Omit<SessionSnapshot, 'logTail' | 'url'> {
    const { logTail: _tail, url: _url, ...rest } = this.snapshotOf(record);
    return rest;
  }

  // ── 远端插件管理（委托给 RemotePluginStore，保持公开 API 不变） ──────────

  /**
   * 远端插件清单：读远端 profile 的 manifest 与 node_modules 版本/bundle 标记。
   *
   * @param sessionId - 会话 id
   * @returns 清单；会话不存在/未就绪时抛监督器错误
   */
  async listRemotePlugins(sessionId: string): Promise<RemotePluginInfo[]> {
    return this.pluginStore.listRemotePlugins(sessionId);
  }

  /**
   * 远端安装插件：profile 目录内 pnpm add，成功后 reconcile bundles。
   *
   * @param sessionId - 会话 id
   * @param spec - pnpm 安装规格（包名@版本等）
   * @returns 安装后的清单
   * @throws SupervisorError('remote_plugin') pnpm 失败
   */
  async installRemotePlugin(sessionId: string, spec: string): Promise<RemotePluginInfo[]> {
    return this.pluginStore.installRemotePlugin(sessionId, spec);
  }

  /**
   * 远端卸载插件：pnpm remove + 从 bundles 摘除。
   *
   * @param sessionId - 会话 id
   * @param name - 包名
   * @returns 卸载后的清单
   */
  async removeRemotePlugin(sessionId: string, name: string): Promise<RemotePluginInfo[]> {
    return this.pluginStore.removeRemotePlugin(sessionId, name);
  }

  /**
   * 远端插件启停：只改 profile 清单的 bundles 列表，hmr 热生效。
   *
   * @param sessionId - 会话 id
   * @param name - 包名
   * @param enabled - true 启用 / false 停用
   * @returns 操作后的清单
   */
  async toggleRemotePlugin(sessionId: string, name: string, enabled: boolean): Promise<RemotePluginInfo[]> {
    return this.pluginStore.toggleRemotePlugin(sessionId, name, enabled);
  }

  // ── 内部辅助 ────────────────────────────────────────────────────────────

  /**
   * 取一个本进程登记且已就绪的会话。
   *
   * @param sessionId - 会话 id
   * @returns 登记项与会话对象
   * @throws SupervisorError not_found / still_connecting
   */
  private requireReadySession(sessionId: string): { record: SupervisedSession; session: RemoteSession } {
    const record = this.sessions.get(sessionId);
    if (record === undefined) {
      throw new SupervisorError('not_found', `没有会话 ${sessionId}`);
    }
    if (record.connecting) {
      throw new SupervisorError('still_connecting', `会话 ${record.hostAlias} 仍在连接中`);
    }
    if (record.session === undefined) {
      throw new SupervisorError('not_found', `会话 ${sessionId} 未在运行`);
    }
    return { record, session: record.session };
  }

}

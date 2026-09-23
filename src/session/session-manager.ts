/**
 * @file 会话编排
 * @description 把连接、引导、启动远端 dsh、建隧道、凭据代理、心跳、重连串成一个会话对象。
 *
 * 会话的生命周期：
 *
 * ```
 * open()  连接 → 读凭据材料 ┬ 已有 → 复用令牌与反向端口
 *                          └ 没有 → 生成令牌、分配反向端口
 *         → 引导（patch 让 baseURL 指向反向端口）
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
 * **远端 dsh 默认不随 CLI 退出而停止。** 它是 detach 的，下次连接可直接复用。
 * 要真正停掉需 `close({ stopRemote: true })` 或 `dsh-remote-explorer kill`。
 *
 * 分层：本文件属编排层，可用能力层与传输层。
 */

import { assertConnectable, resolveHostWithAuth, type AuthOverrides } from '../hosts/ssh-config-parser.js';
import { SshTransport, isAuthFailure } from '../transport/ssh-transport.js';
import { WslTransport } from '../transport/wsl-transport.js';
import { writeRemoteTextFile } from '../transport/write-text.js';
import { provision, type ProvisionResult } from '../provision/provisioner.js';
import { installHandoffBundle } from '../provision/handoff-installer.js';
import {
  attachSessionNodeModules, syncSessionManifest, transportIo,
} from '../provision/plugin-store.js';
import { probeRemote } from '../provision/probe.js';
import { createRemotePaths, type RemotePaths } from '../provision/remote-paths.js';
import { allocateRemotePorts } from '../tunnel/port-allocator.js';
import { LocalForward } from '../tunnel/forward-local.js';
import { computeSessionId } from '../util/session-id.js';
import { ownerFingerprint } from '../util/owner-fingerprint.js';
import { RemoteError, toErrorMessage } from '../util/errors.js';
import { quote } from '../util/shell-quote.js';
import { probeExistingSession, startRemoteDsh, stopRemoteDsh, type RemoteProcessInfo } from './remote-process.js';
import { Heartbeat, type HeartbeatResult } from './heartbeat.js';
import { backoffDelay, wait, DEFAULT_RECONNECT_CONFIG, type ReconnectConfig } from './reconnect.js';
import {
  DEFAULT_LIFECYCLE_CONFIG, INITIAL_STATE, describeState, isTerminal, transition,
  type LifecycleConfig, type SessionEvent, type SessionState,
} from './lifecycle-state.js';
import { removeSession, upsertSession } from './session-registry.js';
import { generateProxyToken } from '../credential/token.js';
import { TunnelProxyCredential } from '../credential/tunnel-proxy.js';
import { PasswordProvider, type PasswordPromptFn } from '../util/password-prompt.js';
import {
  deepseekRoute, extractProviderRoutes, mirrorSettingsForTunnel,
  readLocalSettings, renderProviderTunnelPatch,
} from '../credential/provider-routes.js';
import type { ManageHandlers } from '../handoff/protocol.js';
import type { ReverseHandle, RemoteTransport } from '../transport/types.js';
import { createLogger } from '../util/logger.js';

const log = createLogger('session-manager');

/** 传输类型标识 */
export type TransportType = 'ssh' | 'wsl';

/** 会话打开选项 */
export interface OpenSessionOptions {
  /** 主机别名 */
  hostAlias: string;
  /** 远端工作目录；参与会话 id 计算 */
  remoteCwd: string;
  /** 传输类型；默认 'ssh'（向后兼容） */
  transportType?: TransportType;
  /** WSL 发行版名称（transportType='wsl' 时必需） */
  distroName?: string;
  /** WSL 用户名（transportType='wsl' 时可选） */
  wslUser?: string;
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
  /**
   * 私钥文件路径覆盖（--private-key）：优先于 config 的 IdentityFile，
   * 只作用于目标主机；跨重连持续生效
   */
  privateKey?: string;
  /**
   * 固定密码（--password）：显式走密码认证，优先于 config 的 IdentityFile。
   * 只存本进程内存，不落盘、不进日志
   */
  password?: string;
  /**
   * 自定义密码提示回调（dsh 插件形态用：密码来自面板表单而非终端）。
   * 优先级 password > promptPassword > 内置终端提示；CLI 不传，行为不变
   */
  promptPassword?: PasswordPromptFn;
  /**
   * 转发失败告警回调（插件形态接进会话日志缓冲）。
   * 不传时 LocalForward 直写 stderr（CLI 形态既有行为）
   */
  onForwardError?: (message: string) => void;
  /**
   * 远端 handoff 组件的管理回调（插件形态由监督器提供闭包）。
   * 经反向代理的 `/manage/*` 路由族暴露给远端窗口；CLI 不传，行为不变
   */
  manageHandlers?: ManageHandlers;
}

/** 会话关闭选项 */
export interface CloseSessionOptions {
  /** 是否同时停止远端 dsh 进程；默认 false（保留以便下次复用） */
  stopRemote?: boolean;
}

/**
 * 从会话选项计算认证覆盖。
 *
 * --private-key 与 --password 同给时密钥优先（密码不再生效）——与
 * resolveHostWithAuth 的内部优先级保持一致，open 与重连共用同一份规则。
 *
 * @param options - 会话选项
 * @returns 认证覆盖
 */
function authOverridesOf(options: OpenSessionOptions): AuthOverrides {
  return {
    ...(options.privateKey ? { privateKey: options.privateKey } : {}),
    ...(options.password !== undefined && options.privateKey === undefined
      ? { password: options.password }
      : {}),
  };
}

/** SSH 传输准备上下文（仅 SSH 路径需要） */
interface SshPrepareContext {
  /** SSH 主机解析结果（含跳板机链、认证配置） */
  resolved: ReturnType<typeof resolveHostWithAuth>;
  /** 密码获取回调 */
  getPassword: (hostKey: string, label: string, attempt: number) => Promise<string | undefined>;
}

/**
 * 解析 SSH 主机配置并校验可连接性。
 *
 * 只做主机解析，不涉及密码提供器的生命周期管理（密码提供器由调用方持有，
 * 需要在会话关闭时清理引用）。
 *
 * @param options - 会话打开选项
 * @returns SSH 主机解析结果
 */
function resolveSshHost(options: OpenSessionOptions): ReturnType<typeof resolveHostWithAuth> {
  const auth = authOverridesOf(options);
  const resolved = resolveHostWithAuth(options.hostAlias, auth);
  assertConnectable(resolved, options.hostAlias, {
    passwordAuth: auth.password !== undefined,
  });
  return resolved;
}

/**
 * 根据会话选项创建对应的传输实例。
 *
 * 每种传输类型的准备逻辑由各自的 prepare* 函数完成，本函数只做分发。
 * 新增传输类型时：添加对应的 case 分支 + prepare 函数，不影响已有分支。
 *
 * @param options - 会话打开选项
 * @param sshCtx - SSH 准备上下文（仅 transportType='ssh' 时使用）
 * @returns 传输实例（尚未 connect）
 */
function createTransport(
  options: OpenSessionOptions,
  sshCtx: SshPrepareContext,
): RemoteTransport {
  const type: TransportType = options.transportType ?? 'ssh';
  switch (type) {
    case 'wsl': {
      if (!options.distroName) {
        throw new RemoteError(
          'CONNECT_FAILED',
          'transportType=wsl 时必须指定 distroName（WSL 发行版名称）',
          { hostAlias: options.hostAlias },
        );
      }
      return new WslTransport({
        distroName: options.distroName,
        ...(options.wslUser ? { user: options.wslUser } : {}),
      });
    }
    case 'ssh': {
      return new SshTransport(options.hostAlias, sshCtx.resolved, {
        getPassword: sshCtx.getPassword,
      });
    }
    default: {
      // 编译期穷尽检查：新增 TransportType 成员时此处报错提醒补充分支
      const _exhaustive: never = type;
      throw new RemoteError(
        'CONNECT_FAILED',
        `不支持的传输类型: ${_exhaustive as string}`,
        { hostAlias: options.hostAlias },
      );
    }
  }
}

/**
 * 获取传输类型的阶段描述文案。
 *
 * @param transportType - 传输类型
 * @returns 中文阶段描述
 */
function transportStageLabel(transportType: TransportType | undefined): string {
  switch (transportType ?? 'ssh') {
    case 'wsl': return '连接 WSL 发行版';
    case 'ssh': return '建立 SSH 连接';
    default: return '建立连接';
  }
}

/** 随会话固定的凭据材料（远端 `.runtime/` 落盘的那组值） */
interface ProxySecret {
  /** 代理令牌（远端占位凭据） */
  token: string;
  /** 反向隧道监听端口 */
  reversePort: number;
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
   * @param secret - 凭据材料；undefined 表示该会话不带凭据路径
   * @param credential - 凭据代理实例；无凭据路径时 undefined
   * @param reverseHandle - 初始的反向转发句柄；挂在 transport 上，重连时重挂
   * @param reconnectConfig - 重连配置
   * @param lifecycleConfig - 生命周期参数
   * @param passwords - 会话级密码提供器：首次连接交互提示（或 --password 固定值），
   *                    重连静默复用缓存；close 时清空
   */
  private constructor(
    readonly sessionId: string,
    private readonly options: OpenSessionOptions,
    private transport: RemoteTransport,
    private provisioned: ProvisionResult,
    private process: RemoteProcessInfo,
    private readonly forward: LocalForward,
    private readonly secret: ProxySecret | undefined,
    private credential: TunnelProxyCredential | undefined,
    private reverseHandle: ReverseHandle | undefined,
    private readonly reconnectConfig: ReconnectConfig,
    private readonly lifecycleConfig: LifecycleConfig,
    private readonly passwords: PasswordProvider | undefined,
  ) {}

  /** 浏览器访问地址（含令牌） */
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
   * @param options - 打开选项
   * @returns 已就绪的会话
   */
  static async open(options: OpenSessionOptions): Promise<RemoteSession> {
    const sessionId = computeSessionId(options.hostAlias, options.remoteCwd);

    const reconnectConfig = { ...DEFAULT_RECONNECT_CONFIG, ...options.reconnect };
    const lifecycleConfig = { ...DEFAULT_LIFECYCLE_CONFIG, ...options.lifecycle };

    // 按传输类型各自准备上下文：SSH 需要主机解析+密码提供器，WSL 不需要。
    // 新增传输类型时在此添加对应 case，不影响已有分支
    let sshCtx: SshPrepareContext;
    let passwords: PasswordProvider | undefined;
    switch (options.transportType ?? 'ssh') {
      case 'ssh': {
        const resolved = resolveSshHost(options);
        const auth = authOverridesOf(options);
        passwords = new PasswordProvider({
          ...(auth.password !== undefined ? { fixed: auth.password } : {}),
          ...(options.promptPassword ? { prompt: options.promptPassword } : {}),
        });
        sshCtx = {
          resolved,
          getPassword: (hostKey, label, attempt) => passwords!.get(hostKey, label, attempt),
        };
        break;
      }
      case 'wsl': {
        // WSL 无需 SSH 主机解析与密码提供器；createTransport 内部校验 distroName
        sshCtx = { resolved: undefined as never, getPassword: async () => undefined };
        break;
      }
    }

    options.onStageStart?.(transportStageLabel(options.transportType));
    const transport = createTransport(options, sshCtx);
    log.info(`transport 创建完成: type=${options.transportType ?? 'ssh'}, hostAlias=${transport.hostAlias}`);
    await transport.connect();
    log.info(`transport 连接成功: platform=${transport.platform.rawOs}/${transport.platform.rawArch}`);
    options.onStageDone?.(`${transport.platform.rawOs} ${transport.platform.rawArch}`);

    let session: RemoteSession | undefined;
    try {
      // 家目录要先拿到：既有会话探测与凭据材料读取都需要路径
      const probe = await probeRemote(transport);
      log.info(`远端探测完成: homeDir=${probe.homeDir}`);
      const paths = createRemotePaths(probe.homeDir);

      // 1. 凭据材料：读回已有的，没有则生成新的。
      //    放在探测进程之前——无论进程是否存活，落盘材料都可能存在
      //    （进程刚死待重启时，材料仍然有效且应当继续用）
      let secret = await readProxySecret(transport, paths, sessionId);

      // 2. 探既有远端进程
      if (options.forceRestart === true) {
        await stopRemoteDsh(transport, paths, { sessionId });
      }
      let processInfo: RemoteProcessInfo | undefined;
      if (options.forceRestart !== true) {
        processInfo = await probeExistingSession(transport, paths, sessionId);
      }

      if (processInfo && !secret) {
        // 会话是凭据功能上线前启动的：占位凭据没进它的环境， baseURL 也没指向代理。
        // 只降级为警告——用户可能只想要隧道；要启用凭据路径用 --force-restart
        options.onStageSkip?.('远端会话早于凭据功能启动；加 --force-restart 可启用密钥代理');
      }

      // 3. 需要启动时分配端口。web 端口一次性分配好；凭据材料缺失时
      //    连反向端口一起分配，避免与 web 端口撞车
      let webPort: number | undefined;
      let secretIsNew = false;
      if (!processInfo) {
        const exclude = secret ? [secret.reversePort] : [];
        const ports = await allocateRemotePorts(transport, secret ? 1 : 2, { exclude });
        webPort = ports[0]!;
        if (!secret) {
          secret = { token: generateProxyToken(), reversePort: ports[1]! };
          secretIsNew = true;
        }
      }

      // 4. 凭据策略实例。构造便宜（不起监听），放在引导之前——
      //    环境注入、patch 条目与 settings 镜像都从它取，编排层不重复拼细节。
      //    路由表 = DeepSeek 原生通道 + 本机 settings.yaml 里的 pi-ai 供应商
      //    （用户的默认模型可能配置在后者，如 AStudio）
      const localSettings = readLocalSettings();
      const providerRoutes = localSettings ? extractProviderRoutes(localSettings) : [];
      const credential = secret
        ? new TunnelProxyCredential(
          secret.token, secret.reversePort,
          [deepseekRoute(), ...providerRoutes],
          options.hostAlias,
          ...(options.manageHandlers ? [options.manageHandlers] : []),
        )
        : undefined;

      // 5. 引导（幂等）。patch 让 DeepSeek 原生通道的 baseURL 指向反向端口——
      //    secret 存在就写，复用与新建 alike：prepareSessionProfile 每次重写
      //    patch，反向端口来自同一份落盘材料，值保持一致
      const provisioned = await provision(transport, {
        sessionId,
        patches: credential?.remotePatches() ?? [],
        ...(options.nodeVersion ? { nodeVersion: options.nodeVersion } : {}),
        ...(options.dshVersion ? { dshVersion: options.dshVersion } : {}),
        ...(options.refreshMirrors ? { refreshMirrors: true } : {}),
        ...(options.onStageStart ? { onStageStart: options.onStageStart } : {}),
        ...(options.onStageDone ? { onStageDone: options.onStageDone } : {}),
        ...(options.onStageSkip ? { onStageSkip: options.onStageSkip } : {}),
      });

      // 5.5 handoff 组件（幂等，store 级）：合成 bundle 写进用户级 plugin store
      //     并登记启用——该远程账号的所有会话共享这一份，新会话零额外安装。
      //     老会话补装时若远端进程仍存活复用，菜单要等下次远端重启才出现。
      //     安装失败不阻断会话（增强面非成立条件）
      options.onStageStart?.('检查远端交接组件');
      try {
        const installed = await installHandoffBundle(transport, paths, provisioned.dsh.version);
        options.onStageDone?.(installed ? '已安装交接组件（远端窗口获得管理菜单）' : '交接组件已就位');
      } catch (error) {
        options.onStageSkip?.(`交接组件安装失败（不影响会话）：${toErrorMessage(error)}`);
      }

      // 5.6 会话接入 store（必须在远端启动前）：profile node_modules 整体
      //     symlink 到 store + manifest 从 store 合并（改写即 hmr 热生效；
      //     无变化不写）。老会话遗留的真实 node_modules 目录在此迁移为 symlink
      await attachSessionNodeModules(transport, paths, sessionId);
      await syncSessionManifest(transportIo(transport), paths, sessionId);

      // 6. settings 双写：本机 settings 整体复制到会话 DSH_HOME + pi-ai 供应商
      //    路由写进 home patch 层（`$DSH_HOME/cordis.patch.yml`）。
      //    - 镜像：dsh ≤0.1.6 运行时热读它；0.1.7 起只在每次进程启动时一次性
      //      导入（导入后改名 `.imported`），承载其余 section 的传递
      //    - home patch：0.1.6/0.1.7 都存在且受 hmr 热监听，供应商路由的
      //      持续热生效靠它——不受 0.1.7 移除 settings.yaml 运行时读取的影响
      //    两份都只做 baseURL 重定向（凭据引用不含密钥）；绝不镜像
      //    .credentials.yaml（可能含真实密钥）。复用会话时同值重写无副作用
      if (secret && localSettings) {
        const mirrored = mirrorSettingsForTunnel(localSettings, secret.reversePort);
        if (mirrored) {
          // SFTP 主路径落盘（远端未开 sftp 子系统时自动回退 printf-over-exec）。
          // 容忍模式与旧实现的 allowNonZeroExit 语义一致：镜像失败不阻断会话
          await writeRemoteTextFile(transport, paths.sessionSettingsFile(sessionId), mirrored, {
            tolerant: true,
          });
        }
        const providerPatch = renderProviderTunnelPatch(localSettings, secret.reversePort);
        if (providerPatch) {
          // 同为容忍模式：home patch 失败时 0.1.6 仍有镜像兜底，0.1.7 首启
          // 导入也还能承接（.imported 语义），会话不因此阻断
          await writeRemoteTextFile(
            transport, paths.sessionHomePatchFile(sessionId), providerPatch, { tolerant: true },
          );
        }
      }

      // 7. 新凭据材料落盘（600 权限）。之后无论哪个视图重连都读回同一组值
      if (secret && secretIsNew) {
        await writeProxySecret(transport, paths, sessionId, secret);
      }

      // 8. 启动远端进程（占位凭据进环境——每条路由的 keyEnv 都是同一个令牌）
      if (!processInfo) {
        log.info('步骤8: 启动远端 dsh 进程');
        processInfo = await RemoteSession.launch(
          transport, provisioned, sessionId, options, webPort!, credential,
        );
        log.info('步骤8完成: 远端 dsh 已启动', { port: processInfo.port, pid: processInfo.pid });
      } else {
        log.info('步骤8: 复用既有远端进程', { port: processInfo.port, pid: processInfo.pid });
      }

      // 8.5 owner 指纹落盘：kill/clean 的跨用户 scope 化凭据（非秘密）。
      //     容忍模式——写失败不阻断会话（最坏退化为「无 owner 的老目录」语义）
      log.info('步骤8.5: owner 指纹落盘');
      await writeRemoteTextFile(
        transport,
        paths.sessionOwnerFile(sessionId),
        `${ownerFingerprint()}\n`,
        { tolerant: true },
      );


      // 9. 起本机 LLM 代理并挂反向转发
      let reverseHandle: ReverseHandle | undefined;
      if (credential) {
        log.info('步骤9: 启动密钥代理');
        options.onStageStart?.('启动密钥代理');
        await credential.start();
        log.info('步骤9: 代理已启动，开始挂反向转发', { reversePort: credential.reversePort });
        reverseHandle = await attachReverseForward(transport, credential, options);
        log.info('步骤9完成: 反向转发已挂载');
        const missing = credential.missingKeyEnvs;
        if (missing.length === 0) {
          options.onStageDone?.(
            `反向端口 ${credential.reversePort} → 本机代理（${credential.routeCount} 条路由）`,
          );
        } else {
          options.onStageDone?.(
            `反向端口 ${credential.reversePort} → 本机代理（${credential.routeCount} 条路由；`
            + `本机缺 key：${missing.join('、')}）`,
          );
        }
      }

      // 10. 建正向隧道。监听器跨重连存活，端口从此不再变化；
      //     转发失败告警经钩子上抛（插件形态接日志缓冲；CLI 缺省直写 stderr）
      log.info('步骤10: 建立正向隧道');
      options.onStageStart?.('建立正向隧道');
      const forward = new LocalForward(transport, '127.0.0.1', processInfo.port, {
        ...(options.onForwardError ? { onForwardError: options.onForwardError } : {}),
      });
      const localPort = await forward.listen(options.localPort ?? 0);
      log.info('步骤10完成: 正向隧道就绪', { localPort, remotePort: processInfo.port });
      options.onStageDone?.(`127.0.0.1:${localPort} → 远端 ${processInfo.port}`);

      session = new RemoteSession(
        sessionId, options, transport, provisioned, processInfo,
        forward, secret, credential, reverseHandle,
        reconnectConfig, lifecycleConfig, passwords,
      );
      session.apply({ type: 'connect-ready' });
      session.register();
      session.startHeartbeat();
      log.info(`会话完全就绪: sessionId=${sessionId}, url=${session.url}`);
      return session;
    } catch (error) {
      // 打开失败要释放已建立的资源，否则 SSH 连接与代理会泄漏
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
    await this.detachReverseForward();
    await this.credential?.stop();
    // 会话结束即丢弃缓存密码的引用（字符串不可清零，只能靠 GC 回收）
    this.passwords?.clear();
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
   * @param options - 打开选项（进度回调）
   * @param port - 预分配的 web 端口
   * @param credential - 凭据策略；存在则占位凭据进环境
   * @returns 远端进程信息
   */
  private static async launch(
    transport: RemoteTransport,
    provisioned: ProvisionResult,
    sessionId: string,
    options: Pick<OpenSessionOptions, 'onStageStart' | 'onStageDone'>,
    port: number,
    credential: TunnelProxyCredential | undefined,
  ): Promise<RemoteProcessInfo> {
    const tried: number[] = [port];
    let lastError: unknown;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      options.onStageStart?.(`启动远端 dsh（端口 ${port}）`);
      try {
        const info = await startRemoteDsh(transport, provisioned.paths, {
          sessionId,
          dshBin: provisioned.dsh.dshBin,
          dshHome: provisioned.profile.dshHome,
          profileName: provisioned.profile.profileName,
          nodeBinDir: provisioned.node.binDir,
          port,
          ...(provisioned.profile.patchFile ? { patchFile: provisioned.profile.patchFile } : {}),
          ...(credential ? { extraEnv: credential.remoteEnv() } : {}),
        });
        options.onStageDone?.(`pid ${info.pid}`);
        return info;
      } catch (error) {
        lastError = error;
        // 端口冲突是预期内的竞态，换端口重试；其他错误重试也无意义，但
        // 区分成本高于收益——第二次失败就会如实抛出
        if (attempt === 0) {
          const [next] = await allocateRemotePorts(transport, 1, { exclude: tried });
          tried.push(next!);
          port = next!;
        }
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

      const existing = await probeExistingSession(next, this.provisioned.paths, this.sessionId);
      if (existing) {
        this.process = existing;
      } else {
        // 远端进程确实没了，重新启动。引导结果仍有效（安装未变），不必重跑引导。
        // 凭据材料保持不变（落盘的令牌与反向端口），占位凭据继续生效
        const exclude = this.credential ? [this.credential.reversePort] : [];
        const [port] = await allocateRemotePorts(next, 1, { exclude });
        this.process = await RemoteSession.launch(next, this.provisioned, this.sessionId, {}, port!, this.credential);
      }

      // 重挂反向转发：旧句柄随旧传输失效，代理实例不动
      await this.detachReverseForward();
      if (this.credential) {
        this.reverseHandle = await attachReverseForward(next, this.credential, this.options);
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
 * 把反向转发挂到指定传输上。
 *
 * 挂不上时返回 undefined 并以警告说明——同一会话的另一个本机视图
 * 先到先得持有反向端口（sshd 拒绝重复绑定），凭据路径由它维持；
 * 这里失败不代表会话不可用。
 *
 * @param transport - 传输实例
 * @param credential - 凭据代理
 * @param options - 打开选项（进度回调）
 * @returns 反向转发句柄；挂不上时 undefined
 */
async function attachReverseForward(
  transport: RemoteTransport,
  credential: TunnelProxyCredential,
  options: Pick<OpenSessionOptions, 'onStageSkip'>,
): Promise<ReverseHandle | undefined> {
  const port = credential.reversePort;
  try {
    return await transport.forwardIn(port, (connection) => {
      credential.handleReverseConnection(connection.stream);
    });
  } catch {
    // 多视图并发持有同一会话时的预期情形；也可能是 sshd 禁了 TcpForwarding
    options.onStageSkip?.(
      `反向端口 ${port} 挂接失败：可能已被同一会话的其他本机进程占用（密钥代理由它维持），`
        + '或远端 sshd 禁用了端口转发（检查 AllowTcpForwarding）',
    );
    return undefined;
  }
}

/**
 * 读回会话的凭据材料。
 *
 * @param transport - 传输实例
 * @param paths - 远端路径集合
 * @param sessionId - 会话 id
 * @returns 材料；任一文件缺失或非法时 undefined
 */
async function readProxySecret(
  transport: RemoteTransport,
  paths: RemotePaths,
  sessionId: string,
): Promise<ProxySecret | undefined> {
  const tokenFile = paths.sessionProxyTokenFile(sessionId);
  const portFile = paths.sessionReversePortFile(sessionId);
  const script = [
    `[ -f ${quote(tokenFile)} ] && [ -f ${quote(portFile)} ] || exit 0`,
    `printf 'TOKEN=%s\\n' "$(cat ${quote(tokenFile)})"`,
    `printf 'PORT=%s\\n' "$(cat ${quote(portFile)})"`,
  ].join('\n');

  const result = await transport.exec(script, { allowNonZeroExit: true });
  const token = /^TOKEN=(.+)$/m.exec(result.stdout)?.[1]?.trim();
  const portText = /^PORT=(\d+)$/m.exec(result.stdout)?.[1];
  if (!token || !portText) return undefined;
  const port = Number.parseInt(portText, 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65_535) return undefined;
  return { token, reversePort: port };
}

/**
 * 落盘会话的凭据材料。
 *
 * 令牌文件以 umask 077 创建（仅会话属主可读）。它只是代理共享密钥，
 * 不是真实 API key；残余风险与 PLAN 4.5 节的既有评估一致
 * （同权限用户本就能读进程环境拿到它）。
 *
 * @param transport - 传输实例
 * @param paths - 远端路径集合
 * @param sessionId - 会话 id
 * @param secret - 凭据材料
 */
async function writeProxySecret(
  transport: RemoteTransport,
  paths: RemotePaths,
  sessionId: string,
  secret: ProxySecret,
): Promise<void> {
  const tokenFile = paths.sessionProxyTokenFile(sessionId);
  const portFile = paths.sessionReversePortFile(sessionId);
  // 令牌值不打印到任何日志；这里只写文件
  const script = [
    `umask 077`,
    `printf '%s' ${quote(secret.token)} > ${quote(tokenFile)}`,
    `printf '%s' ${quote(String(secret.reversePort))} > ${quote(portFile)}`,
  ].join('\n');
  await transport.exec(script, { allowNonZeroExit: true });
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

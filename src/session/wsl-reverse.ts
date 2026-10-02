/**
 * @file WSL 反向端点编排
 * @description WSL 路径的反向端点全套决策：网络模式探测、NAT 网关解析、
 *              ReverseListener 的「分配即绑定」建立、重连期的端点重探与
 *              远端材料重写、挂接后的反向链路自检。
 *
 * 与 SSH 路径的差异（全部集中在编排层分流，SSH 行为不变）：
 *
 * - **分配即绑定**：反向端口由 Windows 侧 ReverseListener 真实 bind 成功才
 *   写进会话材料（消灭幽灵占用竞态与端口命名空间分裂）；远端探测只负责
 *   web 端口。监听器跨重连存活（不依赖传输实例），SSH 路径的
 *   `transport.forwardIn` 行为不变。
 * - **反向端点 host 参数化**：NAT 模式 = 默认路由网关 IP（每次连接/重连
 *   重探测，落盘 `.runtime/reverse-host` 并刷新 patch 的 baseURL）；mirrored
 *   模式 = 127.0.0.1（只绑回环——mirrored 的默认路由网关是 LAN 路由器）。
 * - **反向链路自检**：挂接完成后从 WSL 内向反向端点发一次 HTTP 探测，不通
 *   必须显式告警（warn 日志 + 面板可见），不允许「pill 不渲染」式的静默降级。
 *
 * 网络探测的命令构造与输出解析是 transport 层纯函数（wsl-network），本模块
 * 只负责编排：执行探测、决策端点计划、驱动监听器与重写远端材料。这一轴与
 * 「会话生命周期」无关，独立成模块（session-manager 只在各阶段方法里分流
 * 调用）。
 *
 * 分层：本文件属编排层（session/），向下使用 transport 层（探测纯函数与
 * 文本写入）、tunnel 层（ReverseListener）、provision 与 credential 层
 * （材料重写）。
 */

import {
  buildDefaultRouteCommand,
  buildLoopbackProbeCommand,
  buildNetworkingModeProbeCommand,
  buildReverseHttpProbeCommand,
  parseDefaultRouteGateway,
  parseLoopbackProbeResult,
  parseNetworkingMode,
  parseReverseHttpProbeResult,
  type WslNetworkingMode,
} from '../transport/wsl-network.js';
import type { RemoteTransport } from '../transport/types.js';
import type { RemoteContext } from '../provision/remote-context.js';
import type { ProvisionResult } from '../provision/provisioner.js';
import { prepareSessionProfile } from '../provision/profile-writer.js';
import { ReverseListener } from '../tunnel/reverse-listener.js';
import { writeSessionReverseHost, writePlaceholderAccountCredentials, type ProxySecret } from '../credential/proxy-secret.js';
import type { TunnelProxyCredential } from '../credential/tunnel-proxy.js';
import {
  readLocalSettings, renderProviderTunnelPatch,
} from '../credential/provider-routes.js';
import { quote } from '../util/shell-quote.js';
import { toErrorMessage } from '../util/errors.js';
import { createLogger } from '../util/logger.js';
import type { OpenSessionOptions } from './options.js';

const log = createLogger('wsl-reverse');

/** WSL 网络探测命令的超时（毫秒）——探测失败走兜底路径，不该久等 */
const WSL_NETWORK_PROBE_TIMEOUT_MS = 10_000;

/** WSL 反向链路自检超时（毫秒）——自检失败只告警不阻断，快速收敛 */
const WSL_REVERSE_CHECK_TIMEOUT_MS = 10_000;

/** WSL 反向端点计划（网络探测的产物，决定监听地址与 reverse-host） */
interface WslReversePlan {
  /** 网络模式；wslinfo 与回环自检都无法判定时 undefined */
  mode: WslNetworkingMode | undefined;
  /** WSL 内访问 Windows 反向监听应使用的地址（写进 reverse-host 与 baseURL） */
  reverseHost: string;
  /** 除 127.0.0.1 外需要绑定的地址（NAT 网关 IP；mirrored 为空） */
  extraBindHosts: string[];
}

/**
 * WSL 探测命令的统一执行兜底。
 *
 * 三个网络探测函数共用同一执行形态：`allowNonZeroExit` + 固定超时执行，
 * exec 层面失败（超时/传输异常）时 warn 并返回 undefined，由调用方走各自
 * 的降级路径。**warn 文案由调用处给定**——各探测的降级语义不同（模式
 * 探测失败走连通性自检兜底、回环自检失败按 NAT 处理），helper 只统一
 * 执行与 catch 形态，不吞并文案。
 *
 * @param transport - 已连接的 WSL 传输
 * @param command - 探测命令
 * @param timeoutMs - 超时（毫秒）
 * @param warnPrefix - 失败时 warn 消息前缀（完整文案 = 前缀 + 失败原因）
 * @returns 命令 stdout；执行失败时 undefined
 */
async function execWslProbe(
  transport: RemoteTransport,
  command: string,
  timeoutMs: number,
  warnPrefix: string,
): Promise<string | undefined> {
  try {
    const result = await transport.exec(command, {
      allowNonZeroExit: true,
      timeoutMs,
    });
    return result.stdout;
  } catch (error) {
    log.warn(`${warnPrefix}: ${toErrorMessage(error)}`, { hostAlias: transport.hostAlias });
    return undefined;
  }
}

/**
 * 探测 WSL 网络模式（wslinfo 不存在或执行失败时返回 undefined）。
 *
 * @param transport - 已连接的 WSL 传输
 * @returns 'nat' | 'mirrored' | undefined
 */
async function probeWslNetworkingMode(
  transport: RemoteTransport,
): Promise<WslNetworkingMode | undefined> {
  // exec 层面失败（超时/传输异常）：按未知处理，走连通性自检兜底
  const stdout = await execWslProbe(
    transport,
    buildNetworkingModeProbeCommand(),
    WSL_NETWORK_PROBE_TIMEOUT_MS,
    'WSL 网络模式探测命令执行失败，改用连通性自检兜底',
  );
  return stdout === undefined ? undefined : parseNetworkingMode(stdout);
}

/**
 * 探测 WSL 默认路由网关 IP（Windows 宿主在 vEthernet 上的地址）。
 *
 * @param transport - 已连接的 WSL 传输
 * @returns 网关 IPv4；拿不到时 undefined
 */
async function probeWslDefaultGateway(transport: RemoteTransport): Promise<string | undefined> {
  const stdout = await execWslProbe(
    transport,
    buildDefaultRouteCommand(),
    WSL_NETWORK_PROBE_TIMEOUT_MS,
    'WSL 默认路由网关探测失败',
  );
  return stdout === undefined ? undefined : parseDefaultRouteGateway(stdout);
}

/**
 * 从 WSL 内探测到 Windows 侧 127.0.0.1 监听的回环连通性。
 *
 * wslinfo 不可用时的模式兜底判据：连通 = mirrored（或 WSL1，共享网络栈）；
 * 连接被拒 = NAT（WSL 的 127.0.0.1 是自己的 loopback）。
 *
 * @param transport - 已连接的 WSL 传输
 * @param port - Windows 侧已绑定的监听端口
 * @returns 是否连通（探测命令本身失败按不连通处理，交由 NAT 路径兜底）
 */
async function probeWslLoopback(transport: RemoteTransport, port: number): Promise<boolean> {
  const stdout = await execWslProbe(
    transport,
    buildLoopbackProbeCommand(port),
    WSL_NETWORK_PROBE_TIMEOUT_MS,
    'WSL 回环连通性自检执行失败，按 NAT 处理',
  );
  return stdout !== undefined && parseLoopbackProbeResult(stdout) === 'reachable';
}

/**
 * 组装 NAT 方案的反向端点计划（mode='nat' 或按 NAT 处理时共用）。
 *
 * 拿不到网关时降级为 127.0.0.1 并 warn——NAT 下回环不通，反向链路大概率
 * 不可用；后续反向链路自检会再次给出明确告警，不静默。
 *
 * @param transport - 已连接的 WSL 传输
 * @returns NAT 计划
 */
async function planForNat(transport: RemoteTransport): Promise<WslReversePlan> {
  const gateway = await probeWslDefaultGateway(transport);
  if (gateway === undefined) {
    log.warn(
      'WSL 处于 NAT 模式但未能解析默认路由网关 IP，反向端点降级为 127.0.0.1'
        + '（NAT 模式下 WSL 的回环连不到 Windows，反向链路大概率不可用；'
        + '可在 WSL 内执行 ip route show default 核对 via 地址）',
      { hostAlias: transport.hostAlias },
    );
    return { mode: 'nat', reverseHost: '127.0.0.1', extraBindHosts: [] };
  }
  return { mode: 'nat', reverseHost: gateway, extraBindHosts: [gateway] };
}

/**
 * WSL 打开期的反向端点建立：网络模式探测 + ReverseListener 分配即绑定。
 *
 * 流程（顺序有讲究）：
 * 1. wslinfo 探测模式：mirrored → 只绑 127.0.0.1（mirrored 的默认路由
 *    网关是 LAN 路由器而非本机地址，按网关绑定必失败）
 * 2. nat → 探测网关 IP，绑 127.0.0.1 + 网关（同端口；网关绑定失败由
 *    监听器内部降级告警）
 * 3. 模式未知（老版 WSL 无 wslinfo / WSL1）→ 先绑 127.0.0.1，再从 WSL
 *    内做回环连通性自检：连通按 mirrored；不通按 NAT 走网关方案
 *
 * @param transport - 已连接的 WSL 传输
 * @param preferredPort - 会话落盘的既有反向端口（复用语义；绑不上换候选）
 * @returns 已绑定的监听器与端点计划
 */
export async function openWslReverse(
  transport: RemoteTransport,
  preferredPort: number | undefined,
): Promise<{ listener: ReverseListener; plan: WslReversePlan }> {
  const hostAlias = transport.hostAlias;
  const listener = new ReverseListener(hostAlias);
  const preferred = preferredPort !== undefined ? { preferredPort } : {};

  // 1. wslinfo 探测网络模式
  const mode = await probeWslNetworkingMode(transport);
  log.info('WSL 网络模式探测完成', { hostAlias, mode: mode ?? 'unknown' });

  if (mode === 'mirrored') {
    await listener.bind(preferred);
    return { listener, plan: { mode, reverseHost: '127.0.0.1', extraBindHosts: [] } };
  }

  if (mode === 'nat') {
    const plan = await planForNat(transport);
    await listener.bind({
      ...preferred,
      ...(plan.extraBindHosts.length > 0 ? { extraHosts: plan.extraBindHosts } : {}),
    });
    return { listener, plan };
  }

  // 2. 模式未知：先绑 127.0.0.1（两种模式都要绑它），再做回环自检
  await listener.bind(preferred);
  const port = listener.port!;
  const reachable = await probeWslLoopback(transport, port);
  log.info('WSL 回环连通性自检完成', { hostAlias, port, reachable });
  if (reachable) {
    // 连通即回环互通（mirrored / WSL1 共享网络栈），只绑 127.0.0.1 就够
    return { listener, plan: { mode: undefined, reverseHost: '127.0.0.1', extraBindHosts: [] } };
  }

  // 3. 回环不通 → NAT：取网关 IP 追加绑定（同端口）
  const plan = await planForNat(transport);
  if (plan.extraBindHosts.length > 0) {
    await listener.addHost(plan.extraBindHosts[0]!);
  }
  return { listener, plan };
}

/**
 * WSL 重连期的反向端点重探（不重建监听）。
 *
 * 与 {@link openWslReverse} 共用探测逻辑，差别在模式未知时用**既有监听**
 * 的端口做回环自检（监听跨重连存活，127.0.0.1 绑定一直在）。
 *
 * @param transport - 重连后的新传输实例
 * @param boundPort - 既有监听器绑定的端口
 * @returns 新的反向端点计划
 */
async function replanWslReverse(
  transport: RemoteTransport,
  boundPort: number,
): Promise<WslReversePlan> {
  const mode = await probeWslNetworkingMode(transport);
  if (mode === 'mirrored') {
    return { mode, reverseHost: '127.0.0.1', extraBindHosts: [] };
  }
  if (mode === 'nat') {
    return await planForNat(transport);
  }
  const reachable = await probeWslLoopback(transport, boundPort);
  if (reachable) {
    return { mode: undefined, reverseHost: '127.0.0.1', extraBindHosts: [] };
  }
  return await planForNat(transport);
}

/**
 * WSL 重连期的反向端点刷新：重探网络模式并重写远端材料（不重建监听）。
 *
 * 每次重连都重新探测网络模式（契约：NAT 网关 IP 随 WSL 重启变化）。
 * host 变化时：调整监听的附加绑定（主绑定 127.0.0.1 与端口不动——远端
 * 材料认的就是它们）、更新凭据策略、重写远端材料（reverse-host、profile
 * patch、settings 镜像、home patch）。材料重写必须先于远端进程（重）启动，
 * 所以本函数只在 reconnectOnce 探测/启动远端进程之前调用。
 *
 * 网关变化意味着 WSL 大概率重启过（`wsl --shutdown` 会杀掉全部 WSL 进程），
 * 远端进程通常已死、随后的探测会触发重启并消费新材料；万一进程仍存活
 * 复用，其 baseURL 停在旧端点，链路自检会给出告警。
 *
 * 会话状态以参数显式传入（secret/credential/provisioned）；credential 的
 * reverseHost 在函数内就地更新（须先于 patch 渲染），更新后的 secret 经
 * 返回值交还调用方回写会话字段。
 *
 * @param transport - 重连后的新传输实例（探测与材料写入都走它）
 * @param params - 会话状态（会话 id、引导结果、凭据材料、凭据策略、既有监听）
 * @returns 更新后的凭据材料（host 未变化时为原对象）
 */
export async function refreshWslReverseOnReconnect(
  transport: RemoteTransport,
  params: {
    sessionId: string;
    provisioned: ProvisionResult;
    secret: ProxySecret;
    credential: TunnelProxyCredential | undefined;
    listener: ReverseListener;
  },
): Promise<ProxySecret> {
  const { sessionId, provisioned, secret, credential, listener } = params;
  const port = listener.port;
  if (port === undefined) return secret;

  // 1. 重探网络模式（未知时用既有监听端口做回环连通性自检兜底）
  const plan = await replanWslReverse(transport, port);

  // 2. 附加绑定按计划对齐（幂等：移除多余、补绑缺失；补绑失败内部
  //    已告警降级）。放在 host 比较之前——附加地址可能因早前绑定失败
  //    缺席，这里每次都有一次自愈机会
  await listener.setExtraHosts(plan.extraBindHosts);

  // 3. host 变化：更新凭据策略与远端材料（会话的内存记录经返回值回写）
  if (plan.reverseHost !== secret.reverseHost) {
    log.info('WSL 反向端点变化，刷新监听与远端材料', {
      hostAlias: transport.hostAlias,
      from: secret.reverseHost,
      to: plan.reverseHost,
      port: secret.reversePort,
    });
    const updated: ProxySecret = { ...secret, reverseHost: plan.reverseHost };
    credential?.updateReverseHost(plan.reverseHost);

    const ctx: RemoteContext = { transport, paths: provisioned.paths };
    // 3a. reverse-host（消费方按文件值回连）
    await writeSessionReverseHost(ctx, sessionId, plan.reverseHost);
    // 3b. profile patch：prepareSessionProfile 幂等且每次重写 patch——
    //     复用引导产出的 dshBin/binDir，不重跑整个 provision。
    //     DSH_HOME = base，patch 文件在 sessions/<id>/.runtime/patch.yml（会话级）。
    //     pi-ai 供应商路由也合并进 patch 文件（与 open 流程同一机制）。
    const patches = credential?.remotePatches() ?? [];
    await prepareSessionProfile(ctx, {
      sessionId,
      dshBin: provisioned.dsh.dshBin,
      nodeBinDir: provisioned.node.binDir,
      ...(patches.length > 0 ? { patches } : {}),
    });
    // 3c. pi-ai 供应商路由 patch：追加到 patch 文件（>> 追加，不覆盖标量 patch）
    const localSettings = readLocalSettings();
    if (localSettings) {
      const piAiPatch = renderProviderTunnelPatch(localSettings, secret.reversePort, plan.reverseHost);
      if (piAiPatch !== undefined) {
        try {
          const patchFile = provisioned.paths.sessionPatchFile(sessionId);
          await transport.exec(`printf '\\n%s' ${quote(piAiPatch)} >> ${quote(patchFile)}`, { allowNonZeroExit: true });
        } catch { /* 容忍：pi-ai patch 失败不阻断重连 */ }
      }
    }
    // 3d. 机器级 credentials.yaml（占位 grant record，同值幂等重写；契约与
    //     幂等语义见 writePlaceholderAccountCredentials 的函数注释）
    if (credential !== undefined && credential.accountTokenAvailable) {
      // issuer 与 platformOrigin 一致——用本次探测的 reverseHost（NAT 网关
      // 可能已随 WSL 重启变化），端口仍是随会话固定的反向端口
      const issuer = `http://${plan.reverseHost}:${secret.reversePort}`;
      try {
        await writePlaceholderAccountCredentials(
          { transport, paths: provisioned.paths }, secret.token, issuer,
        );
      } catch { /* 容忍：占位凭据写失败不阻断重连，下次连接再恢复 */ }
    }
    return updated;
  }

  // host 未变化：契约仍要求每次重连重写 reverse-host（幂等、廉价）
  await writeSessionReverseHost(
    { transport, paths: provisioned.paths },
    sessionId, secret.reverseHost,
  );
  return secret;
}

/**
 * WSL 反向链路自检：从 WSL 内向反向端点发起 HTTP 探测。
 *
 * 判据：无令牌请求拿到任何 HTTP 状态码即证明链路可达（401/404 都算通）；
 * 连接被拒或无响应即不通。不通时给出 warn 级中文说明（含降级影响与排查
 * 方向）并经 onStageSkip 进入面板日志——可观测性是硬要求，不允许
 * 「会话照常建立但凭据代理全断」的静默降级。
 *
 * @param transport - 已连接的 WSL 传输
 * @param credential - 凭据代理（取反向端点 host:port）
 * @param options - 阶段回调（OpenSessionOptions 的 onStageSkip 子集；
 *                  重连路径传空对象，只进运行日志）
 */
export async function checkWslReverseLink(
  transport: RemoteTransport,
  credential: TunnelProxyCredential,
  options: Pick<OpenSessionOptions, 'onStageSkip'>,
): Promise<void> {
  const host = credential.reverseHost;
  const port = credential.reversePort;
  const hostAlias = transport.hostAlias;

  let reachable = false;
  let detail = '';
  try {
    const result = await transport.exec(buildReverseHttpProbeCommand(host, port), {
      allowNonZeroExit: true,
      timeoutMs: WSL_REVERSE_CHECK_TIMEOUT_MS,
    });
    const parsed = parseReverseHttpProbeResult(result.stdout);
    if (parsed.reachable) {
      reachable = true;
      detail = parsed.statusLine ?? '(有响应)';
    } else if (parsed.outcome === 'connected-no-response') {
      detail = '连接已建立但未收到 HTTP 响应（监听在，但凭据代理未应答）';
    } else {
      detail = '连接被拒（无监听或地址不可达）';
    }
  } catch (error) {
    detail = `探测命令失败: ${toErrorMessage(error)}`;
  }

  if (reachable) {
    log.info(`WSL 反向链路自检通过: ${host}:${port} → ${detail}`, { hostAlias });
    return;
  }

  const message = 'WSL 反向链路自检不通：WSL 内无法访问反向端点 '
    + `${host}:${port}（${detail}）。密钥代理与远端管理回调将不可用（远端模型调用会失败）。`
    + '排查方向：mirrored 模式 Windows 与 WSL 共享回环；NAT 模式须走默认路由网关'
    + '（WSL 内 ip route show default 的 via 地址）且 Windows 侧须绑定该网关地址；'
    + '可在 WSL 内执行 wslinfo --networking-mode 确认网络模式。';
  log.warn(message, { hostAlias, host, port });
  options.onStageSkip?.(`反向链路自检不通（${host}:${port}）——密钥代理将不可用，详见运行日志`);
}

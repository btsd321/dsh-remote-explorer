/**
 * @file provision 阶段的代理隧道管理（local_resource_download 的编排层）
 * @description 在引导期建一条 SSH 反向隧道 + 本机 HTTP 代理，让远端无网时
 *              curl/npm install 的出站请求经隧道回到本机网络。模式决策
 *              （auto/always/off）在这里收口。
 *
 * 三种模式：
 * - `off`：不建隧道，远端直连（原行为）
 * - `always`：直接建隧道，注入 http_proxy 到全部下载命令
 * - `auto`（默认）：先探测远端网络可达性，不可达则建隧道
 *
 * 生命周期：provision 开始前 setup()，provision 完成后 teardown()。隧道与
 * 代理只在引导期存活——dsh 启动后远端不再需要引导期代理（dsh 进程自身的
 * 代理由 session/proxy-env.ts 的 collectProxyEnv 注入，那是另一条独立链路）。
 *
 * 远端监听端口的分配：走 {@link allocateRemotePorts} 的候选区间，与凭据反向
 * 隧道、远端 web 端口同一套策略。**不能用固定端口**——同一远端账号的两个
 * 并发会话都要隧道时会互相抢绑；用户若已按文档在远端配过
 * `DSH_REMOTE_PROXY=http://127.0.0.1:18890` 的代理，固定端口也必然冲突。
 *
 * 架构：纯 JS 实现，不依赖外部进程或 Python 模块，跑在 dsh 宿主进程内。
 *
 * 分层约束：本文件属能力层（provision/），使用同层能力（tunnel/ 的代理与端口
 * 分配）与传输层（transport/types）；不依赖编排层（session/）或入口层。
 */

import { LocalHttpProxy } from '../tunnel/local-http-proxy.js';
import { allocateRemotePorts } from '../tunnel/port-allocator.js';
import { createLogger } from '../util/logger.js';
import { quote } from '../util/shell-quote.js';
import { getCandidates } from './mirror-selector.js';
import type { LocalResourceDownloadMode } from './local-download-mode.js';
import type { RemoteTransport } from '../transport/types.js';

const log = createLogger('provision-proxy-tunnel');

/** 远端网络可达性探测的超时（毫秒）：不可达时应快速失败 */
const PROBE_TIMEOUT_MS = 10_000;

/**
 * 远端网络可达性探测的目标 URL。
 *
 * 取 npm 候选镜像的首项——与真正要下载的 registry 同源：探到它可达就意味着
 * 后面 `selectMirror('npm')` 至少有一个候选可用，不会出现「探测说有网、
 * 下载却全不可达」的错配。
 */
const PROBE_URL = getCandidates('npm')[0]!.baseUrl;

/** 反向端口绑定失败时的重试次数（每次换一个新分配的端口） */
const BIND_MAX_ATTEMPTS = 2;

/** 代理隧道引导结果 */
export interface ProxyTunnelSetup {
  /**
   * 注入到远端下载命令（curl/npm install）的 http_proxy 值。
   *
   * 形如 `http://127.0.0.1:<远端反向端口>`。undefined = 不注入（off 模式，
   * 或 auto 模式探测到远端有网）。provision 层把它传给三个 installer，
   * installer 经基础层 buildProxyEnv / buildCurlProxyArg 落成 exec env
   * 或 curl 的 `-x` 参数。
   */
  proxyUrl: string | undefined;
  /** 清理函数：provision 完成后调用（停代理、关隧道）；幂等 */
  teardown: () => Promise<void>;
}

/** 不建隧道时的空结果（teardown 是幂等空操作） */
function noTunnel(): ProxyTunnelSetup {
  return { proxyUrl: undefined, teardown: async () => {} };
}

/**
 * 按模式决定是否建代理隧道，建隧道则返回注入值与清理函数。
 *
 * auto 模式的探测：远端 `curl --connect-timeout` 一个 registry 镜像 URL，成功
 * 则判定远端有网（不建隧道），失败则判定无网（建隧道）。探测只看连通性
 * （任何三位数 HTTP 状态码都算有网），避免把 404 等业务错误误判为无网。
 *
 * 代价：丢包型防火墙下探测要吃满 `--connect-timeout`（最坏约 5 秒），
 * 这是 auto 模式在有网机器上的固有开销。
 *
 * @param transport - 已连接的传输实例
 * @param mode - 本地资源下载模式；undefined 按 auto 处理
 * @returns 引导结果（proxyUrl 为 undefined = 不建隧道）
 */
export async function setupProvisionProxyTunnel(
  transport: RemoteTransport,
  mode: LocalResourceDownloadMode | undefined,
): Promise<ProxyTunnelSetup> {
  const effectiveMode = mode ?? 'auto';

  // off：不建隧道，原行为
  if (effectiveMode === 'off') return noTunnel();

  // auto：先探测远端网络可达性；可达则不建隧道直接返回
  if (effectiveMode === 'auto') {
    const reachable = await probeRemoteConnectivity(transport);
    if (reachable) {
      log.info('远端网络可达，auto 模式不建代理隧道', { hostAlias: transport.hostAlias });
      return noTunnel();
    }
    log.info('远端网络不可达，auto 模式建代理隧道', { hostAlias: transport.hostAlias });
  }

  // always，或 auto 探测到无网：建代理隧道
  return buildTunnel(transport);
}

/**
 * 探测远端网络可达性。
 *
 * 远端 `curl --connect-timeout 5` 一个 registry 镜像 URL，任何 HTTP 响应
 * （2xx/3xx/4xx/5xx）都算可达——只看 TCP 连通性。连接超时、DNS 解析失败、
 * 连接被拒、以及 curl 本身缺失，都按不可达处理（此时建隧道是更可能有用的
 * 选择；隧道也建不成时会降级为原行为）。
 *
 * @param transport - 已连接的传输实例
 * @returns 可达返回 true
 */
async function probeRemoteConnectivity(transport: RemoteTransport): Promise<boolean> {
  try {
    const result = await transport.exec(
      `curl -s --connect-timeout 5 --max-time ${Math.floor(PROBE_TIMEOUT_MS / 1000)}`
      + ` -o /dev/null -w '%{http_code}' ${quote(PROBE_URL)} 2>/dev/null || true`,
      { allowNonZeroExit: true, timeoutMs: PROBE_TIMEOUT_MS },
    );
    const code = result.stdout.trim();
    // 任何三位数 HTTP 状态码都算可达（2xx/3xx/4xx/5xx）——只要 TCP 连得上
    return /^\d{3}$/.test(code) && code !== '000';
  } catch {
    // exec 本身失败（超时、连接已断等）也算不可达
    return false;
  }
}

/**
 * 建代理隧道：本机起 HTTP 代理 + SSH 反向转发映射到动态分配的远端端口。
 *
 * 失败清理契约：本机代理一启动就占着端口，**任何后续失败路径都必须停掉它**
 * ——调用方（provision）的 try/finally 是在本函数返回之后才建立的，这里抛错
 * 时它救不了已经起来的代理。故 forwardIn 失败走 try/catch 就地收尾。
 *
 * 端口冲突（同账号并发会话、或用户自建的 18890 代理）是预期内的竞态，
 * 换一个新分配的端口重试一次；仍失败则降级为「不建隧道」，让 provision
 * 按原行为继续（远端有网时什么都不影响，无网时会给出原有的镜像不可达错误）。
 *
 * @param transport - 已连接的传输实例
 * @returns 引导结果（proxyUrl 指向远端反向隧道端口）
 */
async function buildTunnel(transport: RemoteTransport): Promise<ProxyTunnelSetup> {
  // forwardIn 是可选能力（WSL 不实现）；没有它就没法建隧道
  if (transport.forwardIn === undefined) {
    log.warn('传输不支持 forwardIn，无法建代理隧道', { hostAlias: transport.hostAlias });
    return noTunnel();
  }

  // 1. 本机起 HTTP 代理（监听 127.0.0.1:0，OS 分配端口）
  const proxy = new LocalHttpProxy();
  const localPort = await proxy.start();

  // 2. 逐次尝试绑定远端反向端口：首轮用分配器选端口，冲突则换一个重试
  const tried: number[] = [];
  let lastError: unknown;
  for (let attempt = 0; attempt < BIND_MAX_ATTEMPTS; attempt += 1) {
    let remotePort: number;
    try {
      const [allocated] = await allocateRemotePorts(transport, 1, { exclude: tried });
      remotePort = allocated!;
    } catch (error) {
      // 端口分配本身就失败（远端 ss/netstat 都不可用且随机候选全占）——不再纠缠
      lastError = error;
      break;
    }
    tried.push(remotePort);

    try {
      const handle = await transport.forwardIn(remotePort, (connection) => {
        proxy.handleStream(connection.stream);
      });
      const proxyUrl = `http://127.0.0.1:${remotePort}`;
      log.info(`代理隧道已建立：远端 ${proxyUrl} → 本机 127.0.0.1:${localPort}`, {
        hostAlias: transport.hostAlias,
        remotePort,
        localPort,
      });
      return {
        proxyUrl,
        teardown: async () => {
          try { await handle.close(); } catch { /* 隧道关闭失败无妨 */ }
          await proxy.stop();
        },
      };
    } catch (error) {
      // 端口被占等绑定失败：换端口重试；最后一次失败后走下面的降级路径
      lastError = error;
      log.warn(
        `反向端口 ${remotePort} 绑定失败（${error instanceof Error ? error.message : String(error)}）`
        + `，${attempt + 1 < BIND_MAX_ATTEMPTS ? '换端口重试' : '放弃建隧道'}`,
        { hostAlias: transport.hostAlias },
      );
    }
  }

  // 3. 两次都绑不上：停掉本机代理（否则端口与服务器泄漏到进程退出），
  //    降级为不建隧道——provision 按原行为继续，远端有网时无任何影响
  await proxy.stop();
  log.warn(
    `代理隧道建立失败，降级为远端直连（已试远端端口 ${tried.join('、') || '(无)'}）：`
    + `${lastError instanceof Error ? lastError.message : String(lastError)}`,
    { hostAlias: transport.hostAlias },
  );
  return noTunnel();
}

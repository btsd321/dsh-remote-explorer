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
 * 代理只在引导期存活——dsh 启动后远端不再需要引导期代理（dsh 自己的代理
 * 走 collectProxyEnv，那是另一条独立链路）。
 *
 * 架构：纯 JS 实现，不依赖外部进程或 Python 模块，跑在 dsh 宿主进程内。
 *
 * 分层约束：本文件属能力层（provision/），向下使用隧道层（tunnel/）与传输层
 * （transport/types）；不依赖编排层（session/）或入口层。
 */

import { LocalHttpProxy } from '../tunnel/local-http-proxy.js';
import { createLogger } from '../util/logger.js';
import { quote } from '../util/shell-quote.js';
import type { LocalResourceDownloadMode } from './local-download-mode.js';
import type { RemoteTransport } from '../transport/types.js';
import type { ReverseHandle } from '../transport/types.js';

const log = createLogger('provision-proxy-tunnel');

/** 远端网络可达性探测的超时（毫秒）：不可达时应快速失败 */
const PROBE_TIMEOUT_MS = 10_000;

/** 远端网络可达性探测的目标 URL（用镜像源测，与实际下载同源） */
const PROBE_URL = 'https://registry.npmmirror.com';

/** 隧道反向转发占用的远端端口（远端 127.0.0.1 上的监听端口） */
const TUNNEL_REMOTE_PORT = 18890;

/** 代理隧道引导结果 */
export interface ProxyTunnelSetup {
  /**
   * 注入到远端下载命令（curl/npm install）的 http_proxy 值。
   *
   * 形如 `http://127.0.0.1:18890`（远端反向隧道端口）。undefined = 不注入
   * （off 模式或 auto 模式远端有网）。provision 层把它传给三个 installer，
   * installer 把它经 collectProxyEnv 展开为八个代理键注入 exec env。
   */
  proxyUrl: string | undefined;
  /** 清理函数：provision 完成后调用（停代理、关隧道） */
  teardown: () => Promise<void>;
}

/**
 * 按模式决定是否建代理隧道，建隧道则返回注入值与清理函数。
 *
 * auto 模式的探测：远端 `curl --connect-timeout` 一个镜像源 URL，成功则
 * 判定远端有网（不建隧道），失败则判定无网（建隧道）。探测只看连通性
 * （HTTP 状态码 2xx/3xx/4xx 都算有网——只要 TCP 连得上就算），避免把
 * 404 等业务错误误判为无网。
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
  if (effectiveMode === 'off') {
    return { proxyUrl: undefined, teardown: async () => {} };
  }

  // auto：先探测远端网络可达性
  if (effectiveMode === 'auto') {
    const reachable = await probeRemoteConnectivity(transport);
    if (reachable) {
      log.info('远端网络可达，auto 模式不建代理隧道', { hostAlias: transport.hostAlias });
      return { proxyUrl: undefined, teardown: async () => {} };
    }
    log.info('远端网络不可达，auto 模式建代理隧道', { hostAlias: transport.hostAlias });
    // 落到下面的建隧道路径
  }

  // always 或 auto 探测无网：建代理隧道
  if (effectiveMode === 'always' || effectiveMode === 'auto') {
    return buildTunnel(transport);
  }

  return { proxyUrl: undefined, teardown: async () => {} };
}

/**
 * 探测远端网络可达性。
 *
 * 远端 `curl --connect-timeout 5` 一个镜像源 URL，任何 HTTP 响应（2xx/3xx/
 * 4xx）都算可达——只看 TCP 连通性。连接超时、DNS 解析失败、连接被拒
 * 都算不可达。
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
    // exec 本身失败（超时等）也算不可达
    return false;
  }
}

/**
 * 建代理隧道：本机起 HTTP 代理 + SSH 反向转发映射到远端端口。
 *
 * @param transport - 已连接的传输实例
 * @returns 引导结果（proxyUrl 指向远端反向隧道端口）
 */
async function buildTunnel(transport: RemoteTransport): Promise<ProxyTunnelSetup> {
  // 1. 本机起 HTTP 代理
  const proxy = new LocalHttpProxy();
  const localPort = await proxy.start();

  // 2. SSH 反向转发：远端 127.0.0.1:TUNNEL_REMOTE_PORT → 本机代理端口
  const handle = await transport.forwardIn?.(TUNNEL_REMOTE_PORT, (connection) => {
    proxy.handleStream(connection.stream);
  });
  if (handle === undefined) {
    // 传输不支持 forwardIn（WSL）——停代理，返回空（走原行为）
    log.warn('传输不支持 forwardIn，无法建代理隧道', { hostAlias: transport.hostAlias });
    await proxy.stop();
    return { proxyUrl: undefined, teardown: async () => {} };
  }

  const proxyUrl = `http://127.0.0.1:${TUNNEL_REMOTE_PORT}`;
  log.info(`代理隧道已建立：远端 ${proxyUrl} → 本机 127.0.0.1:${localPort}`, {
    hostAlias: transport.hostAlias,
    remotePort: TUNNEL_REMOTE_PORT,
    localPort,
  });

  const teardown = async (): Promise<void> => {
    try { await handle.close(); } catch { /* 隧道关闭失败无妨 */ }
    await proxy.stop();
  };
  return { proxyUrl, teardown };
}

/**
 * @file WSL 网络模式与网关探测（纯函数）
 * @description WSL2 两种组网模式决定了「远端 dsh 如何回连 Windows 侧反向监听」：
 *
 * - **mirrored**：Windows 与 WSL 共享网络命名空间，WSL 内 `127.0.0.1` 直达
 *   Windows 侧监听。注意 mirrored 的默认路由网关是 **LAN 路由器**而非本机地址，
 *   按网关方案绑定必然失败——mirrored 只绑 127.0.0.1。
 * - **nat**（WSL2 默认）：WSL 的 `127.0.0.1` 是自己的 loopback，连不到 Windows
 *   侧监听。微软官方方案是用 `ip route show default` 的网关 IP（Windows 宿主在
 *   vEthernet 适配器上的地址）连接；resolv.conf 的 nameserver 法在 dnsTunneling
 *   默认开启时失效，**必须用默认路由法**。
 *
 * 本文件只提供解析与命令构造的纯函数，不执行命令（执行由编排层经
 * transport.exec 完成）、不建 Node server（监听属 tunnel/reverse-listener）；
 * 纯函数仅依赖基础层 util 的 IPv4 校验（判据收口在 util/ipv4，本文件
 * 不再自持一份实现）。
 *
 * 命令注入纪律：拼进命令的 host/port 都是**经过 IPv4 严格校验的值**
 * （仅数字与点），不存在 shell 元字符，因此不走 `quote()`——`quote()` 的
 * 单引号会破坏 `/dev/tcp/<host>/<port>` 重定向目标与 HTTP 头的语法。
 * 构造函数内部再次校验，非法值直接抛错。
 *
 * 分层约束：本文件属传输层，不得 import 编排层或能力层的任何模块；
 * 基础层（util/）依赖合法。
 */

import { isValidIpv4 } from '../util/ipv4.js';

/** WSL2 组网模式 */
export type WslNetworkingMode = 'nat' | 'mirrored';

/** 端口合法区间（与既有端口分配约定一致） */
const MIN_PORT = 1;
const MAX_PORT = 65_535;

/**
 * 解析 `wslinfo --networking-mode` 的输出。
 *
 * 输出为单行小写 `nat` 或 `mirrored`（含尾随换行）；wslinfo 不存在时命令
 * 非零退出、输出为空，调用方据此走连通性自检兜底。解析按精确匹配收窄
 * ——wslinfo 未来若输出新值（如新模式），宁可判未知也不要误判。
 *
 * @param output - 命令 stdout
 * @returns 'nat' | 'mirrored'；无法识别时 undefined
 */
export function parseNetworkingMode(output: string): WslNetworkingMode | undefined {
  const text = output.trim();
  if (text === 'nat') return 'nat';
  if (text === 'mirrored') return 'mirrored';
  return undefined;
}

/**
 * 解析 `ip route show default` 输出中的网关 IP。
 *
 * 输出格式：`default via 172.30.96.1 dev eth0 proto kernel metric ...`。
 * 多条默认路由时取**第一条**（与 WSL 自身路由选择一致的概率最高）；
 * 无 `via` 段（点对点链路）或首条无法解析时返回 undefined，交由调用方降级。
 *
 * @param output - 命令 stdout
 * @returns 网关 IPv4；无法解析时 undefined
 */
export function parseDefaultRouteGateway(output: string): string | undefined {
  const firstLine = output.split('\n', 1)[0] ?? '';
  const match = /default\s+via\s+(\S+)/.exec(firstLine);
  if (match === null) return undefined;
  const candidate = match[1] ?? '';
  return isValidIpv4(candidate) ? candidate : undefined;
}

/**
 * 构造网络模式探测命令。
 *
 * 静态命令，无动态值。调用方用 `allowNonZeroExit` 执行：wslinfo 不存在的
 * 老版本 WSL 会以 127 退出，stdout 为空，解析结果即 undefined。
 *
 * @returns 命令字符串
 */
export function buildNetworkingModeProbeCommand(): string {
  return 'wslinfo --networking-mode';
}

/**
 * 构造默认路由探测命令。
 *
 * 静态命令，无动态值。`2>/dev/null` 兜住 `ip` 不存在时的报错，
 * `|| true` 保证退出码为零，输出交给 {@link parseDefaultRouteGateway}。
 *
 * @returns 命令字符串
 */
export function buildDefaultRouteCommand(): string {
  return 'ip route show default 2>/dev/null || true';
}

/**
 * 构造回环连通性探测命令（wslinfo 不可用时的模式兜底判据）。
 *
 * 在 WSL 内对 `127.0.0.1:<port>` 做一次 TCP 连接（bash 内置 `/dev/tcp`）：
 * mirrored/WSL1 下直达 Windows 侧监听（连接成功）；NAT 下是 WSL 自己的
 * loopback，无人监听即连接被拒。`exec` 的重定向失败被包在子 shell 里，
 * 两种 bash 语义（退出子 shell / 返回非零）下命令都安全。
 *
 * @param port - Windows 侧已绑定的监听端口
 * @returns 命令字符串
 * @throws Error 端口非法
 */
export function buildLoopbackProbeCommand(port: number): string {
  assertPort(port);
  return [
    `if ( exec 3<>/dev/tcp/127.0.0.1/${port} ) 2>/dev/null; then`,
    '  echo LOOPBACK_REACHABLE',
    'else',
    '  echo LOOPBACK_UNREACHABLE',
    'fi',
  ].join('\n');
}

/**
 * 解析回环连通性探测输出。
 *
 * @param output - 命令 stdout
 * @returns 'reachable' | 'unreachable'（未知输出按不可达处理）
 */
export function parseLoopbackProbeResult(output: string): 'reachable' | 'unreachable' {
  return output.includes('LOOPBACK_REACHABLE') ? 'reachable' : 'unreachable';
}

/** 反向链路 HTTP 自检的判定分类 */
export type ReverseHttpProbeOutcome =
  /** 拿到 HTTP 状态行（任何状态码都证明链路可达） */
  'http'
  /** TCP 连接建立但未收到 HTTP 响应（监听在但 handler 未挂/服务未起） */
  | 'connected-no-response'
  /** TCP 连接被拒或命令失败（不可达） */
  | 'refused';

/** 反向链路 HTTP 自检结果 */
export interface ReverseHttpProbeResult {
  /** 是否确认可达（判定标准：拿到任何 HTTP 状态行，401/404 都算通） */
  reachable: boolean;
  /** 探测到的 HTTP 状态行（如 `HTTP/1.1 401 Unauthorized`）；不可达时 undefined */
  statusLine?: string;
  /** 判定分类（诊断用） */
  outcome: ReverseHttpProbeOutcome;
}

/**
 * 构造反向链路 HTTP 自检命令。
 *
 * 在 WSL 内向反向端点发起一次无令牌 HTTP 请求（bash `/dev/tcp` + 原生
 * HTTP/1.0 报文），读取响应首行：拿到任何状态码即证明链路可达（本机代理
 * 对无令牌请求回 401）；连接被拒即不通。curl 不可假设存在（精简发行版），
 * bash 是 WSL 传输的硬依赖，`/dev/tcp` 必然可用。连接与请求都在子 shell
 * 内完成并短路衔接，避免 exec 重定向失败的两种 bash 语义差异。
 *
 * @param host - 反向端点主机（必须是已过 IPv4 校验的地址）
 * @param port - 反向端点端口
 * @returns 命令字符串
 * @throws Error host 非法 IPv4 或端口非法
 */
export function buildReverseHttpProbeCommand(host: string, port: number): string {
  assertProbeEndpoint(host, port);
  const request = `GET / HTTP/1.0\\r\\nHost: ${host}\\r\\n\\r\\n`;
  return [
    `resp=$( ( exec 3<>/dev/tcp/${host}/${port} && printf '${request}' >&3 && head -n 1 <&3 ) 2>/dev/null ); rc=$?`,
    'if [ "$rc" -eq 0 ] && [ -n "$resp" ]; then',
    '  printf \'PROBE_HTTP=%s\\n\' "$resp"',
    'elif [ "$rc" -eq 0 ]; then',
    '  echo PROBE_CONNECTED_NO_RESPONSE',
    'else',
    '  echo PROBE_REFUSED',
    'fi',
  ].join('\n');
}

/**
 * 解析反向链路 HTTP 自检输出。
 *
 * @param output - 命令 stdout
 * @returns 判定结果（未知输出按不可达处理）
 */
export function parseReverseHttpProbeResult(output: string): ReverseHttpProbeResult {
  const match = /^PROBE_HTTP=(.+)$/m.exec(output);
  const statusLine = match?.[1]?.trim();
  if (statusLine !== undefined && statusLine.length > 0) {
    return { reachable: true, statusLine, outcome: 'http' };
  }
  if (output.includes('PROBE_CONNECTED_NO_RESPONSE')) {
    return { reachable: false, outcome: 'connected-no-response' };
  }
  return { reachable: false, outcome: 'refused' };
}

/**
 * 校验探测端点参数。
 *
 * @param host - 主机地址
 * @param port - 端口
 * @throws Error host 非法 IPv4 或端口超出区间
 */
function assertProbeEndpoint(host: string, port: number): void {
  if (!isValidIpv4(host)) {
    throw new Error(`反向端点主机必须是合法 IPv4，实际为 ${host || '(空)'}`);
  }
  assertPort(port);
}

/**
 * 校验端口区间。
 *
 * @param port - 端口
 * @throws Error 端口超出合法区间
 */
function assertPort(port: number): void {
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    throw new Error(`端口必须是 ${MIN_PORT}–${MAX_PORT} 的整数，实际为 ${port}`);
  }
}

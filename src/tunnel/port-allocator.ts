/**
 * @file 端口分配
 * @description 为远端 dsh 的监听端口与反向隧道端口挑选可用值。
 *
 * 远端端口分配有个**固有竞态**：启动命令必须提前带上端口号，但"探到空闲"与
 * "实际绑定"之间存在窗口。多会话并行会放大它（决策 9），所以重试不是可选优化
 * 而是必需——调用方拿到端口后启动失败时应换端口重试。
 *
 * 本机端口不需要这套逻辑：传 0 让 OS 分配即可，内核保证不冲突。
 *
 * 分层约束：本文件属能力层，只依赖传输层。
 */

import { RemoteError } from '../util/errors.js';
import { quote } from '../util/shell-quote.js';
import type { RemoteTransport } from '../transport/types.js';

/**
 * 候选端口区间。
 *
 * 取 IANA 动态端口段内一段偏高的范围，避开常见服务与多数系统的
 * `ip_local_port_range`（Linux 默认 32768–60999）所偏好的区域，
 * 减少与临时端口撞车的概率。
 */
const PORT_RANGE_START = 47_000;

/** 候选端口区间长度 */
const PORT_RANGE_SIZE = 2_000;

/** 单次分配的最大尝试次数 */
const MAX_ATTEMPTS = 20;

/**
 * 查询远端当前处于监听状态的 TCP 端口。
 *
 * 优先用 `ss`，回退 `netstat`——精简镜像里可能只有其中之一，
 * 两者都没有时返回空集（此时只能靠启动失败后重试兜底）。
 *
 * @param transport - 已连接的传输
 * @param signal - 取消信号
 * @returns 已占用的端口集合
 */
export async function listRemoteListeningPorts(
  transport: RemoteTransport,
  signal?: AbortSignal,
): Promise<Set<number>> {
  const script = [
    'if command -v ss >/dev/null 2>&1; then',
    "  ss -ltnH 2>/dev/null | awk '{print $4}'",
    'elif command -v netstat >/dev/null 2>&1; then',
    "  netstat -ltn 2>/dev/null | awk 'NR>2 {print $4}'",
    'fi',
  ].join('\n');

  const result = await transport.exec(script, {
    allowNonZeroExit: true,
    ...(signal ? { signal } : {}),
  });

  const ports = new Set<number>();
  for (const line of result.stdout.split('\n')) {
    // 地址形如 127.0.0.1:18931、*:22、[::]:22、0.0.0.0:111
    const match = /:(\d+)\s*$/.exec(line.trim());
    if (!match) continue;
    const port = Number.parseInt(match[1]!, 10);
    if (Number.isFinite(port)) ports.add(port);
  }
  return ports;
}

/**
 * 在远端挑选若干互不相同的空闲端口。
 *
 * 结果只是"探测时空闲"，调用方必须准备好启动失败后重试（见文件头）。
 *
 * @param transport - 已连接的传输
 * @param count - 需要的端口数量
 * @param options - 选项
 * @returns 端口列表，长度等于 count
 * @throws RemoteError('EXEC_FAILED') 尝试多次仍未找到足够的空闲端口
 */
export async function allocateRemotePorts(
  transport: RemoteTransport,
  count: number,
  options: {
    /** 额外排除的端口（如同一会话已分配、但尚未监听的端口） */
    exclude?: Iterable<number>;
    /** 取消信号 */
    signal?: AbortSignal;
  } = {},
): Promise<number[]> {
  const occupied = await listRemoteListeningPorts(transport, options.signal);
  for (const port of options.exclude ?? []) occupied.add(port);

  const picked: number[] = [];
  for (let attempt = 0; attempt < MAX_ATTEMPTS && picked.length < count; attempt += 1) {
    const candidate = randomPort();
    if (occupied.has(candidate)) continue;
    occupied.add(candidate);
    picked.push(candidate);
  }

  if (picked.length < count) {
    throw new RemoteError(
      'EXEC_FAILED',
      `在主机 ${transport.hostAlias} 上尝试 ${MAX_ATTEMPTS} 次仍未找到 ${count} 个空闲端口`
        + `（候选区间 ${PORT_RANGE_START}–${PORT_RANGE_START + PORT_RANGE_SIZE - 1}）`,
      { hostAlias: transport.hostAlias },
    );
  }
  return picked;
}

/**
 * 确认远端某端口当前确实在监听。
 *
 * 用于启动后验证服务真的起来了——比只看进程存活更可靠。
 *
 * @param transport - 已连接的传输
 * @param port - 待确认端口
 * @param signal - 取消信号
 * @returns 是否在监听
 */
export async function isRemotePortListening(
  transport: RemoteTransport,
  port: number,
  signal?: AbortSignal,
): Promise<boolean> {
  const ports = await listRemoteListeningPorts(transport, signal);
  return ports.has(port);
}

/**
 * 在候选区间内随机取一个端口。
 *
 * 随机而非顺序递增：多个 CLI 并发分配时，顺序扫描会让它们大概率选中同一个
 * 端口（都从区间头部开始），随机能把冲突概率摊薄。
 *
 * @returns 端口号
 */
function randomPort(): number {
  return PORT_RANGE_START + Math.floor(Math.random() * PORT_RANGE_SIZE);
}

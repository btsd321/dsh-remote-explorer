/**
 * @file 心跳探活
 * @description 周期性确认「SSH 链路可用 + 远端 dsh 进程存活 + 端口在监听」三件事。
 *
 * 参数直接对标 Zed（`remote_client.rs:160`）：间隔 5 秒、超时 5 秒、
 * 连续丢失 5 次判定断开。它的取舍值得沿用——间隔太长则断线感知迟钝，
 * 太短则在高延迟链路上误判。
 *
 * **一次心跳只发一条命令。** 三项检查合并成一个远端脚本，而不是分三次 exec：
 * 每 5 秒三次 SSH 往返在高延迟链路上会明显占用通道配额，也更容易触发超时误判。
 *
 * 缺少免认证 HTTP 探活端点（`/healthz` 等在 dsh 上全部 404，`/` 无令牌时 401），
 * 所以只能用 pid + 端口的组合判据，真正的 HTTP 探活要等 `dsh-remote-guard`（P5）。
 */

import { quote } from '../util/shell-quote.js';
import type { RemoteTransport } from '../transport/types.js';

/** 心跳间隔（毫秒） */
export const HEARTBEAT_INTERVAL_MS = 5_000;

/** 单次心跳的超时（毫秒） */
export const HEARTBEAT_TIMEOUT_MS = 5_000;

/** 一次心跳的结果 */
export interface HeartbeatResult {
  /** 是否全部检查通过 */
  isHealthy: boolean;
  /** 失败原因；健康时为 undefined */
  reason?: string;
}

/**
 * 执行一次心跳检查。
 *
 * 不抛错——链路故障与远端进程退出都是预期情形，统一以返回值表达，
 * 让调用方（状态机）决定如何处置。
 *
 * @param transport - 传输实例
 * @param options - 检查目标
 * @returns 心跳结果
 */
export async function beat(
  transport: RemoteTransport,
  options: {
    /** 远端 dsh 的 pid */
    pid: number;
    /** 远端监听端口 */
    port: number;
    /** 取消信号 */
    signal?: AbortSignal;
  },
): Promise<HeartbeatResult> {
  const { pid, port, signal } = options;

  // 三项检查一条命令：kill -0 查进程，ss/netstat 查监听
  const script = [
    `kill -0 ${pid} 2>/dev/null && printf 'PID=ok\\n' || printf 'PID=dead\\n'`,
    'if command -v ss >/dev/null 2>&1; then',
    `  ss -ltnH 2>/dev/null | grep -q ":${port} " && printf 'PORT=ok\\n' || printf 'PORT=down\\n'`,
    'elif command -v netstat >/dev/null 2>&1; then',
    `  netstat -ltn 2>/dev/null | grep -q ":${port} " && printf 'PORT=ok\\n' || printf 'PORT=down\\n'`,
    'else',
    // 两个工具都没有时不能据此判死，否则会在精简镜像上无限误判重连
    "  printf 'PORT=unknown\\n'",
    'fi',
  ].join('\n');

  try {
    const result = await transport.exec(script, {
      allowNonZeroExit: true,
      timeoutMs: HEARTBEAT_TIMEOUT_MS,
      ...(signal ? { signal } : {}),
    });

    if (result.stdout.includes('PID=dead')) {
      return { isHealthy: false, reason: `远端 dsh 进程（pid ${pid}）已退出` };
    }
    if (result.stdout.includes('PORT=down')) {
      return { isHealthy: false, reason: `远端端口 ${port} 已停止监听` };
    }
    return { isHealthy: true };
  } catch (error) {
    // exec 失败意味着 SSH 链路本身有问题
    return {
      isHealthy: false,
      reason: `SSH 链路异常：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * 心跳循环。
 *
 * 用 `setTimeout` 递归而非 `setInterval`：后者不等上一次完成就触发下一次，
 * 在慢链路上会堆积并耗尽通道配额。
 */
export class Heartbeat {
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;

  /**
   * @param transport - 传输实例的取值函数；重连后传输会被替换，所以取实时值
   * @param target - 检查目标的取值函数
   * @param onResult - 每次心跳的结果回调
   */
  constructor(
    private readonly transport: () => RemoteTransport,
    private readonly target: () => { pid: number; port: number },
    private readonly onResult: (result: HeartbeatResult) => void,
  ) {}

  /** 启动循环 */
  start(): void {
    this.stopped = false;
    this.schedule();
  }

  /** 停止循环；幂等 */
  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /** 安排下一次心跳 */
  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => { void this.tick(); }, HEARTBEAT_INTERVAL_MS);
    // 不阻止进程退出——CLI 收到 Ctrl-C 时应当能干净退出
    this.timer.unref();
  }

  /** 执行一次心跳并安排下一次 */
  private async tick(): Promise<void> {
    if (this.stopped) return;
    const result = await beat(this.transport(), this.target());
    if (this.stopped) return;
    this.onResult(result);
    this.schedule();
  }
}

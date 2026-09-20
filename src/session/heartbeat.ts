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
 * 三层判据，一条命令拿全（每 5 秒一次，三次往返在高延迟链路上会占配额）：
 *
 * 1. 进程存活（`kill -0`）
 * 2. 端口监听（`ss`/`netstat`）
 * 3. **HTTP 应用级存活**：带会话令牌 curl 一次 webserver 根路径。
 *    这层是 P5 对 guard `/healthz` 职责的替代实现——dsh 没有免认证探活端点
 *    （`/healthz` 等全部 404），但 P0 实测带令牌访问 `/` 会得到 303，
 *    于是「拿到任何 HTTP 状态码」即证明 webserver 在真正服务请求，
 *    不止是端口被绑住。curl 不存在时跳过这层（回到 pid+端口语义）。
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
    /** 会话访问令牌（HTTP 层探活用） */
    token?: string;
    /** 取消信号 */
    signal?: AbortSignal;
  },
): Promise<HeartbeatResult> {
  const { pid, port, token, signal } = options;

  const lines = [
    `kill -0 ${pid} 2>/dev/null && printf 'PID=ok\\n' || printf 'PID=dead\\n'`,
    'if command -v ss >/dev/null 2>&1; then',
    `  ss -ltnH 2>/dev/null | grep -q ":${port} " && printf 'PORT=ok\\n' || printf 'PORT=down\\n'`,
    'elif command -v netstat >/dev/null 2>&1; then',
    `  netstat -ltn 2>/dev/null | grep -q ":${port} " && printf 'PORT=ok\\n' || printf 'PORT=down\\n'`,
    'else',
    // 两个工具都没有时不能据此判死，否则会在精简镜像上无限误判重连
    "  printf 'PORT=unknown\\n'",
    'fi',
  ];

  // 令牌在命令行里短暂出现（经 SSH 加密传输）——但绝不打进日志：
  // 输出只写 HTTP 状态码。curl 不存在时这层直接 unknown
  if (token !== undefined) {
    lines.push(
      'if command -v curl >/dev/null 2>&1; then',
      // -m 3: 探活自身的超时，短于整体心跳超时，避免拖垮整次检查。
      // 任何非 000 的状态码（303/401/200…）都证明 HTTP 服务在响应
      `  printf 'HTTP=%s\\n' "$(curl -s -o /dev/null -w '%{http_code}' -m 3 'http://127.0.0.1:${port}/?token=${token}' 2>/dev/null || echo 000)"`,
      'else',
      "  printf 'HTTP=unknown\\n'",
      'fi',
    );
  }

  try {
    const result = await transport.exec(lines.join('\n'), {
      allowNonZeroExit: true,
      timeoutMs: HEARTBEAT_TIMEOUT_MS,
      ...(signal ? { signal } : {}),
    });

    const httpCode = /^HTTP=(\d+|unknown)$/m.exec(result.stdout)?.[1];

    if (result.stdout.includes('PID=dead')) {
      return { isHealthy: false, reason: `远端 dsh 进程（pid ${pid}）已退出` };
    }
    if (result.stdout.includes('PORT=down')) {
      return { isHealthy: false, reason: `远端端口 ${port} 已停止监听` };
    }
    // HTTP=000：连接建立不了——进程在、端口在，但 webserver 不应答。
    // 这正是 pid+端口判据探测不到的故障层（进程僵死、事件循环卡住）
    if (httpCode === '000') {
      return { isHealthy: false, reason: `远端 dsh 无 HTTP 响应（127.0.0.1:${port} 连不上 webserver）` };
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
   * @param target - 检查目标的取值函数（含 HTTP 探活用的会话令牌）
   * @param onResult - 每次心跳的结果回调
   */
  constructor(
    private readonly transport: () => RemoteTransport,
    private readonly target: () => { pid: number; port: number; token?: string },
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

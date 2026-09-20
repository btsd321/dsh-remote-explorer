/**
 * @file 重连退避
 * @description 有限次指数退避重连的延时计算与执行。
 *
 * 参数沿用旧实现 `remote-connection.ts` 的默认值，与 Zed 的
 * `MAX_RECONNECT_ATTEMPTS = 3` 一致：
 *
 * ```
 * enabled: true, maxAttempts: 3, initialDelayMs: 1000,
 * backoffMultiplier: 2, maxDelayMs: 10_000
 * ```
 *
 * 为什么是有限次而非无限重试：SSH 断开的常见原因（主机关机、网络变更、
 * 凭据失效）大多不会在几十秒内自愈。无限重试只会让用户对着一个永远
 * "重连中"的界面等待，不如尽快报错并说明「远端操作结果未知」——
 * 这与 dsh-ssh 的断线语义一致：客户端如实报告未确认结果，绝不重放。
 */

import { RemoteError } from '../util/errors.js';

/** 重连配置 */
export interface ReconnectConfig {
  /** 是否启用自动重连 */
  enabled: boolean;
  /** 最大尝试次数 */
  maxAttempts: number;
  /** 首次重连前的延时（毫秒） */
  initialDelayMs: number;
  /** 每次失败后延时的乘数 */
  backoffMultiplier: number;
  /** 延时上限（毫秒） */
  maxDelayMs: number;
}

/** 默认重连配置 */
export const DEFAULT_RECONNECT_CONFIG: ReconnectConfig = {
  enabled: true,
  maxAttempts: 3,
  initialDelayMs: 1_000,
  backoffMultiplier: 2,
  maxDelayMs: 10_000,
};

/**
 * 计算第 n 次重连前应等待的时长。
 *
 * @param attempt - 第几次尝试，从 1 开始
 * @param config - 重连配置
 * @returns 延时（毫秒）
 */
export function backoffDelay(attempt: number, config: ReconnectConfig): number {
  const exponent = Math.max(0, attempt - 1);
  const raw = config.initialDelayMs * config.backoffMultiplier ** exponent;
  return Math.min(raw, config.maxDelayMs);
}

/**
 * 可取消的延时等待。
 *
 * @param ms - 毫秒
 * @param signal - 取消信号
 * @throws RemoteError('ABORTED') 等待期间被取消
 */
export async function wait(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    timer.unref();
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new RemoteError('ABORTED', '重连等待被取消'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

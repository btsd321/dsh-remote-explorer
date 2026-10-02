/**
 * @file 可取消等待原语
 * @description 会话层共享的延时等待原语。原先 remote-process.ts 的 delay 与
 *              reconnect.ts 的 wait 两份实现逐行雷同（定时器 unref + abort
 *              监听 + 中止拒绝），仅中止错误文案不同——收口到此处单一实现，
 *              用 label 选项区分语义，后续修等待清理逻辑只改一处。
 *
 * 约束：定时器一律 unref——轮询与退避等待都是「可被放弃的等待」，不允许
 * 挂着的定时器阻止进程退出。
 */

import { RemoteError } from '../util/errors.js';

/** 可取消等待选项 */
export interface CancellableWaitOptions {
  /** 中止错误文案的语义前缀（如「重连等待」）；缺省时报「等待被取消」 */
  label?: string;
}

/**
 * 可取消的延时等待。
 *
 * 信号中止时以 RemoteError('ABORTED') 拒绝，文案由 label 区分调用方语义：
 * 缺省报「等待被取消」，传「重连等待」则报「重连等待被取消」。
 *
 * @param ms - 等待毫秒数
 * @param signal - 取消信号；缺省时退化为纯延时
 * @param options - 选项（label）
 * @throws RemoteError('ABORTED') 等待期间信号被中止
 */
export async function cancellableWait(
  ms: number,
  signal?: AbortSignal,
  options?: CancellableWaitOptions,
): Promise<void> {
  signal?.throwIfAborted();
  const label = options?.label;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    // unref：可放弃的等待不阻止进程退出
    timer.unref();
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new RemoteError('ABORTED', label !== undefined ? `${label}被取消` : '等待被取消'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

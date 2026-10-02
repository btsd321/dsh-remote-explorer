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
 * 调用时信号已中止（预中止）与等待期间取消抛同一种错误——调用方无需
 * 区分中止时机（CLI 退出码映射也只认 RemoteError 的 code）。
 *
 * @param ms - 等待毫秒数
 * @param signal - 取消信号；缺省时退化为纯延时
 * @param options - 选项（label）
 * @throws RemoteError('ABORTED') 信号被中止（含调用时已中止）
 */
export async function cancellableWait(
  ms: number,
  signal?: AbortSignal,
  options?: CancellableWaitOptions,
): Promise<void> {
  const label = options?.label;
  const abortMessage = label !== undefined ? `${label}被取消` : '等待被取消';
  // 预中止不走 signal.throwIfAborted()：它抛 Node 内置 AbortError，与
  // 等待期间取消路径的 RemoteError('ABORTED') 类型不一致（内置异常会让
  // CLI 的错误呈现走「打印完整堆栈 + 退出码 1」分支）；直接检查 aborted
  // 抛 RemoteError，两条取消路径行为统一
  if (signal?.aborted) throw new RemoteError('ABORTED', abortMessage);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    // unref：可放弃的等待不阻止进程退出
    timer.unref();
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new RemoteError('ABORTED', abortMessage));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * @file 远端页面剪贴板写入降级（execCommand('copy') 兜底）
 * @description DeepSeek Harness 桌面端在 `<webview>` guest partition 里硬编码拒绝
 *              所有权限请求（`setPermissionRequestHandler(() => cb(false))` /
 *              `setPermissionCheckHandler(() => false)`），导致远端页面里所有调用
 *              `navigator.clipboard.writeText(...)` 的复制按钮（右键「复制链接地址」/
 *              「复制路径」、代码块复制、会话 ID 复制等）全部以 `NotAllowedError` 失败：
 *              - `dsh-client-ui-open-in-app` 等插件直接 `await navigator.clipboard.writeText(...)`
 *                没有任何降级；
 *              - `dsh-web-frontend` 的 `writeClipboard` 虽然自带 `execCommand('copy')`
 *                代码，但在 `writeText` 抛错的 `catch` 分支直接 `return false`，并未回退。
 *
 *              本模块运行在远端页面的 `dsh-remote-handoff` 浏览器半内，与远端 dsh 前端
 *              共享同一 `window` / `navigator` / `document`。激活时对 `navigator.clipboard.writeText`
 *              包一层无害兜底：
 *              - 始终优先调用原生 `writeText`——浏览器直连等原生已授权环境零改动、零 DOM 副作用；
 *              - 仅在原生 `writeText` 抛错/拒绝时，回退到标准 DOM 的离线 `<textarea>` +
 *                `document.execCommand('copy')`（走 Blink `Editor::Copy()`，不经过
 *                `clipboard-sanitized-write` 权限查询）；
 *              - 若降级仍返回 `false` 或抛错，重新抛出原始异常，不制造假成功。
 *
 *              卸载时按原 descriptor 精确还原，不残留 monkey-patch。
 */

/** 剪贴板写入接口（与浏览器 `Clipboard` 及单测桩兼容） */
export interface ClipboardLike {
  /** 写入纯文本到剪贴板 */
  writeText(text: string): Promise<void>;
}

/** 可克隆选区范围的最小接口 */
export interface RangeLike {
  /** 克隆范围（可选；单测桩可省略） */
  cloneRange?: () => RangeLike;
}

/** 选区对象的最小接口 */
export interface SelectionLike {
  /** 选区包含的 Range 数量 */
  readonly rangeCount: number;
  /** 取第 index 个 Range */
  getRangeAt(index: number): RangeLike;
  /** 清空全部 Range */
  removeAllRanges(): void;
  /** 恢复一个 Range */
  addRange(range: RangeLike): void;
}

/** 可聚焦元素的最小接口 */
export interface FocusableElementLike {
  /** 是否仍挂在文档树上 */
  readonly isConnected?: boolean;
  /** 聚焦（支持 preventScroll 避免页面跳动） */
  focus?: (options?: { preventScroll?: boolean }) => void;
}

/** 临时 textarea 元素的最小接口 */
export interface TextAreaLike extends FocusableElementLike {
  /** 文本值 */
  value: string;
  /** 内联样式 */
  style: { cssText: string };
  /** 设置属性 */
  setAttribute(name: string, value: string): void;
  /** 选中全部文本 */
  select(): void;
  /** 显式设置选区范围（兼容部分平台 select() 行为差异） */
  setSelectionRange?: (start: number, end: number) => void;
  /** 从 DOM 移除 */
  remove(): void;
}

/** 文档对象的最小接口（兼容浏览器 `Document` 与单测桩） */
export interface DocumentLike {
  /** 文档 body（挂载临时 textarea） */
  readonly body: { appendChild(node: TextAreaLike): unknown } | null;
  /** 当前聚焦元素（复制结束后还原焦点） */
  readonly activeElement?: FocusableElementLike | null;
  /** 创建 textarea 元素 */
  createElement(tagName: 'textarea'): TextAreaLike;
  /** 取当前选区（复制结束后还原选区） */
  getSelection?: () => SelectionLike | null;
  /** 执行传统编辑命令 */
  execCommand?: (commandId: string) => boolean;
}

/** 依赖注入环境（生产默认取全局 `navigator.clipboard` 与 `document`） */
export interface ClipboardFallbackEnv {
  /** 目标剪贴板对象 */
  clipboard?: ClipboardLike | null;
  /** 目标文档对象 */
  document?: DocumentLike | null;
}

/** 临时 textarea 离屏样式：固定在视口顶部外侧，避免 focus/select 触发滚动 */
const OFFSCREEN_TEXTAREA_STYLE = 'position:fixed;top:0;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;';

/**
 * 通过临时 `<textarea>` + `document.execCommand('copy')` 复制文本，
 * 并在结束后还原原有选区与焦点。
 *
 * @param text - 待复制纯文本
 * @param doc - 文档对象
 * @returns true = `execCommand('copy')` 返回成功；false = 环境不可用或命令被拒
 */
export function copyViaExecCommand(text: string, doc: DocumentLike | null | undefined): boolean {
  if (doc === null || doc === undefined) return false;
  if (doc.body === null || typeof doc.execCommand !== 'function') return false;

  const previousFocus = doc.activeElement ?? null;
  const selection = typeof doc.getSelection === 'function' ? doc.getSelection() : null;
  const savedRanges: RangeLike[] = [];
  if (selection !== null) {
    for (let i = 0; i < selection.rangeCount; i += 1) {
      try {
        const range = selection.getRangeAt(i);
        savedRanges.push(typeof range.cloneRange === 'function' ? range.cloneRange() : range);
      } catch { /* 选区读异常时不阻断复制 */ }
    }
  }

  const textarea = doc.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.setAttribute('aria-hidden', 'true');
  textarea.style.cssText = OFFSCREEN_TEXTAREA_STYLE;

  try {
    doc.body.appendChild(textarea);
    textarea.focus?.({ preventScroll: true });
    textarea.select();
    textarea.setSelectionRange?.(0, text.length);
    return doc.execCommand('copy') === true;
  } catch {
    return false;
  } finally {
    try { textarea.remove(); } catch { /* 已移除则忽略 */ }
    if (selection !== null && savedRanges.length > 0) {
      try {
        selection.removeAllRanges();
        for (const range of savedRanges) selection.addRange(range);
      } catch { /* 还原选区失败不影响复制结果 */ }
    }
    if (
      previousFocus !== null
      && previousFocus.isConnected !== false
      && typeof previousFocus.focus === 'function'
    ) {
      try { previousFocus.focus({ preventScroll: true }); } catch { /* 忽略焦点还原失败 */ }
    }
  }
}

/**
 * 尝试在目标对象上覆写 `writeText` 属性，返回还原句柄；不可写时返回 undefined。
 *
 * @param target - 挂属性的对象（`navigator.clipboard` 实例或其原型）
 * @param wrapped - 包装后的 `writeText` 函数
 * @returns 成功时返回还原函数，失败返回 undefined
 */
function defineWrappedWriteText(
  target: object,
  wrapped: ClipboardLike['writeText'],
): (() => void) | undefined {
  const prevDescriptor = Object.getOwnPropertyDescriptor(target, 'writeText');
  try {
    Object.defineProperty(target, 'writeText', {
      configurable: true,
      writable: true,
      value: wrapped,
    });
  } catch {
    return undefined;
  }

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    // 若后续又被其他代码包装过，不强行覆盖
    const current = Object.getOwnPropertyDescriptor(target, 'writeText');
    if (current?.value !== wrapped) return;
    try {
      if (prevDescriptor !== undefined) {
        Object.defineProperty(target, 'writeText', prevDescriptor);
      } else {
        Reflect.deleteProperty(target, 'writeText');
      }
    } catch { /* 环境已冻结/卸载时忽略 */ }
  };
}

/**
 * 已安装兜底的清理函数表：同一 clipboard 目标只包装一次。
 *
 * 用 WeakMap 而不是在对象上打标记：剪贴板对象生命周期跟随页面，WeakMap 不会
 * 在页面卸载后留下引用；也不需要往共享对象上塞私有属性。
 */
const installedDisposers = new WeakMap<object, () => void>();

/**
 * 为 `navigator.clipboard.writeText` 安装 `execCommand('copy')` 失败兜底。
 *
 * 包装方法只装在 `clipboard` 实例自身，**不动任何原型**：远端页面与远端 dsh
 * 前端、各插件共享同一个 `window`/`navigator`，改 `Clipboard.prototype` 会把
 * 兜底扩散到整页所有 `Clipboard` 使用者。实例无法覆写时直接放弃（返回空操作），
 * 调用方的原生 `writeText` 继续按原语义抛错。
 *
 * 安装幂等：同一 clipboard 目标只包一次。返回的清理函数幂等，供 Cordis
 * `ctx.effect` 在卸载时调用。
 *
 * @param env - 可选注入环境（字段缺省时回落到全局 `navigator.clipboard` / `document`）
 * @returns 清理函数（还原原方法；环境不支持时返回空操作）
 */
export function installClipboardFallback(env?: ClipboardFallbackEnv): () => void {
  // 逐字段回落：只传 document 的注入场景（单测/延迟构造）不应让 clipboard 变成
  // undefined 而整块兜底失效；显式传 null 仍然表示「禁用该字段」
  const clipboard = env !== undefined && 'clipboard' in env
    ? env.clipboard
    : (typeof navigator !== 'undefined' ? navigator.clipboard : undefined);
  const doc: DocumentLike | null | undefined = env !== undefined && 'document' in env
    ? env.document
    : (typeof document !== 'undefined' ? (document as unknown as DocumentLike) : undefined);

  if (clipboard === null || clipboard === undefined || typeof clipboard.writeText !== 'function') {
    return () => {};
  }

  // 幂等：重复安装返回同一个清理函数。否则第二次安装会把第一次的包装当成
  // original 再包一层，卸载时只有最外层能还原（内层包装被一起丢掉），
  // 且一次失败会跑两遍兜底
  const existingDisposer = installedDisposers.get(clipboard);
  if (existingDisposer !== undefined) return existingDisposer;

  const original = clipboard.writeText;
  const wrapped: ClipboardLike['writeText'] = async function (
    this: ClipboardLike | undefined,
    text: string,
  ): Promise<void> {
    const value = String(text);
    try {
      await original.call(this ?? clipboard, value);
    } catch (originalError) {
      if (copyViaExecCommand(value, doc)) return;
      throw originalError;
    }
  };

  const restore = defineWrappedWriteText(clipboard, wrapped);
  if (restore === undefined) {
    // 实例不可覆写（冻结对象/受限宿主）：放弃兜底。不退化成改原型——见上面的说明，
    // 且当失败原因是「实例已有不可配置的 writeText」时改原型本来就静默无效
    return () => {};
  }

  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    installedDisposers.delete(clipboard);
    restore();
  };
  installedDisposers.set(clipboard, dispose);
  return dispose;
}

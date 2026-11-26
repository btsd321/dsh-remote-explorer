/**
 * @file handoff/clipboard-fallback.ts 单元测试
 * @description 覆盖原生 writeText 成功/失败降级、execCommand 失败透传原错、
 *              选区与焦点还原、原型链安装与卸载还原等行为。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  copyViaExecCommand,
  installClipboardFallback,
  type ClipboardLike,
  type DocumentLike,
  type FocusableElementLike,
  type RangeLike,
  type SelectionLike,
  type TextAreaLike,
} from '../../src/handoff/clipboard-fallback.js';

interface FakeDocControls {
  doc: DocumentLike;
  appended: TextAreaLike[];
  removed: TextAreaLike[];
  commands: string[];
  focusedCount: () => number;
  restoredRanges: RangeLike[];
  lastSelectionRange: () => [number, number] | undefined;
}

/** 构造纯内存 DOM 桩，验证 textarea 生命周期与焦点/选区还原 */
function createFakeDocument(options: {
  execResult?: boolean;
  execThrows?: boolean;
  activeElement?: FocusableElementLike | null;
  initialRanges?: RangeLike[];
} = {}): FakeDocControls {
  const appended: TextAreaLike[] = [];
  const removed: TextAreaLike[] = [];
  const commands: string[] = [];
  let focusCalls = 0;
  let selectionRange: [number, number] | undefined;
  const restoredRanges: RangeLike[] = [];

  const initialRanges = options.initialRanges ?? [];
  const selection: SelectionLike = {
    get rangeCount() { return initialRanges.length; },
    getRangeAt(index: number) { return initialRanges[index]!; },
    removeAllRanges() { restoredRanges.length = 0; },
    addRange(range: RangeLike) { restoredRanges.push(range); },
  };

  const doc: DocumentLike = {
    body: {
      appendChild(node: TextAreaLike) {
        appended.push(node);
        return node;
      },
    },
    activeElement: options.activeElement ?? null,
    createElement() {
      const attrs = new Map<string, string>();
      const textarea: TextAreaLike = {
        value: '',
        style: { cssText: '' },
        setAttribute(name: string, value: string) { attrs.set(name, value); },
        focus() { focusCalls += 1; },
        select() { selectionRange = [0, textarea.value.length]; },
        setSelectionRange(start: number, end: number) { selectionRange = [start, end]; },
        remove() { removed.push(textarea); },
      };
      return textarea;
    },
    getSelection() { return selection; },
    execCommand(commandId: string) {
      commands.push(commandId);
      if (options.execThrows) throw new Error('execCommand crashed');
      return options.execResult ?? true;
    },
  };

  return {
    doc,
    appended,
    removed,
    commands,
    focusedCount: () => focusCalls,
    restoredRanges,
    lastSelectionRange: () => selectionRange,
  };
}

describe('copyViaExecCommand', () => {
  it('创建离屏 textarea、选中并执行 copy 后清理 DOM 并还原焦点与选区', () => {
    let prevFocusRestored = false;
    let prevFocusOptions: { preventScroll?: boolean } | undefined;
    const prevFocus: FocusableElementLike = {
      isConnected: true,
      focus(opts) {
        prevFocusRestored = true;
        prevFocusOptions = opts;
      },
    };
    const originalRange: RangeLike = { cloneRange: () => ({ ...originalRange }) };
    const fake = createFakeDocument({
      execResult: true,
      activeElement: prevFocus,
      initialRanges: [originalRange],
    });

    assert.equal(copyViaExecCommand('https://www.v2ex.com/', fake.doc), true);
    assert.equal(fake.appended.length, 1);
    assert.equal(fake.appended[0]?.value, 'https://www.v2ex.com/');
    assert.equal(fake.removed.length, 1);
    assert.deepEqual(fake.commands, ['copy']);
    assert.deepEqual(fake.lastSelectionRange(), [0, 'https://www.v2ex.com/'.length]);
    assert.equal(fake.focusedCount(), 1);
    assert.equal(prevFocusRestored, true);
    assert.deepEqual(prevFocusOptions, { preventScroll: true });
    assert.equal(fake.restoredRanges.length, 1);
  });

  it('execCommand 返回 false 或抛错时返回 false 且仍清理 textarea', () => {
    const denied = createFakeDocument({ execResult: false });
    assert.equal(copyViaExecCommand('abc', denied.doc), false);
    assert.equal(denied.removed.length, 1);

    const crashed = createFakeDocument({ execThrows: true });
    assert.equal(copyViaExecCommand('abc', crashed.doc), false);
    assert.equal(crashed.removed.length, 1);
  });

  it('文档或 body 缺失时返回 false', () => {
    assert.equal(copyViaExecCommand('abc', null), false);
    assert.equal(copyViaExecCommand('abc', undefined), false);
    assert.equal(
      copyViaExecCommand('abc', {
        body: null,
        createElement() { throw new Error('should not be called'); },
      }),
      false,
    );
  });
});

describe('installClipboardFallback', () => {
  it('原生 writeText 成功时不触发 execCommand 降级', async () => {
    const written: string[] = [];
    const clipboard: ClipboardLike = {
      async writeText(text: string) { written.push(text); },
    };
    const fake = createFakeDocument({ execResult: true });
    const dispose = installClipboardFallback({ clipboard, document: fake.doc });

    await clipboard.writeText('hello');
    assert.deepEqual(written, ['hello']);
    assert.equal(fake.commands.length, 0);

    dispose();
  });

  it('原生 writeText 拒绝（如 NotAllowedError）时降级到 execCommand 并成功 resolve', async () => {
    const clipboard: ClipboardLike = {
      async writeText() { throw new Error('NotAllowedError'); },
    };
    const fake = createFakeDocument({ execResult: true });
    const dispose = installClipboardFallback({ clipboard, document: fake.doc });

    await clipboard.writeText('https://www.v2ex.com/');
    assert.deepEqual(fake.commands, ['copy']);
    assert.equal(fake.appended[0]?.value, 'https://www.v2ex.com/');

    dispose();
  });

  it('原生 writeText 与 execCommand 双双失败时重新抛出原始异常', async () => {
    const rootError = new Error('Write permission denied');
    const clipboard: ClipboardLike = {
      async writeText() { throw rootError; },
    };
    const fake = createFakeDocument({ execResult: false });
    const dispose = installClipboardFallback({ clipboard, document: fake.doc });

    await assert.rejects(() => clipboard.writeText('fail'), (error) => error === rootError);
    assert.deepEqual(fake.commands, ['copy']);

    dispose();
  });

  it('支持解构后直接调用（不丢失 this）且对非字符串做 String 归一化', async () => {
    let seenThis: unknown;
    let seenText: unknown;
    const clipboard: ClipboardLike = {
      async writeText(text: string) {
        seenThis = this;
        seenText = text;
      },
    };
    const fake = createFakeDocument({ execResult: true });
    const dispose = installClipboardFallback({ clipboard, document: fake.doc });

    const detached = clipboard.writeText;
    await detached(12345 as unknown as string);
    assert.equal(seenThis, clipboard);
    assert.equal(seenText, '12345');

    dispose();
  });

  it('卸载时按原 descriptor 精确还原（含继承自原型的标准 Clipboard 实例）', async () => {
    class FakeClipboard implements ClipboardLike {
      async writeText() { throw new Error('denied'); }
    }
    const clipboard = new FakeClipboard();
    const fake = createFakeDocument({ execResult: true });
    const dispose = installClipboardFallback({ clipboard, document: fake.doc });

    assert.equal(Object.prototype.hasOwnProperty.call(clipboard, 'writeText'), true);
    await clipboard.writeText('ok');

    dispose();
    // 卸载后删掉自身属性，回到原型方法（重新抛 denied）
    assert.equal(Object.prototype.hasOwnProperty.call(clipboard, 'writeText'), false);
    assert.equal(clipboard.writeText, FakeClipboard.prototype.writeText);
    await assert.rejects(() => clipboard.writeText('ok'), /denied/);
    // 幂等再调不报错
    dispose();
  });

  it('实例不可覆写时放弃兜底，且不改动原生原型', async () => {
    class FrozenClipboard implements ClipboardLike {
      async writeText() { throw new Error('denied'); }
    }
    const clipboard = Object.freeze(new FrozenClipboard());
    const origProtoMethod = FrozenClipboard.prototype.writeText;
    const fake = createFakeDocument({ execResult: true });

    const dispose = installClipboardFallback({ clipboard, document: fake.doc });
    // 不改原型：远端页面与 dsh 前端共享同一 window，改 Clipboard.prototype 会把
    // 兜底扩散到整页所有使用者；且若失败原因是实例已有不可配置的 writeText，
    // 改原型本来就静默无效。放弃兜底后原生语义原样保留。
    await assert.rejects(() => clipboard.writeText('from-frozen'), /denied/);
    assert.deepEqual(fake.commands, []);
    assert.equal(FrozenClipboard.prototype.writeText, origProtoMethod);
    dispose();
  });

  it('重复安装返回同一清理函数，卸载后恢复原方法（幂等）', async () => {
    const rootError = new Error('denied');
    const clipboard: ClipboardLike = { async writeText() { throw rootError; } };
    const original = clipboard.writeText;
    const fake = createFakeDocument({ execResult: true });

    const disposeA = installClipboardFallback({ clipboard, document: fake.doc });
    const disposeB = installClipboardFallback({ clipboard, document: fake.doc });

    assert.equal(disposeA, disposeB, '同一 clipboard 目标重复安装应复用首个清理函数');
    await clipboard.writeText('x');
    assert.deepEqual(fake.commands, ['copy'], '一次失败只应跑一次兜底');
    disposeA();
    disposeB();
    assert.equal(clipboard.writeText, original, '卸载后应还原为原始方法');
  });

  it('只注入 clipboard 时 document 回落到全局（不整块失效）', async () => {
    const rootError = new Error('denied');
    const clipboard: ClipboardLike = { async writeText() { throw rootError; } };
    const dispose = installClipboardFallback({ clipboard });

    // Node 环境没有全局 document：兜底不可用，应重新抛出原始异常而不是静默成功
    await assert.rejects(() => clipboard.writeText('x'), (error) => error === rootError);
    dispose();
  });

  it('若后续被其他代码再次覆写，卸载时不强行覆盖他人包装', () => {
    const clipboard: ClipboardLike = { async writeText() {} };
    const fake = createFakeDocument({ execResult: true });
    const dispose = installClipboardFallback({ clipboard, document: fake.doc });

    const thirdParty = async () => {};
    clipboard.writeText = thirdParty;

    dispose();
    assert.equal(clipboard.writeText, thirdParty);
  });

  it('缺少 clipboard 时安全返回空清理函数', () => {
    const dispose = installClipboardFallback({ clipboard: null, document: null });
    assert.doesNotThrow(() => dispose());
  });
});

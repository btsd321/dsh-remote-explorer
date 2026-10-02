/**
 * @file util/errors.ts 单元测试
 * @description 覆盖 toErrorMessage 对各种捕获值形态的归一化（Error、字符串、
 *              RemoteError、非 Error 对象、原始类型），以及 RemoteError 的
 *              错误码、hostAlias、cause 链保留语义。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RemoteError, toErrorMessage } from '../../src/util/errors.js';

// ─── toErrorMessage（表驱动） ──────────────────────────────────────────────

describe('toErrorMessage（表驱动）', () => {
  /** 归一化表：任意捕获值 → 可读消息 */
  const cases: ReadonlyArray<{ title: string; error: unknown; expected: string }> = [
    { title: 'Error 实例取 message', error: new Error('boom'), expected: 'boom' },
    {
      title: 'Error 子类实例取 message',
      error: new TypeError('not a function'),
      expected: 'not a function',
    },
    {
      title: 'RemoteError 实例取 message（cause 不外溢）',
      error: new RemoteError('EXEC_FAILED', '主机 myhost 执行命令失败', { cause: new Error('stderr') }),
      expected: '主机 myhost 执行命令失败',
    },
    { title: '空消息的 Error 返回空串', error: new Error(''), expected: '' },
    { title: '字符串原样返回', error: 'plain string', expected: 'plain string' },
    { title: '空字符串原样返回', error: '', expected: '' },
    { title: '数字转字符串', error: 42, expected: '42' },
    { title: '零转字符串（不被当作空值）', error: 0, expected: '0' },
    { title: '布尔转字符串', error: true, expected: 'true' },
    { title: 'null 转字符串', error: null, expected: 'null' },
    { title: 'undefined 转字符串', error: undefined, expected: 'undefined' },
    { title: '普通对象转默认字符串形态', error: { a: 1 }, expected: '[object Object]' },
    { title: '数组按 String 语义拼接', error: ['x', 'y'], expected: 'x,y' },
    { title: 'Symbol 转 String 形态', error: Symbol('sym'), expected: 'Symbol(sym)' },
    { title: 'BigInt 转字符串', error: 10n, expected: '10' },
  ];

  for (const { title, error, expected } of cases) {
    it(title, () => {
      assert.equal(toErrorMessage(error), expected);
    });
  }

  it('函数值转源码形态（不崩溃）', () => {
    const text = toErrorMessage(() => 'ignored');
    assert.equal(typeof text, 'string');
    assert.ok(text.length > 0);
  });
});

// ─── RemoteError ──────────────────────────────────────────────────────────

describe('RemoteError', () => {
  it('是 Error 的子类且 name 标识为 RemoteError', () => {
    const err = new RemoteError('HOST_NOT_FOUND', '找不到主机别名 myhost');
    assert.ok(err instanceof Error);
    assert.ok(err instanceof RemoteError);
    assert.equal(err.name, 'RemoteError');
  });

  it('message 与错误码原样保留', () => {
    const err = new RemoteError('HOST_NOT_FOUND', '在 ~/.ssh/config 中找不到主机别名 myhost');
    assert.equal(err.message, '在 ~/.ssh/config 中找不到主机别名 myhost');
    assert.equal(err.code, 'HOST_NOT_FOUND');
  });

  it('hostAlias 可选字段保留与缺省', () => {
    const withAlias = new RemoteError('CONNECT_FAILED', '连接失败', { hostAlias: 'myhost' });
    assert.equal(withAlias.hostAlias, 'myhost');
    const withoutAlias = new RemoteError('CONNECT_FAILED', '连接失败');
    assert.equal(withoutAlias.hostAlias, undefined);
  });

  it('cause 保留底层错误的原始引用', () => {
    const underlying = new Error('ECONNREFUSED');
    const err = new RemoteError('CONNECT_FAILED', '主机 myhost 连接失败', { cause: underlying });
    assert.equal(err.cause, underlying, '同一对象引用，不复制');
  });

  it('未提供 cause 时字段为 undefined', () => {
    const err = new RemoteError('ABORTED', '操作被取消');
    assert.equal(err.cause, undefined);
  });

  it('嵌套 cause：RemoteError 包裹 RemoteError 可逐级读取错误码', () => {
    const inner = new RemoteError('EXEC_FAILED', '安装 dsh 失败', { hostAlias: 'myhost' });
    const outer = new RemoteError('CONNECT_FAILED', '跳板机 j1 连接失败', { cause: inner });
    assert.ok(outer.cause instanceof RemoteError);
    assert.equal((outer.cause as RemoteError).code, 'EXEC_FAILED');
    assert.equal((outer.cause as RemoteError).hostAlias, 'myhost');
  });

  it('各错误码字面量均可作为 code 构造', () => {
    // 遍历类型联合的全部成员：新增错误码时此表补齐即可
    const codes = [
      'HOST_NOT_FOUND',
      'HOST_CONFIG_INVALID',
      'CONNECT_FAILED',
      'EXEC_FAILED',
      'PLATFORM_UNSUPPORTED',
      'NODE_UNSTABLE',
      'MIRROR_ALL_UNREACHABLE',
      'REMOTE_TOOL_MISSING',
      'ABORTED',
    ] as const;
    for (const code of codes) {
      const err = new RemoteError(code, `测试错误码 ${code}`);
      assert.equal(err.code, code);
    }
  });

  it('toErrorMessage 对 RemoteError 只取 message（不暴露 cause 细节）', () => {
    const err = new RemoteError('EXEC_FAILED', '主机 myhost 执行失败', { cause: 'secret-token' });
    const text = toErrorMessage(err);
    assert.equal(text, '主机 myhost 执行失败');
    assert.ok(!text.includes('secret-token'), '凭据材料不得出现在归一化消息里');
  });
});

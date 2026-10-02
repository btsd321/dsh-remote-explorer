/**
 * @file session/reconnect.ts 单元测试
 * @description 覆盖 backoffDelay 退避计算的纯函数行为（首次、连续失败递增、
 *              上限封顶、重置语义、边界 attempt 值）与 wait 的取消语义。
 *              runReconnect 等执行逻辑依赖真实传输，不在本文件范围。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { backoffDelay, wait, DEFAULT_RECONNECT_CONFIG } from '../../src/session/reconnect.js';
import type { ReconnectConfig } from '../../src/session/reconnect.js';
import { RemoteError } from '../../src/util/errors.js';

// ─── backoffDelay（表驱动） ────────────────────────────────────────────────

describe('backoffDelay（表驱动）', () => {
  /** 默认配置下各次尝试的期望延时（毫秒） */
  const defaultConfigCases: ReadonlyArray<{ attempt: number; expected: number; title: string }> = [
    { attempt: 1, expected: 1_000, title: '首次重连等待初始延时' },
    { attempt: 2, expected: 2_000, title: '第二次失败后按乘数翻倍' },
    { attempt: 3, expected: 4_000, title: '第三次失败后继续翻倍' },
    { attempt: 4, expected: 8_000, title: '第四次失败后继续翻倍' },
    { attempt: 5, expected: 10_000, title: '第五次封顶于 maxDelayMs' },
    { attempt: 12, expected: 10_000, title: '超上限的次数一律封顶' },
  ];

  for (const { attempt, expected, title } of defaultConfigCases) {
    it(`${title}（attempt=${attempt} → ${expected}ms）`, () => {
      assert.equal(backoffDelay(attempt, DEFAULT_RECONNECT_CONFIG), expected);
    });
  }

  it('attempt 为 0 或负数时按首次处理（指数下限 0）', () => {
    assert.equal(backoffDelay(0, DEFAULT_RECONNECT_CONFIG), 1_000);
    assert.equal(backoffDelay(-3, DEFAULT_RECONNECT_CONFIG), 1_000);
  });

  it('自定义配置：初始延时、乘数与上限各自生效', () => {
    const config: ReconnectConfig = {
      enabled: true,
      maxAttempts: 5,
      initialDelayMs: 500,
      backoffMultiplier: 3,
      maxDelayMs: 4_000,
    };
    assert.equal(backoffDelay(1, config), 500);
    assert.equal(backoffDelay(2, config), 1_500);
    assert.equal(backoffDelay(3, config), 4_000, '500*3^2=4500 超上限封顶');
    assert.equal(backoffDelay(4, config), 4_000);
  });

  it('乘数为 1 时延时恒等于初始值（线性无增长）', () => {
    const config: ReconnectConfig = {
      enabled: true,
      maxAttempts: 3,
      initialDelayMs: 2_000,
      backoffMultiplier: 1,
      maxDelayMs: 10_000,
    };
    assert.equal(backoffDelay(1, config), 2_000);
    assert.equal(backoffDelay(5, config), 2_000);
  });

  it('上限低于初始延时时立即封顶', () => {
    const config: ReconnectConfig = {
      enabled: true,
      maxAttempts: 3,
      initialDelayMs: 5_000,
      backoffMultiplier: 2,
      maxDelayMs: 3_000,
    };
    assert.equal(backoffDelay(1, config), 3_000);
    assert.equal(backoffDelay(3, config), 3_000);
  });

  it('小数乘数按浮点精确计算', () => {
    const config: ReconnectConfig = {
      enabled: true,
      maxAttempts: 5,
      initialDelayMs: 100,
      backoffMultiplier: 1.5,
      maxDelayMs: 1_000,
    };
    assert.equal(backoffDelay(2, config), 150);
    assert.equal(backoffDelay(3, config), 225);
  });

  it('重置语义：函数无状态，重置即从 attempt=1 重新得到初始延时', () => {
    // backoffDelay 是纯函数：调用若干次后重新从 1 开始，
    // 延时必须回到初始值——「重置」由调用方重置计数实现
    backoffDelay(3, DEFAULT_RECONNECT_CONFIG);
    backoffDelay(5, DEFAULT_RECONNECT_CONFIG);
    assert.equal(backoffDelay(1, DEFAULT_RECONNECT_CONFIG), 1_000);
  });
});

// ─── DEFAULT_RECONNECT_CONFIG ─────────────────────────────────────────────

describe('DEFAULT_RECONNECT_CONFIG', () => {
  it('默认值与旧实现及 Zed 的 MAX_RECONNECT_ATTEMPTS=3 对齐', () => {
    assert.deepEqual(DEFAULT_RECONNECT_CONFIG, {
      enabled: true,
      maxAttempts: 3,
      initialDelayMs: 1_000,
      backoffMultiplier: 2,
      maxDelayMs: 10_000,
    });
  });
});

// ─── wait ─────────────────────────────────────────────────────────────────

describe('wait', () => {
  it('短等待正常完成', async () => {
    await wait(1);
  });

  it('零毫秒等待立即完成', async () => {
    await wait(0);
  });

  it('signal 已中止时立即抛错（当前为 Node 内置 AbortError，见报告）', async () => {
    // 现状：预中止路径走 signal.throwIfAborted()，抛 DOMException AbortError，
    // 与 JSDoc 声明的 RemoteError('ABORTED') 不一致（等待期间取消才是
    // RemoteError）——按实际行为断言，差异记录在测试报告中
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () => wait(1_000, controller.signal),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal((err as Error).name, 'AbortError');
        return true;
      },
    );
  });

  it('等待期间被取消时抛 RemoteError ABORTED（不再等满时长）', async () => {
    const controller = new AbortController();
    const startedAt = Date.now();
    setTimeout(() => controller.abort(), 10);
    await assert.rejects(
      () => wait(60_000, controller.signal),
      (err: unknown) => {
        assert.ok(err instanceof RemoteError);
        assert.equal(err.code, 'ABORTED');
        return true;
      },
    );
    // 若取消未生效会等满 60 秒导致测试超时；这里再校验提前返回
    assert.ok(Date.now() - startedAt < 5_000, '取消应立即中断等待');
  });

  it('无 signal 的等待不受取消影响', async () => {
    await wait(1);
  });
});

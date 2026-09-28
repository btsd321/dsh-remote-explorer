/**
 * @file util/session-display.ts 单元测试
 * @description 验证 STATE_COLORS 与 STATE_LABEL_KEYS 包含所有预期的状态键，
 *              且两者的键集合一致（与 SessionStateTag 一一对应）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { STATE_COLORS, STATE_LABEL_KEYS } from '../../src/util/session-display.js';

/** SessionStateTag 的所有合法值（与 src/session/lifecycle-state.ts 同步） */
const EXPECTED_TAGS = [
  'idle',
  'connecting',
  'connected',
  'heartbeat-missed',
  'reconnecting',
  'reconnect-failed',
  'reconnect-exhausted',
  'disconnected',
] as const;

describe('STATE_COLORS', () => {
  it('包含所有预期状态键', () => {
    for (const tag of EXPECTED_TAGS) {
      assert.ok(tag in STATE_COLORS, `缺少状态键: ${tag}`);
    }
  });

  it('不包含多余的状态键', () => {
    const keys = Object.keys(STATE_COLORS);
    assert.equal(keys.length, EXPECTED_TAGS.length);
    for (const key of keys) {
      assert.ok(
        (EXPECTED_TAGS as readonly string[]).includes(key),
        `多余的状态键: ${key}`,
      );
    }
  });

  it('所有颜色值为非空字符串', () => {
    for (const [key, color] of Object.entries(STATE_COLORS)) {
      assert.ok(typeof color === 'string' && color.length > 0, `${key} 的颜色为空`);
    }
  });

  it('所有颜色值为合法十六进制色码', () => {
    for (const [key, color] of Object.entries(STATE_COLORS)) {
      assert.match(color, /^#[0-9a-fA-F]{6}$/, `${key} 的颜色格式非法: ${color}`);
    }
  });

  // ─── 语义色验证 ──────────────────────────────────────────────
  describe('语义色正确性', () => {
    it('connected 为绿色', () => {
      assert.equal(STATE_COLORS['connected'], '#22c55e');
    });

    it('connecting 为蓝色', () => {
      assert.equal(STATE_COLORS['connecting'], '#3b82f6');
    });

    it('idle 为灰色', () => {
      assert.equal(STATE_COLORS['idle'], '#9ca3af');
    });

    it('disconnected 为灰色', () => {
      assert.equal(STATE_COLORS['disconnected'], '#9ca3af');
    });

    it('reconnect-exhausted 为红色', () => {
      assert.equal(STATE_COLORS['reconnect-exhausted'], '#ef4444');
    });
  });
});

describe('STATE_LABEL_KEYS', () => {
  it('包含所有预期状态键', () => {
    for (const tag of EXPECTED_TAGS) {
      assert.ok(tag in STATE_LABEL_KEYS, `缺少状态键: ${tag}`);
    }
  });

  it('不包含多余的状态键', () => {
    const keys = Object.keys(STATE_LABEL_KEYS);
    assert.equal(keys.length, EXPECTED_TAGS.length);
    for (const key of keys) {
      assert.ok(
        (EXPECTED_TAGS as readonly string[]).includes(key),
        `多余的状态键: ${key}`,
      );
    }
  });

  it('所有 locale 键为非空字符串', () => {
    for (const [key, labelKey] of Object.entries(STATE_LABEL_KEYS)) {
      assert.ok(typeof labelKey === 'string' && labelKey.length > 0, `${key} 的 locale 键为空`);
    }
  });

  it('locale 键以 state 开头', () => {
    for (const [key, labelKey] of Object.entries(STATE_LABEL_KEYS)) {
      assert.ok(labelKey.startsWith('state'), `${key} 的 locale 键不以 state 开头: ${labelKey}`);
    }
  });
});

describe('STATE_COLORS 与 STATE_LABEL_KEYS 一致性', () => {
  it('两个对象的键集合完全相同', () => {
    const colorKeys = Object.keys(STATE_COLORS).sort();
    const labelKeys = Object.keys(STATE_LABEL_KEYS).sort();
    assert.deepEqual(colorKeys, labelKeys);
  });
});

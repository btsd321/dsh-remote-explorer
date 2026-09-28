/**
 * @file util/format.ts 单元测试
 * @description 覆盖 formatBytes() 的各范围输出格式。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatBytes } from '../../src/util/format.js';

describe('formatBytes', () => {
  // ─── 零值 ───────────────────────────────────────────────────
  describe('零值', () => {
    it('0 字节显示为 0 MB', () => {
      assert.equal(formatBytes(0), '0 MB');
    });
  });

  // ─── MB 以下范围 ────────────────────────────────────────────
  describe('MB 以下范围', () => {
    it('500,000 字节（<1MB）显示为 1 MB（四舍五入）', () => {
      assert.equal(formatBytes(500_000), '1 MB');
    });

    it('999,999 字节显示为 1 MB', () => {
      assert.equal(formatBytes(999_999), '1 MB');
    });

    it('1,000,000 字节恰好 1 MB', () => {
      assert.equal(formatBytes(1_000_000), '1 MB');
    });
  });

  // ─── MB 范围 ────────────────────────────────────────────────
  describe('MB 范围', () => {
    it('10 MB', () => {
      assert.equal(formatBytes(10_000_000), '10 MB');
    });

    it('512 MB', () => {
      assert.equal(formatBytes(512_000_000), '512 MB');
    });

    it('999 MB（不到 1 GB）', () => {
      assert.equal(formatBytes(999_000_000), '999 MB');
    });
  });

  // ─── GB 范围 ────────────────────────────────────────────────
  describe('GB 范围', () => {
    it('恰好 1 GB', () => {
      assert.equal(formatBytes(1_000_000_000), '1.0 GB');
    });

    it('1.4 GB', () => {
      assert.equal(formatBytes(1_400_000_000), '1.4 GB');
    });

    it('10 GB', () => {
      assert.equal(formatBytes(10_000_000_000), '10.0 GB');
    });

    it('超大值 100 GB', () => {
      assert.equal(formatBytes(100_000_000_000), '100.0 GB');
    });
  });

  // ─── 边界与精度 ─────────────────────────────────────────────
  describe('边界与精度', () => {
    it('GB 范围保留一位小数', () => {
      const result = formatBytes(1_567_890_123);
      assert.match(result, /^\d+\.\d GB$/);
    });

    it('MB 范围为整数', () => {
      const result = formatBytes(42_000_000);
      assert.match(result, /^\d+ MB$/);
    });

    it('刚好在 GB 阈值上', () => {
      // 999_999_999 < 1_000_000_000 → MB 范围
      assert.equal(formatBytes(999_999_999), '1000 MB');
    });
  });
});

/**
 * @file credential/token.ts 单元测试
 * @description 覆盖 generateProxyToken() 的格式与随机性，
 *              以及 tokenEquals() 的时序安全比较行为。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateProxyToken, tokenEquals } from '../../src/credential/token.js';

describe('generateProxyToken', () => {
  it('生成的令牌长度为 43 字符', () => {
    const token = generateProxyToken();
    assert.equal(token.length, 43);
  });

  it('令牌仅含 base64url 合法字符', () => {
    const token = generateProxyToken();
    assert.match(token, /^[A-Za-z0-9_-]+$/);
  });

  it('连续生成多个令牌互不相同（随机性）', () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 20; i++) {
      tokens.add(generateProxyToken());
    }
    assert.equal(tokens.size, 20);
  });

  it('令牌不含标准 base64 的 + 和 / 字符', () => {
    // base64url 用 - 和 _ 替代 + 和 /
    for (let i = 0; i < 10; i++) {
      const token = generateProxyToken();
      assert.ok(!token.includes('+'));
      assert.ok(!token.includes('/'));
    }
  });

  it('令牌不含填充符 =', () => {
    // 32 字节 → base64url 43 字符无填充（32 mod 3 ≠ 0 但 Node 的 base64url 不加 padding）
    for (let i = 0; i < 10; i++) {
      const token = generateProxyToken();
      assert.ok(!token.includes('='));
    }
  });
});

describe('tokenEquals', () => {
  // ─── 相等场景 ───────────────────────────────────────────────
  describe('相等判定', () => {
    it('相同字符串返回 true', () => {
      assert.equal(tokenEquals('abc123', 'abc123'), true);
    });

    it('空字符串与空字符串相等', () => {
      assert.equal(tokenEquals('', ''), true);
    });

    it('实际生成的令牌与自身相等', () => {
      const token = generateProxyToken();
      assert.equal(tokenEquals(token, token), true);
    });

    it('长字符串相等', () => {
      const s = 'a'.repeat(1000);
      assert.equal(tokenEquals(s, s), true);
    });
  });

  // ─── 不等场景 ───────────────────────────────────────────────
  describe('不等判定', () => {
    it('不同字符串返回 false', () => {
      assert.equal(tokenEquals('abc', 'def'), false);
    });

    it('大小写敏感', () => {
      assert.equal(tokenEquals('ABC', 'abc'), false);
    });

    it('长度相同但内容不同返回 false', () => {
      assert.equal(tokenEquals('aaaa', 'aaab'), false);
    });

    it('不同长度的字符串返回 false', () => {
      assert.equal(tokenEquals('short', 'longer-string'), false);
    });

    it('空字符串与非空字符串不等', () => {
      assert.equal(tokenEquals('', 'notempty'), false);
      assert.equal(tokenEquals('notempty', ''), false);
    });

    it('两个不同的生成令牌不相等', () => {
      const a = generateProxyToken();
      const b = generateProxyToken();
      assert.equal(tokenEquals(a, b), false);
    });
  });

  // ─── 边界情况 ───────────────────────────────────────────────
  describe('边界情况', () => {
    it('单字符比较', () => {
      assert.equal(tokenEquals('a', 'a'), true);
      assert.equal(tokenEquals('a', 'b'), false);
    });

    it('含特殊字符的字符串', () => {
      assert.equal(tokenEquals('a-b_c', 'a-b_c'), true);
      assert.equal(tokenEquals('a-b_c', 'a+b/c'), false);
    });

    it('Unicode 字符串', () => {
      assert.equal(tokenEquals('你好', '你好'), true);
      assert.equal(tokenEquals('你好', '世界'), false);
    });
  });
});

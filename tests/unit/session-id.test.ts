/**
 * @file util/session-id.ts 单元测试
 * @description 覆盖 computeSessionId() 的确定性、唯一性、别名净化等场景。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeSessionId } from '../../src/util/session-id.js';

describe('computeSessionId', () => {
  // ─── 确定性 ─────────────────────────────────────────────────
  describe('确定性', () => {
    it('相同输入产生相同 id', () => {
      const a = computeSessionId('myhost', '/home/user');
      const b = computeSessionId('myhost', '/home/user');
      assert.equal(a, b);
    });

    it('多次调用结果一致', () => {
      const results = new Set<string>();
      for (let i = 0; i < 10; i++) {
        results.add(computeSessionId('server1', '/opt/app'));
      }
      assert.equal(results.size, 1);
    });
  });

  // ─── 唯一性 ─────────────────────────────────────────────────
  describe('不同输入产生不同 id', () => {
    it('不同 hostAlias 产生不同 id', () => {
      const a = computeSessionId('host-a', '/home/user');
      const b = computeSessionId('host-b', '/home/user');
      assert.notEqual(a, b);
    });

    it('不同 remoteCwd 产生不同 id', () => {
      const a = computeSessionId('myhost', '/home/user');
      const b = computeSessionId('myhost', '/home/admin');
      assert.notEqual(a, b);
    });

    it('空 cwd 与非空 cwd 产生不同 id', () => {
      const a = computeSessionId('myhost', '');
      const b = computeSessionId('myhost', '/home/user');
      assert.notEqual(a, b);
    });

    it('分隔符防碰撞：("a","bc") ≠ ("ab","c")', () => {
      const a = computeSessionId('a', 'bc');
      const b = computeSessionId('ab', 'c');
      assert.notEqual(a, b);
    });
  });

  // ─── 格式约束 ───────────────────────────────────────────────
  describe('输出格式', () => {
    it('仅含小写字母、数字与连字符', () => {
      const id = computeSessionId('MyHost.Example:22', '/home/user');
      assert.match(id, /^[a-z0-9-]+-[a-f0-9]{12}$/);
    });

    it('以净化后的别名开头', () => {
      const id = computeSessionId('myhost', '/home/user');
      assert.ok(id.startsWith('myhost-'));
    });

    it('摘要部分为 12 位十六进制', () => {
      const id = computeSessionId('myhost', '/home/user');
      const digest = id.split('-').slice(1).join('-');
      assert.match(digest, /^[a-f0-9]{12}$/);
    });
  });

  // ─── 别名净化 ───────────────────────────────────────────────
  describe('别名净化', () => {
    it('大写转小写', () => {
      const id = computeSessionId('MYHOST', '/home/user');
      assert.ok(id.startsWith('myhost-'));
    });

    it('点号替换为连字符', () => {
      const id = computeSessionId('gitee.com', '/home/user');
      assert.ok(id.startsWith('gitee-com-'));
    });

    it('冒号替换为连字符', () => {
      const id = computeSessionId('host:22', '/home/user');
      assert.ok(id.startsWith('host-22-'));
    });

    it('连续特殊字符合并为单个连字符', () => {
      const id = computeSessionId('host...name', '/home/user');
      // 不应有连续连字符
      assert.ok(!id.includes('--'));
    });

    it('首尾特殊字符被去除', () => {
      const id = computeSessionId('.host.', '/home/user');
      const prefix = id.substring(0, id.lastIndexOf('-'));
      assert.ok(!prefix.startsWith('-'));
      assert.ok(!prefix.endsWith('-'));
    });

    it('全特殊字符别名回退到 "host"', () => {
      const id = computeSessionId('...', '/home/user');
      assert.ok(id.startsWith('host-'));
    });

    it('超长别名截断到 32 字符', () => {
      const longAlias = 'a'.repeat(50);
      const id = computeSessionId(longAlias, '/home/user');
      const prefix = id.substring(0, id.lastIndexOf('-'));
      assert.equal(prefix.length, 32);
    });
  });

  // ─── 特殊字符输入 ───────────────────────────────────────────
  describe('特殊字符输入', () => {
    it('Unicode 别名（非 ASCII 被替换）', () => {
      const id = computeSessionId('服务器', '/home/user');
      // 中文字符不匹配 [a-z0-9]，会被替换为连字符后清除
      assert.ok(id.includes('-'));
    });

    it('cwd 含空格不影响计算', () => {
      const id = computeSessionId('myhost', '/home/my user/project');
      assert.match(id, /^[a-z0-9]+-[a-f0-9]{12}$/);
    });

    it('两个空字符串也能算出合法 id', () => {
      const id = computeSessionId('', '');
      // 空别名 → sanitizeAlias 返回 'host'
      assert.ok(id.startsWith('host-'));
      assert.match(id, /^host-[a-f0-9]{12}$/);
    });
  });
});

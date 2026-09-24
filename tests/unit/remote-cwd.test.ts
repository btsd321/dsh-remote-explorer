/**
 * @file util/remote-cwd.ts 单元测试
 * @description 覆盖 validateRemoteCwd() 与 normalizeRemoteCwd() 的
 *              MSYS 路径改写防护、POSIX 路径校验、归一化等场景。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateRemoteCwd, normalizeRemoteCwd } from '../../src/util/remote-cwd.js';

describe('validateRemoteCwd', () => {
  // ─── 合法路径 ───────────────────────────────────────────────
  describe('合法路径返回 undefined', () => {
    it('空字符串表示未指定，返回 undefined', () => {
      assert.equal(validateRemoteCwd(''), undefined);
    });

    it('根路径 /', () => {
      assert.equal(validateRemoteCwd('/'), undefined);
    });

    it('正常 POSIX 绝对路径', () => {
      assert.equal(validateRemoteCwd('/home/user'), undefined);
    });

    it('多层嵌套路径', () => {
      assert.equal(validateRemoteCwd('/home/user/projects/my-app'), undefined);
    });

    it('含空格的路径', () => {
      assert.equal(validateRemoteCwd('/home/my user/my project'), undefined);
    });

    it('含点号的路径（隐藏目录）', () => {
      assert.equal(validateRemoteCwd('/home/user/.config/dsh'), undefined);
    });

    it('双斜杠开头的路径（MSYS 推荐写法）', () => {
      assert.equal(validateRemoteCwd('//home/user'), undefined);
    });

    it('含连字符和数字的路径', () => {
      assert.equal(validateRemoteCwd('/opt/node-v20/bin'), undefined);
    });
  });

  // ─── MSYS 改写检测 ──────────────────────────────────────────
  describe('MSYS 改写路径检测', () => {
    it('检测到 D: 盘前缀', () => {
      const result = validateRemoteCwd('D:/SoftWare/Git/home/user');
      assert.notEqual(result, undefined);
      assert.ok(result!.includes('Windows 路径'));
      assert.ok(result!.includes('MSYS'));
    });

    it('检测到 C: 盘前缀', () => {
      const result = validateRemoteCwd('C:/Users/test/project');
      assert.notEqual(result, undefined);
      assert.ok(result!.includes('Windows 路径'));
    });

    it('检测到小写盘符', () => {
      const result = validateRemoteCwd('d:/projects/app');
      assert.notEqual(result, undefined);
      assert.ok(result!.includes('Windows 路径'));
    });

    it('错误消息包含绕过方式提示', () => {
      const result = validateRemoteCwd('D:/Git/home/x');
      assert.ok(result!.includes('MSYS_NO_PATHCONV'));
      assert.ok(result!.includes('//'));
    });
  });

  // ─── 反斜杠检测 ─────────────────────────────────────────────
  describe('反斜杠路径检测', () => {
    it('含反斜杠的路径被拒绝', () => {
      const result = validateRemoteCwd('/home\\user');
      assert.notEqual(result, undefined);
      assert.ok(result!.includes('反斜杠'));
    });

    it('纯 Windows 风格路径被拒绝', () => {
      const result = validateRemoteCwd('\\home\\user');
      assert.notEqual(result, undefined);
      assert.ok(result!.includes('反斜杠'));
    });
  });

  // ─── 相对路径检测 ───────────────────────────────────────────
  describe('非绝对路径检测', () => {
    it('相对路径被拒绝', () => {
      const result = validateRemoteCwd('home/user');
      assert.notEqual(result, undefined);
      assert.ok(result!.includes('绝对路径'));
    });

    it('带点的相对路径被拒绝', () => {
      const result = validateRemoteCwd('./config');
      assert.notEqual(result, undefined);
      assert.ok(result!.includes('绝对路径'));
    });

    it('上级相对路径被拒绝', () => {
      const result = validateRemoteCwd('../parent');
      assert.notEqual(result, undefined);
      assert.ok(result!.includes('绝对路径'));
    });
  });
});

describe('normalizeRemoteCwd', () => {
  it('双斜杠开头折叠为单斜杠', () => {
    assert.equal(normalizeRemoteCwd('//home/user'), '/home/user');
  });

  it('单斜杠开头保持不变', () => {
    assert.equal(normalizeRemoteCwd('/home/user'), '/home/user');
  });

  it('根路径 / 保持不变', () => {
    assert.equal(normalizeRemoteCwd('/'), '/');
  });

  it('空字符串保持不变', () => {
    assert.equal(normalizeRemoteCwd(''), '');
  });

  it('三斜杠开头只去掉一个', () => {
    assert.equal(normalizeRemoteCwd('///home/user'), '//home/user');
  });

  it('确保两种写法归一化结果一致', () => {
    assert.equal(
      normalizeRemoteCwd('//home/user'),
      normalizeRemoteCwd('/home/user'),
    );
  });
});

/**
 * @file provision/pnpm-installer.ts 单元测试
 * @description 覆盖版本探针的纯函数侧（三重陷阱的替代方案，见模块文件头）：
 *              pnpmMajorAccepted 的主版本边界与垃圾输入拒绝、
 *              parsePnpmPackageJson 对落盘 package.json 的解析容错
 *              （损坏 JSON / 缺字段 / 非法字段按「未装」处理）。
 *
 * 不覆盖 ensurePnpm 的远端交互（exec/cat/install）——那是 doctor 与
 * provision 命令的实跑范畴（CLAUDE.md：改动引导逻辑后必须真实验证）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACCEPTED_PNPM_MAJORS, DEFAULT_PNPM_VERSION,
  parsePnpmPackageJson, pnpmMajorAccepted,
} from '../../src/provision/pnpm-installer.js';

// ─── pnpmMajorAccepted ───────────────────────────────────────────────────

describe('pnpmMajorAccepted', () => {
  describe('兼容主版本（复用窗口）', () => {
    it('10.33.0 接受（历史 pin 10 安装复用）', () => {
      assert.equal(pnpmMajorAccepted('10.33.0'), true);
    });

    it('11.7.0 接受（当前 pin 版）', () => {
      assert.equal(pnpmMajorAccepted('11.7.0'), true);
    });

    it('12.0.0 接受（兼容窗口预留）', () => {
      assert.equal(pnpmMajorAccepted('12.0.0'), true);
    });

    it('预发布后缀按主版本判（11.7.0-beta.1 接受）', () => {
      assert.equal(pnpmMajorAccepted('11.7.0-beta.1'), true);
    });

    it('带首尾空白先 trim（cat 读回形态）', () => {
      assert.equal(pnpmMajorAccepted(' 10.33.0\n'), true);
    });
  });

  describe('窗口外主版本', () => {
    it('9.15.9 拒绝（低于窗口下沿）', () => {
      assert.equal(pnpmMajorAccepted('9.15.9'), false);
    });

    it('13.0.0 拒绝（高于窗口上沿）', () => {
      assert.equal(pnpmMajorAccepted('13.0.0'), false);
    });
  });

  describe('垃圾输入（一律按不满足处理）', () => {
    it('空串拒绝', () => {
      assert.equal(pnpmMajorAccepted(''), false);
    });

    it('非版本文本拒绝', () => {
      assert.equal(pnpmMajorAccepted('not-a-version'), false);
      assert.equal(pnpmMajorAccepted('pnpm'), false);
    });

    it('缺 minor/patch 段拒绝（10、10.33 都不是可判读版本）', () => {
      assert.equal(pnpmMajorAccepted('10'), false);
      assert.equal(pnpmMajorAccepted('10.33'), false);
    });

    it('带 v 前缀拒绝（package.json 的 version 字段不会出现）', () => {
      assert.equal(pnpmMajorAccepted('v10.33.0'), false);
    });

    it('带尾部垃圾拒绝（半截写入的文件读回形态）', () => {
      assert.equal(pnpmMajorAccepted('10.33.0; rm -rf /'), false);
      assert.equal(pnpmMajorAccepted('10.33.0 extra'), false);
    });
  });

  describe('常量一致性', () => {
    it('兼容窗口与 pin 版一致：pin 的主版本在窗口内', () => {
      const pinMajor = Number(DEFAULT_PNPM_VERSION.split('.')[0]);
      assert.equal((ACCEPTED_PNPM_MAJORS as readonly number[]).includes(pinMajor), true);
    });
  });
});

// ─── parsePnpmPackageJson ────────────────────────────────────────────────

describe('parsePnpmPackageJson', () => {
  it('合法 JSON 提取 version 字段', () => {
    const text = JSON.stringify({ name: 'pnpm', version: '10.33.0', private: true });
    assert.equal(parsePnpmPackageJson(text), '10.33.0');
  });

  it('cat 读回的带尾随换行文本可解析', () => {
    const text = `${JSON.stringify({ version: DEFAULT_PNPM_VERSION })}\n`;
    assert.equal(parsePnpmPackageJson(text), DEFAULT_PNPM_VERSION);
  });

  it('损坏 JSON 返回 undefined（按未装/损坏处理，触发重装）', () => {
    assert.equal(parsePnpmPackageJson('{ "version": '), undefined);
    assert.equal(parsePnpmPackageJson('not json at all'), undefined);
    assert.equal(parsePnpmPackageJson(''), undefined);
  });

  it('缺 version 字段返回 undefined', () => {
    assert.equal(parsePnpmPackageJson(JSON.stringify({ name: 'pnpm' })), undefined);
  });

  it('version 非字符串返回 undefined', () => {
    assert.equal(parsePnpmPackageJson(JSON.stringify({ version: 10 })), undefined);
    assert.equal(parsePnpmPackageJson(JSON.stringify({ version: null })), undefined);
    assert.equal(parsePnpmPackageJson(JSON.stringify({ version: true })), undefined);
  });

  it('version 空串返回 undefined（等同缺字段）', () => {
    assert.equal(parsePnpmPackageJson(JSON.stringify({ version: '' })), undefined);
  });
});

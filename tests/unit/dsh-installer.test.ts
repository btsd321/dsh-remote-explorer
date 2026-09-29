/**
 * @file provision/dsh-installer.ts 单元测试
 * @description 覆盖默认版本策略的纯函数侧（见模块文件头第 1 点的新策略）：
 *              maxPublishedVersion 的 semver 完整优先级比较——数值段、
 *              prerelease 有无、点分标识符的数值/字典序/长短规则，以及
 *              非法条目忽略与空输入语义。registry 快照用例锚定 dist-tag
 *              latest 滞后实测（lessons 6c）。
 *
 * 不覆盖 resolveLatestDshVersion / resolveDshVersion 的远端交互
 * （npm view + JSON 解析）——那是 provision 命令的实跑范畴
 * （CLAUDE.md：改动引导逻辑后必须真实验证）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { maxPublishedVersion } from '../../src/provision/dsh-installer.js';

// ─── maxPublishedVersion ─────────────────────────────────────────────────

describe('maxPublishedVersion', () => {
  describe('major/minor/patch 数值比较', () => {
    it('minor 段数值大者胜（0.2.0-rc.1 > 0.1.7-rc.2）', () => {
      assert.equal(maxPublishedVersion(['0.1.7-rc.2', '0.2.0-rc.1']), '0.2.0-rc.1');
    });

    it('major 段数值大者胜（1.0.0 > 0.9.9）', () => {
      assert.equal(maxPublishedVersion(['0.9.9', '1.0.0']), '1.0.0');
    });

    it('patch 段数值大者胜（0.2.1 > 0.2.0）', () => {
      assert.equal(maxPublishedVersion(['0.2.0', '0.2.1']), '0.2.1');
    });
  });

  describe('prerelease 优先级', () => {
    it('无 prerelease 大于同名有 prerelease（0.2.0 > 0.2.0-rc.2）', () => {
      assert.equal(maxPublishedVersion(['0.2.0-rc.2', '0.2.0']), '0.2.0');
    });

    it('同前缀 prerelease 逐段比较（0.2.0-rc.2 > 0.2.0-rc.1）', () => {
      assert.equal(maxPublishedVersion(['0.2.0-rc.1', '0.2.0-rc.2']), '0.2.0-rc.2');
    });

    it('纯数字标识符按数值而非字典序（0.2.0-rc.10 > 0.2.0-rc.2）', () => {
      assert.equal(maxPublishedVersion(['0.2.0-rc.2', '0.2.0-rc.10']), '0.2.0-rc.10');
    });

    it('纯数字标识符小于非数字标识符（1.0.0-1 < 1.0.0-alpha）', () => {
      assert.equal(maxPublishedVersion(['1.0.0-1', '1.0.0-alpha']), '1.0.0-alpha');
    });
  });

  describe('semver 规范用例（规范第 11 条升序链）', () => {
    it('1.0.0-alpha < 1.0.0-alpha.1 < 1.0.0-alpha.beta < 1.0.0-beta < 1.0.0', () => {
      const chain = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0'];
      // 每个前缀子链的最大值都应是链上最后一位
      for (let i = 1; i < chain.length; i++) {
        assert.equal(maxPublishedVersion(chain.slice(0, i + 1)), chain[i]);
      }
      // 与输入顺序无关
      assert.equal(maxPublishedVersion([...chain].reverse()), '1.0.0');
    });
  });

  describe('垃圾条目忽略', () => {
    it('非法条目不参与比较也不报错（列表混入脏数据）', () => {
      assert.equal(
        maxPublishedVersion(['garbage', '0.1.7-rc.2', '', 'v0.2.0', '0.2.0-rc.2', '1.02.0']),
        '0.2.0-rc.2',
      );
    });

    it('全部非法时返回 undefined（标签、缺段、前导零都不可判读）', () => {
      assert.equal(maxPublishedVersion(['not-a-version', 'latest', '0.1']), undefined);
    });
  });

  describe('空输入', () => {
    it('空数组返回 undefined', () => {
      assert.equal(maxPublishedVersion([]), undefined);
    });
  });

  describe('registry 快照（dist-tag latest 滞后实测）', () => {
    it("['0.1.7-rc.2', '0.2.0-rc.1', '0.2.0-rc.2'] → '0.2.0-rc.2'", () => {
      // latest 停在 0.1.7-rc.2 时已发布最大值已是 0.2.0-rc.2——默认
      // 策略取版本列表最大值而非任何标签的实证锚点
      assert.equal(
        maxPublishedVersion(['0.1.7-rc.2', '0.2.0-rc.1', '0.2.0-rc.2']),
        '0.2.0-rc.2',
      );
    });
  });
});

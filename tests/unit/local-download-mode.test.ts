/**
 * @file provision/local-download-mode.ts 单元测试
 * @description 覆盖 isValidLocalResourceDownloadMode 的类型守卫行为——合法三值
 *              通过、非法值与边界类型拒绝。纯函数无 IO，直接断言返回值。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidLocalResourceDownloadMode,
  LOCAL_RESOURCE_DOWNLOAD_MODES,
  DEFAULT_LOCAL_RESOURCE_DOWNLOAD,
} from '../../src/provision/local-download-mode.js';

describe('LocalResourceDownloadMode', () => {
  describe('DEFAULT_LOCAL_RESOURCE_DOWNLOAD', () => {
    it('默认值为 auto', () => {
      assert.equal(DEFAULT_LOCAL_RESOURCE_DOWNLOAD, 'auto');
    });
  });

  describe('LOCAL_RESOURCE_DOWNLOAD_MODES', () => {
    it('包含且仅包含 auto/always/off', () => {
      assert.deepEqual([...LOCAL_RESOURCE_DOWNLOAD_MODES], ['auto', 'always', 'off']);
    });
  });

  describe('isValidLocalResourceDownloadMode', () => {
    it('auto/always/off 合法', () => {
      assert.ok(isValidLocalResourceDownloadMode('auto'));
      assert.ok(isValidLocalResourceDownloadMode('always'));
      assert.ok(isValidLocalResourceDownloadMode('off'));
    });

    it('非法字符串拒绝', () => {
      assert.ok(!isValidLocalResourceDownloadMode('Auto'));
      assert.ok(!isValidLocalResourceDownloadMode('AUTO'));
      assert.ok(!isValidLocalResourceDownloadMode('on'));
      assert.ok(!isValidLocalResourceDownloadMode(''));
      assert.ok(!isValidLocalResourceDownloadMode('invalid'));
    });

    it('非字符串拒绝', () => {
      assert.ok(!isValidLocalResourceDownloadMode(undefined));
      assert.ok(!isValidLocalResourceDownloadMode(null));
      assert.ok(!isValidLocalResourceDownloadMode(123));
      assert.ok(!isValidLocalResourceDownloadMode(true));
      assert.ok(!isValidLocalResourceDownloadMode(['auto']));
      assert.ok(!isValidLocalResourceDownloadMode({ mode: 'auto' }));
    });
  });
});

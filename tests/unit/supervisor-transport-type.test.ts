/**
 * @file plugin/supervisor.ts 的 transportTypeOfHostAlias 单元测试
 * @description 会话表外部视图的传输类型还原：WslTransport 的 hostAlias 约定为
 *              `wsl:<发行版名>` 前缀，其余形态（SSH 别名 / user@host 直连）
 *              一律 ssh。此前 list() 外部视图硬编码 'ssh'，WSL 会话在面板上
 *              被错误呈现为 SSH 会话。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { transportTypeOfHostAlias } from '../../src/plugin/supervisor.js';

describe('transportTypeOfHostAlias', () => {
  describe('wsl 前缀', () => {
    it('wsl:<发行版名> 识别为 wsl', () => {
      assert.equal(transportTypeOfHostAlias('wsl:Ubuntu-22.04'), 'wsl');
    });

    it('发行版名含点与连字符仍识别', () => {
      assert.equal(transportTypeOfHostAlias('wsl:Debian.GNU-Linux'), 'wsl');
    });

    it('仅前缀本身也识别（防御性形态）', () => {
      assert.equal(transportTypeOfHostAlias('wsl:'), 'wsl');
    });
  });

  describe('ssh 形态', () => {
    it('ssh config 别名识别为 ssh', () => {
      assert.equal(transportTypeOfHostAlias('myhost'), 'ssh');
    });

    it('user@host 直连识别为 ssh', () => {
      assert.equal(transportTypeOfHostAlias('youruser@myhost'), 'ssh');
    });

    it('user@host:port 直连识别为 ssh', () => {
      assert.equal(transportTypeOfHostAlias('youruser@myhost:2222'), 'ssh');
    });

    it('含 wsl 子串但非前缀不误判', () => {
      assert.equal(transportTypeOfHostAlias('mywslhost'), 'ssh');
      assert.equal(transportTypeOfHostAlias('wslhost:22'), 'ssh');
    });
  });
});

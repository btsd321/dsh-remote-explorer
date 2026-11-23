/**
 * @file plugin-client/link-policy.ts 单元测试
 * @description 覆盖外开判据：同 origin 留浮层、跨 origin 外开、非 http(s) 与非法的处理。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isSameSessionOrigin, shouldOpenExternally } from '../../src/plugin-client/link-policy.js';

/** 远端会话地址：浮层 loadURL 用的本地转发地址（带令牌） */
const SESSION = 'http://127.0.0.1:18950/?token=abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';

describe('shouldOpenExternally', () => {
  describe('同 origin 留在浮层', () => {
    it('同 host + 同端口的绝对地址不外开', () => {
      assert.equal(shouldOpenExternally('http://127.0.0.1:18950/settings', SESSION), false);
    });

    it('带查询串和 hash 的同 origin 地址不外开', () => {
      assert.equal(
        shouldOpenExternally('http://127.0.0.1:18950/?token=x#/session/abc', SESSION),
        false,
      );
    });

    it('会话地址自身的完整 URL 不外开', () => {
      assert.equal(shouldOpenExternally(SESSION, SESSION), false);
    });
  });

  describe('跨 origin 外开', () => {
    it('不同主机的 https 地址外开', () => {
      assert.equal(shouldOpenExternally('https://github.com/foo/bar', SESSION), true);
    });

    it('同主机不同端口视为跨 origin', () => {
      assert.equal(shouldOpenExternally('http://127.0.0.1:18951/', SESSION), true);
    });

    it('同主机协议不同视为跨 origin', () => {
      assert.equal(shouldOpenExternally('https://127.0.0.1:18950/', SESSION), true);
    });

    it('localhost 与 127.0.0.1 视为不同 origin', () => {
      assert.equal(shouldOpenExternally('http://localhost:18950/', SESSION), true);
    });
  });

  describe('非 http(s) 与非法输入不外开', () => {
    it('mailto: 不外开', () => {
      assert.equal(shouldOpenExternally('mailto:someone@example.com', SESSION), false);
    });

    it('blob: 不外开', () => {
      assert.equal(shouldOpenExternally('blob:http://127.0.0.1:18950/uuid', SESSION), false);
    });

    it('dsh-resource: 不外开', () => {
      assert.equal(shouldOpenExternally('dsh-resource://file/session/abc/a.txt', SESSION), false);
    });

    it('非法 URL 不外开', () => {
      assert.equal(shouldOpenExternally('not a url', SESSION), false);
    });

    it('会话地址非法时一律不外开', () => {
      assert.equal(shouldOpenExternally('https://github.com/', 'also not a url'), false);
    });
  });
});

describe('isSameSessionOrigin', () => {
  it('同 origin 的 http(s) 地址返回 true', () => {
    assert.equal(isSameSessionOrigin('http://127.0.0.1:18950/chat/1', SESSION), true);
    assert.equal(isSameSessionOrigin(SESSION, SESSION), true);
  });

  it('跨 origin 地址返回 false', () => {
    assert.equal(isSameSessionOrigin('https://www.v2ex.com/', SESSION), false);
    assert.equal(isSameSessionOrigin('http://127.0.0.1:18951/', SESSION), false);
  });

  it('about:blank#<lease> 与非 http(s) 或非法地址返回 false', () => {
    assert.equal(isSameSessionOrigin('about:blank#lease-123', SESSION), false);
    assert.equal(isSameSessionOrigin('blob:http://127.0.0.1:18950/uuid', SESSION), false);
    assert.equal(isSameSessionOrigin('not a url', SESSION), false);
    assert.equal(isSameSessionOrigin('http://127.0.0.1:18950/', 'invalid'), false);
  });
});

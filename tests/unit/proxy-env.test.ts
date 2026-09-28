/**
 * @file session/proxy-env.ts 单元测试
 * @description 覆盖 collectProxyEnv() 的来源优先级与六个代理键的完整性、
 *              assertSafeEnvKeys() 的命令注入防线（非法键名/保留键）与
 *              isSafeEnvKey() 的判定。process.env.DSH_REMOTE_PROXY 在用例间
 *              恢复，防止测试污染真实环境。
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertSafeEnvKeys, collectProxyEnv, isSafeEnvKey, RESERVED_REMOTE_ENV_KEYS,
} from '../../src/session/proxy-env.js';
import { RemoteError } from '../../src/util/errors.js';

/** 测试开始前保存的原始值（结束后恢复） */
const SAVED_PROXY = process.env.DSH_REMOTE_PROXY;

/**
 * 设置本机代理环境变量（undefined 表示删除）。
 *
 * @param value - 要设置的值
 */
function setLocalProxy(value: string | undefined): void {
  if (value === undefined) {
    delete process.env.DSH_REMOTE_PROXY;
  } else {
    process.env.DSH_REMOTE_PROXY = value;
  }
}

after(() => {
  setLocalProxy(SAVED_PROXY);
});

// ─── collectProxyEnv ─────────────────────────────────────────────────────

describe('collectProxyEnv', () => {
  describe('显式传入', () => {
    it('六个代理键齐全且值相同', () => {
      setLocalProxy(undefined);
      const env = collectProxyEnv('http://127.0.0.1:18890');
      // sort() 按 ASCII：大写在前；'S'(0x53) < '_'(0x5F) 故 HTTPS_PROXY 排在 HTTP_PROXY 前
      assert.deepEqual(Object.keys(env).sort(), [
        'ALL_PROXY', 'HTTPS_PROXY', 'HTTP_PROXY', 'all_proxy', 'http_proxy', 'https_proxy',
      ]);
      for (const value of Object.values(env)) {
        assert.equal(value, 'http://127.0.0.1:18890');
      }
    });

    it('显式传入优先于本机环境变量', () => {
      setLocalProxy('http://127.0.0.1:9999');
      const env = collectProxyEnv('http://127.0.0.1:18890');
      assert.equal(env.https_proxy, 'http://127.0.0.1:18890');
    });

    it('显式传入空串 = 显式关闭代理（不回落环境变量）', () => {
      setLocalProxy('http://127.0.0.1:9999');
      assert.deepEqual(collectProxyEnv(''), {});
    });
  });

  describe('本机环境变量兜底', () => {
    it('未传 explicit 时读 DSH_REMOTE_PROXY', () => {
      setLocalProxy('http://127.0.0.1:18890');
      const env = collectProxyEnv();
      assert.equal(env.http_proxy, 'http://127.0.0.1:18890');
      assert.equal(env.HTTP_PROXY, 'http://127.0.0.1:18890');
      assert.equal(env.https_proxy, 'http://127.0.0.1:18890');
      assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:18890');
      assert.equal(env.ALL_PROXY, 'http://127.0.0.1:18890');
      assert.equal(env.all_proxy, 'http://127.0.0.1:18890');
    });

    it('环境变量为空串视为未设置，返回空对象', () => {
      setLocalProxy('');
      assert.deepEqual(collectProxyEnv(), {});
    });
  });

  describe('无代理时的回归语义', () => {
    it('两者皆无返回空对象（有网机器零影响）', () => {
      setLocalProxy(undefined);
      assert.deepEqual(collectProxyEnv(), {});
      assert.deepEqual(collectProxyEnv(undefined), {});
    });
  });
});

// ─── assertSafeEnvKeys ───────────────────────────────────────────────────

describe('assertSafeEnvKeys', () => {
  it('合法键组不抛错', () => {
    assert.doesNotThrow(() => {
      assertSafeEnvKeys({ https_proxy: 'http://127.0.0.1:18890', MY_VAR: 'x' }, '主机 myhost');
    });
  });

  it('空对象不抛错', () => {
    assert.doesNotThrow(() => assertSafeEnvKeys({}, '主机 myhost'));
  });

  describe('非法键名（命令注入面）', () => {
    const illegalKeys = ['BAD KEY', 'A=B', 'X$(cmd)', '1ABC', '', 'A-B'];

    for (const key of illegalKeys) {
      it(`键名 '${key.replaceAll(' ', '␣') || '(空串)'}' 抛 RemoteError 且消息含键名`, () => {
        assert.throws(
          () => assertSafeEnvKeys({ [key]: 'value' }, '主机 myhost'),
          (error: unknown) => {
            assert.ok(error instanceof RemoteError);
            assert.equal(error.code, 'EXEC_FAILED');
            assert.ok(error.message.includes('主机 myhost'));
            assert.ok(error.message.includes(key));
            return true;
          },
        );
      });
    }
  });

  describe('保留键（会话隔离契约）', () => {
    for (const key of RESERVED_REMOTE_ENV_KEYS) {
      it(`键名 '${key}' 抛 RemoteError 且消息含键名与上下文`, () => {
        assert.throws(
          () => assertSafeEnvKeys({ [key]: '/custom' }, '主机 myhost'),
          (error: unknown) => {
            assert.ok(error instanceof RemoteError);
            assert.equal(error.code, 'EXEC_FAILED');
            assert.ok(error.message.includes('主机 myhost'));
            assert.ok(error.message.includes(key));
            return true;
          },
        );
      });
    }
  });

  it('合法键与非法键混合时仍然整体拒绝', () => {
    assert.throws(
      () => assertSafeEnvKeys({ GOOD_KEY: 'x', 'BAD=KEY': 'y' }, '主机 myhost'),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes('BAD=KEY'));
        return true;
      },
    );
  });
});

// ─── isSafeEnvKey 与保留键集合 ───────────────────────────────────────────

describe('isSafeEnvKey', () => {
  it('合法键返回 true', () => {
    assert.equal(isSafeEnvKey('https_proxy'), true);
    assert.equal(isSafeEnvKey('HTTPS_PROXY'), true);
    assert.equal(isSafeEnvKey('_PRIVATE'), true);
  });

  it('非法字符返回 false', () => {
    assert.equal(isSafeEnvKey('BAD KEY'), false);
    assert.equal(isSafeEnvKey('A=B'), false);
    assert.equal(isSafeEnvKey('X$(cmd)'), false);
    assert.equal(isSafeEnvKey('1ABC'), false);
    assert.equal(isSafeEnvKey(''), false);
  });

  it('保留键返回 false', () => {
    for (const key of RESERVED_REMOTE_ENV_KEYS) {
      assert.equal(isSafeEnvKey(key), false);
    }
  });
});

describe('RESERVED_REMOTE_ENV_KEYS', () => {
  it('集合内容与 remote-process 的 envAssignments 契约一致', () => {
    assert.deepEqual([...RESERVED_REMOTE_ENV_KEYS], ['DSH_HOME', 'DSH_AGENTS_HOME', 'PATH']);
  });
});

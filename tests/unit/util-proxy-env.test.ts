/**
 * @file util/proxy-env.ts 单元测试
 * @description 覆盖 buildProxyEnv 的八键展开与 buildCurlProxyArg 的参数片段
 *              生成——两者是 provision/ 与 session/ 共用的同一实现，键清单
 *              与回环排除清单在多个消费方之间必须完全一致。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildProxyEnv, buildCurlProxyArg } from '../../src/util/proxy-env.js';

/** 测试用代理 URL */
const PROXY = 'http://127.0.0.1:47123';

/** buildProxyEnv 应产出的全部键（顺序无关） */
const PROXY_KEYS = [
  'http_proxy', 'HTTP_PROXY',
  'https_proxy', 'HTTPS_PROXY',
  'ALL_PROXY', 'all_proxy',
  'no_proxy', 'NO_PROXY',
];

describe('buildProxyEnv', () => {
  it('undefined 返回空对象（不注入任何变量）', () => {
    assert.deepEqual(buildProxyEnv(undefined), {});
  });

  it('空串返回空对象（空代理 URL 无意义）', () => {
    assert.deepEqual(buildProxyEnv(''), {});
  });

  it('非空代理展开为恰好八个键', () => {
    const env = buildProxyEnv(PROXY);
    assert.deepEqual(Object.keys(env).sort(), [...PROXY_KEYS].sort());
  });

  it('六个代理键同值，两个 no_proxy 排除回环', () => {
    const env = buildProxyEnv(PROXY);
    for (const key of ['http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY', 'ALL_PROXY', 'all_proxy']) {
      assert.equal(env[key], PROXY, `${key} 应等于代理 URL`);
    }
    for (const key of ['no_proxy', 'NO_PROXY']) {
      const value = env[key]!;
      assert.ok(value.includes('127.0.0.1'), `${key} 必须排除回环地址`);
      assert.ok(value.includes('localhost'), `${key} 必须排除 localhost`);
      assert.ok(value.includes('::1'), `${key} 必须排除 IPv6 回环`);
      assert.ok(!value.includes(PROXY), `${key} 不能把代理地址自己写进排除项`);
    }
  });
});

describe('buildCurlProxyArg', () => {
  it('undefined 返回空串（拼接结果与不加代理时逐字节一致）', () => {
    assert.equal(buildCurlProxyArg(undefined), '');
  });

  it('空串返回空串', () => {
    assert.equal(buildCurlProxyArg(''), '');
  });

  it('非空返回带前导空格的 -x 片段', () => {
    const arg = buildCurlProxyArg(PROXY);
    assert.ok(arg.startsWith(' '), '片段必须以空格开头，便于直接拼接');
    assert.equal(arg.trim(), `-x ${PROXY}`);
  });

  it('含 shell 元字符的代理 URL 被转义（命令注入防线）', () => {
    // 单引号法转义后，这段值在 shell 里是单个字面量参数
    const arg = buildCurlProxyArg("http://127.0.0.1:1/'$(id)");
    assert.ok(arg.includes(`'`), '含特殊字符的值必须被引号包裹');
    assert.ok(!arg.includes('$(id) \n'), '不能原样透传未转义内容');
  });
});

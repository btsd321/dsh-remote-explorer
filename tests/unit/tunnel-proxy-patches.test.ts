/**
 * @file credential/tunnel-proxy.ts 的 patch 渲染单元测试
 * @description 钉住账号通道的 patch 契约：本机已登录 DeepSeek 账号时，
 *              `deepseek-account` 条目必须同时写入 platformOrigin /
 *              harnessOrigin / inferenceOrigin（三者同值），否则远端会拿
 *              占位 grant 直连生产 harness，被 40003 判定失效并删除占位登录态。
 *
 * 只构造对象、不监听端口（构造函数只创建 http.Server，不 bind），无网络。
 */

import { describe, it, test } from 'node:test';
import assert from 'node:assert/strict';
import { TunnelProxyCredential } from '../../src/credential/tunnel-proxy.js';
import { deepseekRoute } from '../../src/credential/provider-routes.js';

/**
 * 构造一个不监听端口的代理实例。
 *
 * @param accountToken - 本机账号 grant token；undefined = 未登录
 * @returns 代理实例
 */
function makeProxy(
  accountToken: string | undefined,
  deepseekConfig?: Record<string, unknown>,
): TunnelProxyCredential {
  return new TunnelProxyCredential(
    'placeholder-token',
    40123,
    '127.0.0.1',
    [deepseekRoute()],
    'myhost',
    new Map(),
    undefined,
    accountToken,
    deepseekConfig,
  );
}

describe('TunnelProxyCredential.remotePatches', () => {
  it('已登录账号：deepseek-account 同时 patch 三个 origin（含 harnessOrigin）', () => {
    const patches = makeProxy('real-account-token').remotePatches();
    const account = patches.find(patch => patch.id === 'deepseek-account');
    assert.ok(account, '缺少 deepseek-account patch');
    assert.equal(account.config['platformOrigin'], 'http://127.0.0.1:40123');
    assert.equal(account.config['harnessOrigin'], 'http://127.0.0.1:40123');
    assert.equal(account.config['inferenceOrigin'], 'http://127.0.0.1:40123');
    assert.equal(account.config['allowLoopbackHttp'], true);
  });

  it('未登录账号：不写账号通道 patch（远端不发起账号请求）', () => {
    const ids = makeProxy(undefined).remotePatches().map(patch => patch.id);
    assert.deepEqual(ids, ['llm-deepseek']);
  });

  it('DeepSeek 原生通道 baseURL 指向隧道的 /anthropic', () => {
    const patches = makeProxy('real-account-token').remotePatches();
    const native = patches.find(patch => patch.id === 'llm-deepseek');
    assert.ok(native);
    assert.equal(native.config['baseURL'], 'http://127.0.0.1:40123/anthropic');
  });

  it('DeepSeek 自定义 models 配置随原生通道 patch 带到远端', () => {
    const models = [
      { id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash' },
      { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
    ];
    const patches = makeProxy(undefined, { models, reasoningEffort: 'high' }).remotePatches();
    const native = patches.find(patch => patch.id === 'llm-deepseek');
    assert.ok(native);
    assert.deepEqual(native.config['models'], models);
    assert.equal(native.config['reasoningEffort'], 'high');
    // 自定义 baseURL 仍必须被隧道地址覆盖
    assert.equal(native.config['baseURL'], 'http://127.0.0.1:40123/anthropic');
  });
});

test('远端 patch 只包含安全模型元数据，不透传 headers 或明文凭据', () => {
  const config = { headers: { authorization: 'fake-secret' }, apiKey: 'fake-secret', apiKeyEnv: 'GATEWAY_KEY',
    models: [{ id: 'test-model', name: '测试', headers: { authorization: 'fake-secret' }, apiKey: 'fake-secret' }] };
  const native = makeProxy(undefined, config).remotePatches()[0]!;
  assert.deepEqual(native.config, { models: [{ id: 'test-model', name: '测试' }], baseURL: 'http://127.0.0.1:40123/anthropic' });
});

test('远端 patch 保留 DSH catalogModel 的多模态字段，丢弃非 schema 字段与无效条目', () => {
  const config = {
    reasoningEffort: 'high',
    models: [
      {
        id: 'vision-model', name: '视觉', description: '多模态', contextWindow: 128000, maxTokens: 8192,
        inputModalities: ['text', 'image', 'audio'], imagePixelBudget: 'low', imageMaxBytes: 4_000_000,
        systemPromptUpdate: 'in-history', toolUpdate: 'addition-only',
        // 非 DSH schema 字段（pi-ai 风格）不应下发
        input: ['text'], cost: { input: 1 }, maxOutputTokens: 100,
      },
      'string-entry',
      { name: '缺 id' },
      null,
    ],
  };
  const native = makeProxy(undefined, config).remotePatches()[0]!;
  assert.deepEqual(native.config['models'], [{
    id: 'vision-model', name: '视觉', description: '多模态', contextWindow: 128000, maxTokens: 8192,
    inputModalities: ['text', 'image'], imagePixelBudget: 'low', imageMaxBytes: 4_000_000,
    systemPromptUpdate: 'in-history', toolUpdate: 'addition-only',
  }]);
  assert.equal(native.config['reasoningEffort'], 'high');
});

test('模型条目全部无效时省略 models，非法 reasoningEffort 不下发', () => {
  const native = makeProxy(undefined, { reasoningEffort: 'turbo', models: ['x', { name: 'y' }] }).remotePatches()[0]!;
  assert.deepEqual(native.config, { baseURL: 'http://127.0.0.1:40123/anthropic' });
});

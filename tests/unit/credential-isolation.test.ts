/**
 * @file DeepSeek 凭据隔离回归
 * @description 真实本机 HTTP 入口配合模拟 fetch；绝不向公网发送测试凭据。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { TunnelProxyCredential } from '../../src/credential/tunnel-proxy.js';
import { deepseekRoute, deepseekModelsRoute } from '../../src/credential/provider-routes.js';

/** 经本机 HTTP 入口发请求；上游 fetch 在测试里替换。 */
async function request(proxy: TunnelProxyCredential, path: string, headers: Record<string, string>): Promise<number> {
  const port = (proxy as unknown as { localPort: number }).localPort;
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path, headers }, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode!));
    });
    req.on('error', reject);
  });
}

test('账号令牌只到官方路由，自定义 API key 不回退到官方 key', async t => {
  const calls: { url: string; headers: Headers }[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(init.redirect, 'error');
    calls.push({ url: String(url), headers: new Headers(init.headers) });
    return new Response(null, { status: 204 });
  });
  const proxy = new TunnelProxyCredential('placeholder', 40123, '127.0.0.1',
    [deepseekRoute('https://gateway.example/api/v1', 'PR3_TEST_GATEWAY_KEY'), deepseekModelsRoute('https://gateway.example/api/v1', 'PR3_TEST_GATEWAY_KEY'),
      { prefix: '/r/other', upstreamOrigin: 'https://other.example', upstreamPath: '', keyEnv: 'PR3_TEST_GATEWAY_KEY', label: '其他' }],
    'test', new Map([['PR3_TEST_GATEWAY_KEY', 'fake-gateway-key'], ['DEEPSEEK_API_KEY', 'fake-official-key']]), undefined, 'fake-account-token');
  await proxy.start();
  t.after(() => proxy.stop());
  assert.equal(await request(proxy, '/anthropic/v1/messages', { 'x-dsh-auth-token': 'placeholder' }), 204);
  assert.equal(calls.at(-1)?.url, 'https://api.deepseek.com/anthropic/v1/messages');
  assert.equal(calls.at(-1)?.headers.get('x-dsh-auth-token'), 'fake-account-token');
  assert.equal(await request(proxy, '/models', { 'x-dsh-auth-token': 'placeholder' }), 204);
  assert.equal(calls.at(-1)?.url, 'https://api.deepseek.com/models');
  assert.equal(await request(proxy, '/anthropic/v1/messages', { 'x-api-key': 'placeholder' }), 204);
  assert.equal(calls.at(-1)?.url, 'https://gateway.example/api/v1/messages');
  assert.equal(calls.at(-1)?.headers.get('x-api-key'), 'fake-gateway-key');
  assert.equal(proxy.remoteEnv()['DEEPSEEK_API_KEY'], 'placeholder');
  const before = calls.length;
  assert.equal(await request(proxy, '/r/other/messages', { 'x-dsh-auth-token': 'placeholder' }), 404);
  assert.equal(calls.length, before);
  assert.equal(await request(proxy, '/anthropic/v1/messages', { 'x-api-key': 'placeholder', 'x-dsh-auth-token': 'placeholder' }), 400);
  assert.equal(calls.length, before);
});

test('自定义 key 缺失时不使用官方 key', async t => {
  const calls: RequestInit[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    calls.push(init);
    return new Response(null, { status: 204 });
  });
  const proxy = new TunnelProxyCredential('placeholder', 40123, '127.0.0.1',
    [deepseekRoute('https://gateway.example/v1', 'UNSET_TEST_PR3_TEST_GATEWAY_KEY')],
    'test', new Map([['DEEPSEEK_API_KEY', 'fake-official-key']]));
  await proxy.start();
  t.after(() => proxy.stop());
  assert.equal(await request(proxy, '/anthropic/v1/messages', { 'x-api-key': 'placeholder' }), 502);
  assert.equal(calls.length, 0);
});

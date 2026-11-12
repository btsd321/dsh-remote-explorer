/**
 * @file credential/proxy-route-match.ts 与 deepseek-routes.ts 单元测试
 * @description 覆盖隧道代理的路径换算契约：最长前缀匹配、上游 URL 构造，
 *              以及账号通道（平台 + 通知）路由的 upstreamPath 必须保留前缀。
 *
 * 背景（dsh 0.2.2-rc.2 实测）：上游站点对缺前缀的路径回落到 SPA HTML，
 * 代理原样透传会让 dsh 侧按 JSON 信封解析失败——单元测试把这条约束钉住。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildUpstreamUrl, matchRoute } from '../../src/credential/proxy-route-match.js';
import { deepseekAccountRoutes } from '../../src/credential/deepseek-routes.js';
import { deepseekModelsRoute, deepseekRoute } from '../../src/credential/provider-routes.js';

describe('deepseekAccountRoutes', () => {
  const routes = deepseekAccountRoutes();

  it('上游路径与远端前缀同值（不丢前缀）', () => {
    for (const route of routes) {
      assert.equal(route.upstreamPath, route.prefix, `路由 ${route.prefix} 的 upstreamPath 丢前缀`);
    }
  });

  it('平台资料路径换算出带 /auth-api 前缀的上游 URL', () => {
    const route = matchRoute(routes, '/auth-api/v0/users/current');
    assert.ok(route);
    assert.equal(
      buildUpstreamUrl(route, '/auth-api/v0/users/current', ''),
      'https://platform.deepseek.com/auth-api/v0/users/current',
    );
  });

  it('平台余额路径换算出带 /api/v0 前缀的上游 URL', () => {
    const route = matchRoute(routes, '/api/v0/users/get_user_summary');
    assert.ok(route);
    assert.equal(
      buildUpstreamUrl(route, '/api/v0/users/get_user_summary', ''),
      'https://platform.deepseek.com/api/v0/users/get_user_summary',
    );
  });

  it('通知路径路由到 harnessOrigin 且保留完整前缀', () => {
    const path = '/api/v0/users/notifications/list';
    const route = matchRoute(routes, path);
    assert.ok(route);
    assert.equal(route.upstreamOrigin, 'https://harness.deepseek.com');
    assert.equal(buildUpstreamUrl(route, path, ''), 'https://harness.deepseek.com/api/v0/users/notifications/list');
  });

  it('通知路径的查询串原样保留', () => {
    const path = '/api/v0/users/notifications/content';
    const route = matchRoute(routes, path);
    assert.ok(route);
    assert.equal(
      buildUpstreamUrl(route, path, '?id=abc'),
      'https://harness.deepseek.com/api/v0/users/notifications/content?id=abc',
    );
  });

  it('通知前缀压过平台的 /api/v0（最长前缀优先）', () => {
    const route = matchRoute(routes, '/api/v0/users/notifications/events');
    assert.ok(route);
    assert.equal(route.label, 'DeepSeek Harness 通知');
  });
});

describe('matchRoute', () => {
  it('无匹配前缀时返回 undefined', () => {
    assert.equal(matchRoute(deepseekAccountRoutes(), '/v1/chat/completions'), undefined);
  });

  it('路径边界按 / 判定（/api/v0x 不匹配 /api/v0）', () => {
    assert.equal(matchRoute(deepseekAccountRoutes(), '/api/v0x/users'), undefined);
  });

  it('前缀本身命中也算匹配', () => {
    const route = matchRoute(deepseekAccountRoutes(), '/api/v0');
    assert.ok(route);
    assert.equal(route.upstreamPath, '/api/v0');
  });
});

describe('buildUpstreamUrl 与既有路由的约定', () => {
  it('DeepSeek 原生通道：/anthropic 路径原样保留', () => {
    const route = deepseekRoute();
    assert.equal(
      buildUpstreamUrl(route, '/anthropic/v1/messages', ''),
      'https://api.deepseek.com/anthropic/v1/messages',
    );
  });

  it('模型列表路由：/models 指向 api.deepseek.com/models', () => {
    const route = deepseekModelsRoute();
    assert.equal(route.upstreamPath, route.prefix);
    assert.equal(buildUpstreamUrl(route, '/models', ''), 'https://api.deepseek.com/models');
  });

  it('pi-ai 路由：前缀被上游路径替换，剩余子路径保留', () => {
    const route = { prefix: '/r/foo', upstreamOrigin: 'https://api.example.com', upstreamPath: '/v1', label: 'foo' };
    assert.equal(
      buildUpstreamUrl(route, '/r/foo/chat/completions', '?x=1'),
      'https://api.example.com/v1/chat/completions?x=1',
    );
  });
});

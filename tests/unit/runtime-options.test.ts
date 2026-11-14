/**
 * @file 插件运行时配置合并回归
 * @description 切回 auto 不复用 existing 的历史输入，显式配置仍可覆盖。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRuntimeOverrides } from '../../src/plugin/runtime-options.ts';

const saved = { nodePath: '/opt/node/bin/node', npmRegistry: 'https://intranet.example/npm/' };

test('auto 不继承 existing 的 Node/registry 历史输入', () => {
  assert.deepEqual(resolveRuntimeOverrides('auto', {}, saved, {}), {});
});

test('existing 仍复用历史输入，显式请求优先', () => {
  assert.deepEqual(resolveRuntimeOverrides('existing', {}, saved, {}), saved);
  assert.equal(resolveRuntimeOverrides('existing', { npmRegistry: 'https://new.example/' }, saved, {}).npmRegistry, 'https://new.example/');
});

test('auto 支持本次显式 npm 源与插件默认源，但不传 Node 路径', () => {
  assert.deepEqual(resolveRuntimeOverrides('auto', { ...saved }, {}, {}), { npmRegistry: saved.npmRegistry });
  assert.deepEqual(resolveRuntimeOverrides('auto', {}, saved, { npmRegistry: 'https://default.example/' }), { npmRegistry: 'https://default.example/' });
});

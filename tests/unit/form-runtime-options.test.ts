/** @file 连接表单切换部署方式的输入隔离回归 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formRuntimeOverrides } from '../../src/plugin-client/runtime-options.ts';

const nodePath = '/opt/node/bin/node';
const registry = 'https://intranet.example/npm/';

test('existing 切回 auto 或缺省模式时不发送 existing 历史输入', () => {
  for (const mode of ['auto', undefined] as const) {
    assert.deepEqual(formRuntimeOverrides(mode, nodePath, registry, ''), {});
  }
});

test('existing 输入保持可复用，auto 只发送独立填写的源', () => {
  assert.deepEqual(formRuntimeOverrides('existing', nodePath, registry, 'https://auto.example/'), { nodePath, npmRegistry: registry });
  assert.deepEqual(formRuntimeOverrides('auto', nodePath, registry, ' https://auto.example/ '), { npmRegistry: 'https://auto.example/' });
  assert.deepEqual(formRuntimeOverrides('offline', nodePath, registry, 'https://auto.example/'), {});
});

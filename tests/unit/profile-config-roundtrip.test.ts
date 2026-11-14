/**
 * @file profile 嵌套配置与 YAML 往返回归
 * @description 通过公开写入接口捕获远端内容，不连接远端或使用真实凭据。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'yaml';
import { prepareSessionProfile } from '../../src/provision/profile-writer.ts';
import { createRemotePaths } from '../../src/provision/remote-paths.ts';
import type { RemoteTransport } from '../../src/transport/types.ts';

/** 构建只操作内存文本的传输替身。 */
function fixture(original = '') {
  let text = original;
  const transport = {
    hostAlias: 'myhost',
    async exec(command: string) {
      return { stdout: command.startsWith('cat ') ? text : 'EXISTS', stderr: '', exitCode: 0 };
    },
    async writeRemoteFile(_path: string, content: string) { text = content; },
  } as unknown as RemoteTransport;
  return { ctx: { transport, paths: createRemotePaths('/home/youruser') }, read: () => text, replace: (value: string) => { text = value; } };
}

test('patch YAML 特殊键名、标量和 id 往返后保持原值并可追加条目', async () => {
  const f = fixture();
  const patches = [{ id: 'plugin: # quoted', config: { 'key: #\n': 'line1\nline2\t"\\', 'true': 'null', nested: { 'a:b': ['x\ny'] } } }];
  await prepareSessionProfile(f.ctx, { sessionId: 'test', dshBin: '/bin/dsh', nodeBinDir: '/bin', patches });
  assert.deepEqual(parse(f.read()), patches);
  assert.deepEqual(parse(f.read() + '- id: appended\n  config: {}\n'), [...patches, { id: 'appended', config: {} }]);
});

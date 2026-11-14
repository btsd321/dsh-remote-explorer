/**
 * @file 会话首轮探测部署方式回归
 * @description 用无下载工具的传输替身验证实际会话入口；探测之后立即终止，避免真实凭据与网络访问。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeAndReadCredentials } from '../../src/session/open-pipeline/probe.ts';
import { runDoctor } from '../../src/cli/commands/doctor.ts';
import type { RemoteTransport } from '../../src/transport/types.ts';
import type { OpenSessionOptions } from '../../src/session/options.ts';

test('会话 existing/offline 放行无 curl/wget/tar 主机，auto 仍拒绝', async () => {
  const old = process.env.DSH_REMOTE_OFFLINE;
  delete process.env.DSH_REMOTE_OFFLINE;
  try {
    for (const mode of ['existing', 'offline', 'auto'] as const) {
      let calls = 0;
      const transport = {
        platform: { os: 'linux', arch: 'x64' }, hostAlias: 'myhost',
        async exec() {
          if (++calls > 1) throw new Error('探测后停止');
          return { stdout: 'HOME=/home/test\nAVAIL=999999999\n', stderr: '', exitCode: 0 };
        },
      } as unknown as RemoteTransport;
      await assert.rejects(probeAndReadCredentials(transport, 'test', {
        deploymentMode: mode,
      } as OpenSessionOptions), mode === 'auto' ? /没有 curl/ : /探测后停止/);
    }
  } finally {
    if (old === undefined) delete process.env.DSH_REMOTE_OFFLINE;
    else process.env.DSH_REMOTE_OFFLINE = old;
  }
});

test('doctor 在连接前拒绝 existing 与严格离线冲突', async () => {
  const old = process.env.DSH_REMOTE_OFFLINE;
  process.env.DSH_REMOTE_OFFLINE = '1';
  try {
    await assert.rejects(runDoctor({ alias: 'myhost', refreshMirrors: false, deploymentMode: 'existing' }), /严格离线模式/);
  } finally {
    if (old === undefined) delete process.env.DSH_REMOTE_OFFLINE;
    else process.env.DSH_REMOTE_OFFLINE = old;
  }
});

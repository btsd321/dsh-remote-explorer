/**
 * @file provision/mirror-selector.ts 单元测试
 * @description 覆盖远端镜像测速的代理注入（local_resource_download 的回归线）：
 *              远端无公网时，测速的 curl 也必须带 `-x <proxy>`——否则所有候选
 *              都不可达，selectMirror 直接抛 MIRROR_ALL_UNREACHABLE，后面本已
 *              注入代理的下载步骤根本执行不到。
 */

import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { selectMirror } from '../../src/provision/mirror-selector.js';
import type {
  ExecResult, RemoteChannel, RemotePlatform, RemoteTransport, ReverseConnection, ReverseHandle,
} from '../../src/transport/types.js';

/** 测试用代理 URL（取值在分配器候选区间内，形态与真实注入值一致） */
const PROXY_URL = 'http://127.0.0.1:47123';

/**
 * 构造 mock transport，并捕获全部 exec 命令。
 *
 * @param probeStdout - 测速命令的 stdout（R= 行）；默认让首个候选可用
 * @returns mock transport 与命令捕获列表
 */
function mockTransport(probeStdout = 'R=0 OK 0.42\nR=1 BAD \nR=2 BAD \nR=3 BAD '): {
  transport: RemoteTransport;
  commands: string[];
} {
  const commands: string[] = [];
  const transport: RemoteTransport = {
    hostAlias: 'test-host',
    platform: { os: 'linux', arch: 'x64', rawOs: 'Linux', rawArch: 'x86_64' } as RemotePlatform,
    isAlive: true,
    connect: mock.fn(async () => {}),
    exec: mock.fn(async (command: string): Promise<ExecResult> => {
      commands.push(command);
      // 测速命令含 R= 输出格式；缓存读写命令（cat / printf）回空
      if (command.includes('head -c 1')) {
        return { stdout: probeStdout, stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    }),
    uploadFile: mock.fn(async () => {}),
    uploadFiles: mock.fn(async () => {}),
    writeRemoteFile: mock.fn(async () => {}),
    readRemoteFile: mock.fn(async () => Buffer.alloc(0)),
    checkSftp: mock.fn(async () => {}),
    openChannel: mock.fn(async (): Promise<RemoteChannel> => ({ stream: null as never, release: () => {} })),
    forwardIn: mock.fn(async (port: number): Promise<ReverseHandle> => ({ remotePort: port, close: mock.fn(async () => {}) })),
    dispose: mock.fn(async () => {}),
  };
  return { transport, commands };
}

/**
 * 取捕获到的测速命令（含 `head -c 1` 的那条）。
 *
 * @param commands - 捕获到的全部命令
 * @returns 测速命令；没有则 undefined
 */
function probeCommandOf(commands: readonly string[]): string | undefined {
  return commands.find(command => command.includes('head -c 1'));
}

describe('selectMirror 的代理注入', () => {
  it('不传 proxyUrl 时测速命令不含 -x（原行为不变）', async () => {
    const { transport, commands } = mockTransport();
    await selectMirror(transport, 'node', { cachePath: '/tmp/mirror-cache.json', force: true });
    const probe = probeCommandOf(commands);
    assert.ok(probe !== undefined, '应执行测速命令');
    assert.ok(!probe.includes(' -x '), '未配置代理时不应出现 -x');
  });

  it('传 proxyUrl 时每个 curl 都带 -x <proxy>（回归：无网远端测速要走代理）', async () => {
    const { transport, commands } = mockTransport();
    await selectMirror(transport, 'node', {
      cachePath: '/tmp/mirror-cache.json',
      force: true,
      proxyUrl: PROXY_URL,
    });
    const probe = probeCommandOf(commands);
    assert.ok(probe !== undefined, '应执行测速命令');
    // 每个候选两次 curl（取首字节 + 测总耗时），Node 候选共 4 个 → 8 处
    const occurrences = probe.split(`-x ${PROXY_URL}`).length - 1;
    assert.equal(occurrences, 8, `4 个候选 × 2 次 curl 都应带代理，实际 ${occurrences} 处`);
  });

  it('npm registry 测速同样注入代理', async () => {
    const { transport, commands } = mockTransport('R=0 OK 0.10\nR=1 BAD ');
    await selectMirror(transport, 'npm', {
      cachePath: '/tmp/mirror-cache.json',
      force: true,
      proxyUrl: PROXY_URL,
    });
    const probe = probeCommandOf(commands);
    assert.ok(probe !== undefined);
    // npm 候选 2 个 × 2 次 curl → 4 处
    const occurrences = probe.split(`-x ${PROXY_URL}`).length - 1;
    assert.equal(occurrences, 4, `2 个候选 × 2 次 curl 都应带代理，实际 ${occurrences} 处`);
  });

  it('代理 URL 经 shell 转义，不产生注入面', async () => {
    const { transport, commands } = mockTransport();
    await selectMirror(transport, 'node', {
      cachePath: '/tmp/mirror-cache.json',
      force: true,
      proxyUrl: 'http://127.0.0.1:47123',
    });
    const probe = probeCommandOf(commands)!;
    // 地址里的字符都在 shell 安全集内，不加引号；关键是完整出现且未被截断
    assert.ok(probe.includes('http://127.0.0.1:47123'));
  });
});

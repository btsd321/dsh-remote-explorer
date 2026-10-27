/**
 * @file provision/provision-proxy-tunnel.ts 单元测试
 * @description 覆盖 setupProvisionProxyTunnel 的三种模式分支决策：
 *              off 不建隧道、auto 远端有网不建隧道、auto 远端无网建隧道、
 *              always 直接建隧道。用 mock transport 模拟远端网络可达性与
 *              forwardIn 能力。
 */

import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { setupProvisionProxyTunnel } from '../../src/provision/provision-proxy-tunnel.js';
import type { RemoteTransport, ReverseConnection, ReverseHandle, RemoteChannel, RemoteFileOptions, ExecResult, RemotePlatform } from '../../src/transport/types.js';

/**
 * 构造 mock transport。
 *
 * @param remoteReachable - 远端网络是否可达（mock curl 探测返回的 http_code）
 * @param supportsForwardIn - 传输是否支持 forwardIn
 * @returns mock transport
 */
function mockTransport(remoteReachable: boolean, supportsForwardIn = true): RemoteTransport {
  return {
    hostAlias: 'test-host',
    platform: { os: 'linux', arch: 'x64', rawOs: 'Linux', rawArch: 'x86_64' } as RemotePlatform,
    isAlive: true,
    connect: mock.fn(async () => {}),
    exec: mock.fn(async (command: string): Promise<ExecResult> => {
      // 探测命令含 curl -w '%{http_code}'
      if (command.includes('http_code')) {
        return { stdout: remoteReachable ? '200' : '000', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    }),
    uploadFile: mock.fn(async () => {}),
    uploadFiles: mock.fn(async () => {}),
    writeRemoteFile: mock.fn(async () => {}),
    readRemoteFile: mock.fn(async () => Buffer.alloc(0)),
    checkSftp: mock.fn(async () => {}),
    openChannel: mock.fn(async (): Promise<RemoteChannel> => ({ stream: null as never, release: () => {} })),
    forwardIn: supportsForwardIn
      ? mock.fn(async (_port: number, onConnection: (c: ReverseConnection) => void): Promise<ReverseHandle> => {
        // 不实际调用 onConnection（测试不验证代理转发逻辑）
        return { remotePort: _port, close: mock.fn(async () => {}) };
      })
      : undefined,
    dispose: mock.fn(async () => {}),
  };
}

describe('setupProvisionProxyTunnel', () => {
  it('off 模式：不建隧道，proxyUrl 为 undefined', async () => {
    const transport = mockTransport(true);
    const result = await setupProvisionProxyTunnel(transport, 'off');
    assert.equal(result.proxyUrl, undefined);
    await result.teardown();
    // forwardIn 不应被调用
    assert.equal(transport.forwardIn === undefined ? 0 : transport.forwardIn.mock.callCount(), 0);
  });

  it('auto 模式：远端有网时不建隧道', async () => {
    const transport = mockTransport(true);
    const result = await setupProvisionProxyTunnel(transport, 'auto');
    assert.equal(result.proxyUrl, undefined);
    await result.teardown();
  });

  it('auto 模式：远端无网时建隧道，proxyUrl 指向远端反向端口', async () => {
    const transport = mockTransport(false);
    const result = await setupProvisionProxyTunnel(transport, 'auto');
    assert.notEqual(result.proxyUrl, undefined);
    assert.match(result.proxyUrl!, /^http:\/\/127\.0\.0\.1:\d+$/);
    await result.teardown();
  });

  it('always 模式：直接建隧道，不探测远端网络', async () => {
    // 远端有网但 always 模式——应跳过探测直接建隧道
    const transport = mockTransport(true);
    const result = await setupProvisionProxyTunnel(transport, 'always');
    assert.notEqual(result.proxyUrl, undefined);
    await result.teardown();
  });

  it('undefined 模式按 auto 处理：远端有网不建隧道', async () => {
    const transport = mockTransport(true);
    const result = await setupProvisionProxyTunnel(transport, undefined);
    assert.equal(result.proxyUrl, undefined);
    await result.teardown();
  });

  it('auto 模式：远端无网但传输不支持 forwardIn 时降级为不建隧道', async () => {
    const transport = mockTransport(false, false);
    const result = await setupProvisionProxyTunnel(transport, 'auto');
    assert.equal(result.proxyUrl, undefined);
    await result.teardown();
  });

  it('always 模式：传输不支持 forwardIn 时降级为不建隧道', async () => {
    const transport = mockTransport(false, false);
    const result = await setupProvisionProxyTunnel(transport, 'always');
    assert.equal(result.proxyUrl, undefined);
    await result.teardown();
  });

  it('teardown 是幂等的', async () => {
    const transport = mockTransport(false);
    const result = await setupProvisionProxyTunnel(transport, 'always');
    await result.teardown();
    await result.teardown(); // 不抛错
  });
});

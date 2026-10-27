/**
 * @file provision/local-download-strategy.ts 单元测试
 * @description 覆盖 executeDownloadStrategy 的三种模式分支决策：
 *              off 仅远端、always 仅本机、auto 先远端失败回退本机/远端成功不回退。
 *              用 mock transport 与计数回调验证调用次数与顺序。
 */

import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { executeDownloadStrategy } from '../../src/provision/local-download-strategy.js';
import type { RemoteTransport } from '../../src/transport/types.js';

/**
 * 构造 mock transport（executeDownloadStrategy 只用 hostAlias 与日志，不用实际传输）。
 *
 * @returns mock transport
 */
function mockTransport(): RemoteTransport {
  return {
    hostAlias: 'test-host',
    platform: { os: 'linux', arch: 'x64', rawOs: 'Linux', rawArch: 'x86_64' },
    isAlive: true,
    connect: mock.fn(async () => {}),
    exec: mock.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
    uploadFile: mock.fn(async () => {}),
    uploadFiles: mock.fn(async () => {}),
    writeRemoteFile: mock.fn(async () => {}),
    readRemoteFile: mock.fn(async () => Buffer.alloc(0)),
    checkSftp: mock.fn(async () => {}),
    openChannel: mock.fn(async () => ({ stream: null as never, release: () => {} })),
    dispose: mock.fn(async () => {}),
  };
}

describe('executeDownloadStrategy', () => {
  it('off 模式：仅调 remoteDownload，不调 localDownload', async () => {
    const remoteDownload = mock.fn(async () => {});
    const localDownload = mock.fn(async () => {});
    const result = await executeDownloadStrategy({
      localResourceDownload: 'off',
      transport: mockTransport(),
      resourceName: 'test',
      remoteDownload: remoteDownload as () => Promise<void>,
      localDownload: localDownload as () => Promise<void>,
    });
    assert.equal(result.viaLocal, false);
    assert.equal(remoteDownload.mock.callCount(), 1);
    assert.equal(localDownload.mock.callCount(), 0);
  });

  it('always 模式：仅调 localDownload，不调 remoteDownload', async () => {
    const remoteDownload = mock.fn(async () => {});
    const localDownload = mock.fn(async () => {});
    const result = await executeDownloadStrategy({
      localResourceDownload: 'always',
      transport: mockTransport(),
      resourceName: 'test',
      remoteDownload: remoteDownload as () => Promise<void>,
      localDownload: localDownload as () => Promise<void>,
    });
    assert.equal(result.viaLocal, true);
    assert.equal(remoteDownload.mock.callCount(), 0);
    assert.equal(localDownload.mock.callCount(), 1);
  });

  it('auto 模式：远端成功时不调 localDownload', async () => {
    const remoteDownload = mock.fn(async () => {});
    const localDownload = mock.fn(async () => {});
    const result = await executeDownloadStrategy({
      localResourceDownload: 'auto',
      transport: mockTransport(),
      resourceName: 'test',
      remoteDownload: remoteDownload as () => Promise<void>,
      localDownload: localDownload as () => Promise<void>,
    });
    assert.equal(result.viaLocal, false);
    assert.equal(remoteDownload.mock.callCount(), 1);
    assert.equal(localDownload.mock.callCount(), 0);
  });

  it('auto 模式：远端失败时回退 localDownload', async () => {
    const remoteDownload = mock.fn(async () => { throw new Error('remote network down'); });
    const localDownload = mock.fn(async () => {});
    const cleanupRemoteTemp = mock.fn(async () => {});
    const result = await executeDownloadStrategy({
      localResourceDownload: 'auto',
      transport: mockTransport(),
      resourceName: 'test',
      remoteDownload: remoteDownload as () => Promise<void>,
      localDownload: localDownload as () => Promise<void>,
      cleanupRemoteTemp: cleanupRemoteTemp as () => Promise<void>,
    });
    assert.equal(result.viaLocal, true);
    assert.equal(remoteDownload.mock.callCount(), 1);
    assert.equal(localDownload.mock.callCount(), 1);
    assert.equal(cleanupRemoteTemp.mock.callCount(), 1);
  });

  it('auto 模式：远端与本机都失败时抛错', async () => {
    const remoteDownload = mock.fn(async () => { throw new Error('remote down'); });
    const localDownload = mock.fn(async () => { throw new Error('local down'); });
    const cleanupRemoteTemp = mock.fn(async () => {});
    await assert.rejects(
      executeDownloadStrategy({
        localResourceDownload: 'auto',
        transport: mockTransport(),
        resourceName: 'test',
        remoteDownload: remoteDownload as () => Promise<void>,
        localDownload: localDownload as () => Promise<void>,
        cleanupRemoteTemp: cleanupRemoteTemp as () => Promise<void>,
      }),
      /下载失败/,
    );
    assert.equal(remoteDownload.mock.callCount(), 1);
    assert.equal(localDownload.mock.callCount(), 1);
  });

  it('undefined 模式按 auto 处理（远端成功）', async () => {
    const remoteDownload = mock.fn(async () => {});
    const localDownload = mock.fn(async () => {});
    const result = await executeDownloadStrategy({
      localResourceDownload: undefined,
      transport: mockTransport(),
      resourceName: 'test',
      remoteDownload: remoteDownload as () => Promise<void>,
      localDownload: localDownload as () => Promise<void>,
    });
    assert.equal(result.viaLocal, false);
    assert.equal(remoteDownload.mock.callCount(), 1);
    assert.equal(localDownload.mock.callCount(), 0);
  });

  it('auto 模式：远端失败且无 cleanupRemoteTemp 时不报错直接回退', async () => {
    const remoteDownload = mock.fn(async () => { throw new Error('remote down'); });
    const localDownload = mock.fn(async () => {});
    const result = await executeDownloadStrategy({
      localResourceDownload: 'auto',
      transport: mockTransport(),
      resourceName: 'test',
      remoteDownload: remoteDownload as () => Promise<void>,
      localDownload: localDownload as () => Promise<void>,
      // 不传 cleanupRemoteTemp
    });
    assert.equal(result.viaLocal, true);
    assert.equal(localDownload.mock.callCount(), 1);
  });

  it('auto 模式：cleanupRemoteTemp 失败不阻断回退', async () => {
    const remoteDownload = mock.fn(async () => { throw new Error('remote down'); });
    const localDownload = mock.fn(async () => {});
    const cleanupRemoteTemp = mock.fn(async () => { throw new Error('cleanup failed'); });
    const result = await executeDownloadStrategy({
      localResourceDownload: 'auto',
      transport: mockTransport(),
      resourceName: 'test',
      remoteDownload: remoteDownload as () => Promise<void>,
      localDownload: localDownload as () => Promise<void>,
      cleanupRemoteTemp: cleanupRemoteTemp as () => Promise<void>,
    });
    assert.equal(result.viaLocal, true);
    assert.equal(localDownload.mock.callCount(), 1);
  });
});

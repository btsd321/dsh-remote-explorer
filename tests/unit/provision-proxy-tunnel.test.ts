/**
 * @file provision/provision-proxy-tunnel.ts 单元测试
 * @description 覆盖 setupProvisionProxyTunnel 的模式决策（off / auto 可达 /
 *              auto 不可达 / always / undefined），以及两条回归线：
 *              - forwardIn 失败时必须停掉本机代理（否则端口泄漏到进程退出）
 *              - 反向端口冲突时换端口重试（不再固定 18890）
 */

import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { setupProvisionProxyTunnel } from '../../src/provision/provision-proxy-tunnel.js';
import { PORT_RANGE_START, PORT_RANGE_SIZE } from '../../src/tunnel/port-allocator.js';
import type {
  ExecResult, RemoteChannel, RemotePlatform, RemoteTransport,
  ReverseConnection, ReverseHandle,
} from '../../src/transport/types.js';

/**
 * 统计当前进程里处于监听状态的 Server 句柄数。
 *
 * 用它断言「失败路径 / teardown 之后本机代理确实关掉了」——比改写
 * LocalHttpProxy.prototype 计数更贴近要证明的事实（端口/句柄没泄漏），
 * 也不必动被测类的原型。
 *
 * @returns 监听中的 Server 句柄数
 */
function countListeningServers(): number {
  const handles = (process as unknown as { _getActiveHandles(): unknown[] })._getActiveHandles();
  return handles.filter(handle => {
    const record = handle as { listening?: unknown };
    return typeof record.listening === 'boolean' && record.listening;
  }).length;
}

/**
 * 构造 mock transport。
 *
 * @param options - 远端是否可达、是否支持 forwardIn、forwardIn 的失败次数
 * @returns mock transport 与捕获到的 exec 命令列表
 */
function mockTransport(options: {
  /** 远端网络是否可达（mock curl 探测返回的 http_code） */
  remoteReachable: boolean;
  /** 传输是否支持 forwardIn */
  supportsForwardIn?: boolean;
  /** forwardIn 前 N 次抛错（模拟端口冲突），之后成功 */
  forwardInFailures?: number;
}): { transport: RemoteTransport; commands: string[] } {
  const supportsForwardIn = options.supportsForwardIn ?? true;
  const commands: string[] = [];
  let remainingFailures = options.forwardInFailures ?? 0;
  /** 记录每次 forwardIn 请求的远端端口（断言换端口重试） */
  const requestedPorts: number[] = [];

  const transport: RemoteTransport = {
    hostAlias: 'test-host',
    platform: { os: 'linux', arch: 'x64', rawOs: 'Linux', rawArch: 'x86_64' } as RemotePlatform,
    isAlive: true,
    connect: mock.fn(async () => {}),
    exec: mock.fn(async (command: string): Promise<ExecResult> => {
      commands.push(command);
      // 网络可达性探测：命令含 http_code
      if (command.includes('http_code')) {
        return { stdout: options.remoteReachable ? '200' : '000', stderr: '', exitCode: 0 };
      }
      // 端口占用探测（ss/netstat）：回空 = 全部空闲
      return { stdout: '', stderr: '', exitCode: 0 };
    }),
    uploadFile: mock.fn(async () => {}),
    uploadFiles: mock.fn(async () => {}),
    writeRemoteFile: mock.fn(async () => {}),
    readRemoteFile: mock.fn(async () => Buffer.alloc(0)),
    checkSftp: mock.fn(async () => {}),
    openChannel: mock.fn(async (): Promise<RemoteChannel> => ({ stream: null as never, release: () => {} })),
    forwardIn: supportsForwardIn
      ? mock.fn(async (port: number, _onConnection: (c: ReverseConnection) => void): Promise<ReverseHandle> => {
        requestedPorts.push(port);
        if (remainingFailures > 0) {
          remainingFailures -= 1;
          throw new Error(`反向监听 127.0.0.1:${port} 失败: port in use`);
        }
        return { remotePort: port, close: mock.fn(async () => {}) };
      })
      : undefined,
    dispose: mock.fn(async () => {}),
  };

  // 把本次请求的端口列表挂到 transport 上供断言（测试内部用，不污染类型）
  (transport as unknown as { requestedPorts: number[] }).requestedPorts = requestedPorts;
  return { transport, commands };
}

/**
 * 取 mock transport 上记录的 forwardIn 请求端口。
 *
 * @param transport - mock transport
 * @returns 请求过的远端端口列表
 */
function requestedPortsOf(transport: RemoteTransport): number[] {
  return (transport as unknown as { requestedPorts: number[] }).requestedPorts;
}

/** 断言端口落在分配器的候选区间内 */
function assertInPortRange(port: number): void {
  assert.ok(
    port >= PORT_RANGE_START && port < PORT_RANGE_START + PORT_RANGE_SIZE,
    `端口 ${port} 应来自分配器候选区间 ${PORT_RANGE_START}–${PORT_RANGE_START + PORT_RANGE_SIZE - 1}`,
  );
}

describe('setupProvisionProxyTunnel', () => {
  it('off 模式：不建隧道、不探测、不碰代理', async () => {
    const baseline = countListeningServers();
    const { transport, commands } = mockTransport({ remoteReachable: false });
    const result = await setupProvisionProxyTunnel(transport, 'off');
    assert.equal(result.proxyUrl, undefined);
    assert.equal(countListeningServers(), baseline, 'off 模式不应启动本机代理（无新增监听句柄）');
    assert.ok(!commands.some(c => c.includes('http_code')), 'off 模式不应探测远端网络');
    await result.teardown();
  });

  it('auto 模式：远端可达时不建隧道', async () => {
    const { transport } = mockTransport({ remoteReachable: true });
    const result = await setupProvisionProxyTunnel(transport, 'auto');
    assert.equal(result.proxyUrl, undefined);
    assert.deepEqual(requestedPortsOf(transport), []);
    await result.teardown();
  });

  it('auto 模式：远端不可达时建隧道，端口来自分配器区间', async () => {
    const { transport } = mockTransport({ remoteReachable: false });
    const result = await setupProvisionProxyTunnel(transport, 'auto');
    assert.match(result.proxyUrl ?? '', /^http:\/\/127\.0\.0\.1:\d+$/);
    const port = Number.parseInt((result.proxyUrl ?? '').split(':').at(-1)!, 10);
    assertInPortRange(port);
    await result.teardown();
  });

  it('always 模式：跳过探测直接建隧道', async () => {
    const { transport, commands } = mockTransport({ remoteReachable: true });
    const result = await setupProvisionProxyTunnel(transport, 'always');
    assert.notEqual(result.proxyUrl, undefined);
    assert.ok(!commands.some(c => c.includes('http_code')), 'always 模式不应探测远端网络');
    await result.teardown();
  });

  it('auto 模式：探测覆盖全部 npm 候选（回归：单点被墙不误判无网）', async () => {
    const { transport, commands } = mockTransport({ remoteReachable: true });
    await setupProvisionProxyTunnel(transport, 'auto');
    const probe = commands.find(c => c.includes('http_code'));
    assert.ok(probe !== undefined, 'auto 模式应探测远端网络');
    for (const url of ['registry.npmmirror.com', 'registry.npmjs.org']) {
      assert.ok(probe.includes(url), `探测脚本应包含候选 ${url}`);
    }
  });

  it('undefined 按 auto 处理', async () => {
    const { transport } = mockTransport({ remoteReachable: true });
    const result = await setupProvisionProxyTunnel(transport, undefined);
    assert.equal(result.proxyUrl, undefined);
    await result.teardown();
  });

  it('传输不支持 forwardIn 时降级为不建隧道', async () => {
    const { transport } = mockTransport({ remoteReachable: false, supportsForwardIn: false });
    const result = await setupProvisionProxyTunnel(transport, 'always');
    assert.equal(result.proxyUrl, undefined);
    await result.teardown();
  });

  it('端口冲突时换端口重试成功（回归：不再用固定端口）', async () => {
    const { transport } = mockTransport({ remoteReachable: false, forwardInFailures: 1 });
    const result = await setupProvisionProxyTunnel(transport, 'always');
    assert.notEqual(result.proxyUrl, undefined, '换端口后应建成功');
    const ports = requestedPortsOf(transport);
    assert.equal(ports.length, 2, '应尝试两个端口');
    assert.notEqual(ports[0], ports[1], '两次尝试必须是不同端口');
    for (const port of ports) assertInPortRange(port);
    await result.teardown();
  });

  it('两次绑定都失败时停掉本机代理并降级（回归：代理不泄漏）', async () => {
    const baseline = countListeningServers();
    const { transport } = mockTransport({ remoteReachable: false, forwardInFailures: 99 });
    const result = await setupProvisionProxyTunnel(transport, 'always');
    assert.equal(result.proxyUrl, undefined, '绑不上端口应降级为不建隧道');
    // 代理起过又必须被关掉：监听句柄数回到基线，端口不泄漏到进程退出
    assert.equal(countListeningServers(), baseline, '失败路径必须停掉本机代理，否则端口泄漏');
    await result.teardown();
  });

  it('teardown 关隧道并停代理（监听句柄回到基线），且可重复调用', async () => {
    const baseline = countListeningServers();
    const { transport } = mockTransport({ remoteReachable: false });
    const result = await setupProvisionProxyTunnel(transport, 'always');
    assert.notEqual(result.proxyUrl, undefined);
    assert.equal(countListeningServers(), baseline + 1, '隧道建立期间应有 1 个本机代理在监听');
    await result.teardown();
    assert.equal(countListeningServers(), baseline, 'teardown 必须停掉本机代理');
    await result.teardown(); // 幂等，不抛错
  });
});

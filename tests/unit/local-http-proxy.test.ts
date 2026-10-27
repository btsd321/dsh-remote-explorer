/**
 * @file tunnel/local-http-proxy.ts 单元测试
 * @description 覆盖本机 HTTP CONNECT 代理的启动/停止生命周期、真实 CONNECT
 *              转发链路，以及两条回归线：
 *              - stop() 必须在注入流仍打开时也能及时返回（否则 provision 的
 *                finally 会永久挂起）
 *              - 非 CONNECT 请求回 405，不误吞普通 HTTP
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createTcpServer, type Server as TcpServer, type Socket } from 'node:net';
import { request as httpRequest } from 'node:http';
import { PassThrough } from 'node:stream';
import { LocalHttpProxy } from '../../src/tunnel/local-http-proxy.js';

/** 本测试起过的资源，统一在 after 里收尾 */
const proxies: LocalHttpProxy[] = [];
const tcpServers: TcpServer[] = [];

/**
 * 起一个把收到的字节原样回显的 TCP 服务器（模拟被代理的上游目标）。
 *
 * @returns 监听端口
 */
async function startEchoServer(): Promise<number> {
  const server = createTcpServer((socket: Socket) => {
    socket.pipe(socket); // 回显
  });
  tcpServers.push(server);
  return new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve(typeof addr === 'object' && addr !== null ? addr.port : 0);
    });
  });
}

/**
 * 建一个受测试管理的代理实例。
 *
 * @returns 代理实例
 */
function makeProxy(): LocalHttpProxy {
  const proxy = new LocalHttpProxy();
  proxies.push(proxy);
  return proxy;
}

after(async () => {
  for (const proxy of proxies) await proxy.stop();
  for (const server of tcpServers) await new Promise<void>((resolve) => { server.close(() => resolve()); });
});

describe('LocalHttpProxy', () => {
  it('start() 返回本机端口，重复调用返回同一端口', async () => {
    const proxy = makeProxy();
    const first = await proxy.start();
    assert.ok(first > 0);
    assert.equal(proxy.localPort, first);
    assert.equal(await proxy.start(), first);
  });

  it('stop() 把端口归零，之后可重新 start()', async () => {
    const proxy = makeProxy();
    const first = await proxy.start();
    await proxy.stop();
    assert.equal(proxy.localPort, 0);
    // 端口已释放：同一实例可以再起一次（若 close 未真正完成，这里会失败）
    const second = await proxy.start();
    assert.ok(second > 0);
    assert.notEqual(second, first);
  });

  it('stop() 幂等：连续调用不抛错', async () => {
    const proxy = makeProxy();
    await proxy.start();
    await proxy.stop();
    await proxy.stop();
    assert.equal(proxy.localPort, 0);
  });

  it('stop() 在注入流仍打开时也能及时返回（回归：provision 收尾挂起）', async () => {
    const proxy = makeProxy();
    await proxy.start();
    // 注入一条永不自行关闭的双工流，模拟远端 SSH 通道仍开着
    const stream = new PassThrough();
    proxy.handleStream(stream);
    // 若 stop() 依赖 server.close() 等连接自然结束，这里会挂住；
    // 超时竞速让回归立刻暴露成失败而不是让整个测试进程卡死
    const stopped = await Promise.race([
      proxy.stop().then(() => 'stopped' as const),
      new Promise<'timeout'>((resolve) => { setTimeout(() => resolve('timeout'), 2_000).unref(); }),
    ]);
    assert.equal(stopped, 'stopped', 'stop() 必须主动销毁注入流，不能等它自己关闭');
    assert.equal(proxy.localPort, 0);
  });

  it('CONNECT 请求被转发到目标并双向回显', async () => {
    const echoPort = await startEchoServer();
    const proxy = makeProxy();
    const proxyPort = await proxy.start();

    const body = await new Promise<string>((resolve, reject) => {
      const req = httpRequest({
        host: '127.0.0.1',
        port: proxyPort,
        method: 'CONNECT',
        path: `127.0.0.1:${echoPort}`,
      });
      req.on('connect', (res, socket) => {
        assert.equal(res.statusCode, 200);
        socket.once('data', (chunk) => {
          resolve(chunk.toString());
          socket.destroy();
        });
        socket.write('ping');
      });
      req.on('error', reject);
      req.end();
    });

    assert.equal(body, 'ping');
  });

  it('目标不可达时回 502 而非挂住', async () => {
    const proxy = makeProxy();
    const proxyPort = await proxy.start();
    // 选一个几乎不可能在监听的高位端口
    const deadPort = 1;

    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest({
        host: '127.0.0.1',
        port: proxyPort,
        method: 'CONNECT',
        path: `127.0.0.1:${deadPort}`,
      });
      req.on('connect', (res) => { resolve(res.statusCode ?? 0); req.destroy(); });
      req.on('error', reject);
      req.end();
    });

    assert.equal(status, 502);
  });

  it('非 CONNECT 的普通请求回 405', async () => {
    const proxy = makeProxy();
    const proxyPort = await proxy.start();

    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port: proxyPort, method: 'GET', path: '/' });
      req.on('response', (res) => { resolve(res.statusCode ?? 0); res.resume(); });
      req.on('error', reject);
      req.end();
    });

    assert.equal(status, 405);
  });
});

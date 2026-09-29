/**
 * @file tunnel/reverse-listener.ts 单元测试
 * @description 用**真实 socket** 覆盖：绑定分配、EADDRINUSE 换候选重试、
 *              多地址绑定（NAT 网关语义）、handler 后挂与杂散连接销毁、
 *              setExtraHosts 增量调整、close 幂等。测试端口全部走
 *              127.0.0.1/127.0.0.2 回环段，不触网。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { connect, createServer, type AddressInfo, type Socket } from 'node:net';
import { ReverseListener } from '../../src/tunnel/reverse-listener.js';

/** 测试用主机别名（日志定位信息，不参与行为） */
const ALIAS = 'wsl:Ubuntu-test';

/**
 * 连接到本机某地址并等待建立。
 *
 * error 监听器常驻（连接期失败会 reject，数据期失败被吞——远端销毁是预期行为，
 * 无监听器的 socket 出 error 事件会掀翻测试进程）。
 *
 * @param port - 端口
 * @param host - 地址（默认回环）
 * @returns 已建立的 socket
 */
function connectTo(port: number, host = '127.0.0.1'): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, host);
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

/**
 * 等待 socket 关闭（对端 destroy 可能表现为 error 或 close，先到者为准）。
 *
 * @param socket - 客户端 socket
 */
function waitForSocketClosed(socket: Socket): Promise<void> {
  return new Promise(resolve => {
    let settled = false;
    const finish = (): void => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    socket.once('close', finish);
    socket.once('error', finish);
  });
}

/**
 * 占住一个端口（模拟幽灵占用——EADDRINUSE 语义与真实占用一致）。
 *
 * @returns 端口与释放函数
 */
async function occupyPort(): Promise<{ port: number; release: () => void }> {
  const server = createServer(() => { /* 只占位不服务 */ });
  const port = await new Promise<number>(resolve => {
    server.once('listening', () => resolve((server.address() as AddressInfo).port));
    server.listen(0, '127.0.0.1');
  });
  return { port, release: () => { server.close(); } };
}

// ─── 绑定与分配 ───────────────────────────────────────────────────────────

describe('ReverseListener.bind', () => {
  it('分配端口并保持监听', async () => {
    const listener = new ReverseListener(ALIAS);
    const port = await listener.bind();
    // 区间（47000–48999）是偏好而非不变量：被整段静默占用的机器上 bind
    // 走 OS 分配回退（端口落动态区），此时仅要求绑定成功与语义成立
    assert.ok(port > 0 && port < 65_536, `端口 ${port} 应为合法 TCP 端口`);
    assert.equal(listener.port, port);
    assert.deepEqual([...listener.hosts], ['127.0.0.1']);
    await listener.close();
  });

  it('首选端口被占时换端口重试（幽灵占用语义）', async () => {
    const blocker = await occupyPort();
    try {
      const listener = new ReverseListener(ALIAS);
      const port = await listener.bind({ preferredPort: blocker.port });
      assert.notEqual(port, blocker.port);
      // 同上：换到的端口在区间耗尽时可能是 OS 分配的动态区端口
      assert.ok(port > 0 && port < 65_536, `端口 ${port} 应为合法 TCP 端口`);
      await listener.close();
    } finally {
      blocker.release();
    }
  });

  it('首选端口空闲时优先复用（复用语义）', async () => {
    // 首选端口要「确定空闲」：OS 分配（listen 0）取一个保证可绑定的口再
    // 释放复用——硬编码 47xxx 口在区间被静默占用的机器上必是假空闲
    const probe = await occupyPort();
    const preferred = probe.port;
    probe.release();
    const listener = new ReverseListener(ALIAS);
    const port = await listener.bind({ preferredPort: preferred });
    assert.equal(port, preferred);
    await listener.close();
  });

  it('重复 bind 被拒绝', async () => {
    const listener = new ReverseListener(ALIAS);
    await listener.bind();
    await assert.rejects(() => listener.bind(), /已绑定/);
    await listener.close();
  });
});

// ─── 多地址绑定（NAT 网关语义，用 127.0.0.2 模拟网关地址） ────────────────

describe('ReverseListener 多地址绑定', () => {
  it('附加地址与主绑定共用同一端口', async () => {
    const listener = new ReverseListener(ALIAS);
    const port = await listener.bind({ extraHosts: ['127.0.0.2'] });
    assert.ok(listener.hosts.includes('127.0.0.1'));
    assert.ok(listener.hosts.includes('127.0.0.2'));

    // 两个地址都真实可连（handler 挂上后经 127.0.0.2 进来的连接同样被接管）
    const got: number[] = [];
    listener.setHandler((connection) => {
      connection.stream.write('OK');
      got.push(connection.remotePort);
    });
    const client = await connectTo(port, '127.0.0.2');
    const reply = await new Promise<Buffer>(resolve => client.once('data', (chunk: Buffer) => resolve(chunk)));
    assert.equal(reply.toString(), 'OK');
    client.destroy();
    await listener.close();
  });

  it('附加地址绑定失败返回 false 并保持降级（仅主绑定）', async () => {
    const listener = new ReverseListener(ALIAS);
    await listener.bind();
    // 203.0.113.1（TEST-NET-1）未分配给本机任何接口：EADDRNOTAVAIL
    const ok = await listener.addHost('203.0.113.1');
    assert.equal(ok, false);
    assert.deepEqual([...listener.hosts], ['127.0.0.1']);
    await listener.close();
  });

  it('setExtraHosts 增量调整附加地址且主端口不变', async () => {
    const listener = new ReverseListener(ALIAS);
    const port = await listener.bind({ extraHosts: ['127.0.0.2'] });

    // 移除附加地址（如 NAT → mirrored 时摘掉旧网关）
    await listener.setExtraHosts([]);
    assert.deepEqual([...listener.hosts], ['127.0.0.1']);
    assert.equal(listener.port, port);

    // 重新补绑（自愈语义：早前绑定失败的地址每次重连都有一次机会）
    await listener.setExtraHosts(['127.0.0.2']);
    assert.ok(listener.hosts.includes('127.0.0.2'));
    assert.equal(listener.port, port);
    await listener.close();
  });

  it('setExtraHosts 幂等（集合无变化不产生操作）', async () => {
    const listener = new ReverseListener(ALIAS);
    await listener.bind({ extraHosts: ['127.0.0.2'] });
    await listener.setExtraHosts(['127.0.0.2']);
    assert.deepEqual([...listener.hosts].sort(), ['127.0.0.1', '127.0.0.2']);
    await listener.close();
  });
});

// ─── handler 后挂与连接接管（真实 socket） ────────────────────────────────

describe('ReverseListener 连接处理', () => {
  it('未挂 handler 时到达的连接被销毁（杂散连接）', async () => {
    const listener = new ReverseListener(ALIAS);
    const port = await listener.bind();
    const client = await connectTo(port);
    await waitForSocketClosed(client);
    await listener.close();
  });

  it('setHandler 后新连接经 handler 双向对接（真实 socket 数据回环）', async () => {
    const listener = new ReverseListener(ALIAS);
    const port = await listener.bind();

    const gotFromClient = new Promise<Buffer>(resolve => {
      listener.setHandler((connection) => {
        connection.stream.on('data', (chunk: Buffer) => resolve(chunk));
        connection.stream.write('PONG');
      });
    });

    const client = await connectTo(port);
    const clientGot = new Promise<Buffer>(resolve => {
      client.once('data', (chunk: Buffer) => resolve(chunk));
    });
    client.write('PING');

    assert.equal((await gotFromClient).toString(), 'PING');
    assert.equal((await clientGot).toString(), 'PONG');
    client.destroy();
    await listener.close();
  });

  it('杂散连接销毁后不会被事后接管，新连接正常进入 handler', async () => {
    const listener = new ReverseListener(ALIAS);
    const port = await listener.bind();

    // 先来一条杂散连接（无 handler → 直接销毁）
    const stray = await connectTo(port);
    await waitForSocketClosed(stray);

    // 挂 handler 后再连：只有新连接进入 handler。
    // 若实现错误地把杂散连接缓存起来事后补投，handled 会变成 2
    let handled = 0;
    const handlerCalled = new Promise<void>(resolve => {
      listener.setHandler(() => {
        handled += 1;
        resolve();
      });
    });
    const client = await connectTo(port);
    await handlerCalled;
    client.destroy();
    await waitForSocketClosed(client);
    await listener.close();
    assert.equal(handled, 1);
  });
});

// ─── close 语义 ───────────────────────────────────────────────────────────

describe('ReverseListener.close', () => {
  it('幂等且关闭后端口复位、后续操作被拒绝', async () => {
    const listener = new ReverseListener(ALIAS);
    await listener.bind();
    await listener.close();
    await listener.close(); // 幂等
    assert.equal(listener.port, undefined);
    await assert.rejects(() => listener.bind(), /已关闭/);
  });

  it('关闭后挂接 handler 的监听不再接受新连接', async () => {
    const listener = new ReverseListener(ALIAS);
    const port = await listener.bind();
    listener.setHandler((connection) => {
      connection.stream.write('OK');
    });
    const client = await connectTo(port);
    client.destroy();
    await listener.close();

    // 关闭后的新连接直接被拒（回环上表现为 connect error）
    await assert.rejects(() => connectTo(port), /ECONNREFUSED|connect/);
  });
});

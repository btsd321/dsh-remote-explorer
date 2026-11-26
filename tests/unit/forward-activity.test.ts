/**
 * @file tunnel/forward-local.ts 活跃度判定单元测试
 * @description 覆盖「远端 → 本机数据才算链路存活证据」这条契约，它是白屏修复
 *              的关键输入：session-manager 用它决定「心跳 exec 超时」是否算断线。
 *
 *              契约要点：
 *              - 本机 socket 写入**不**刷新时间戳（链路静默断开时浏览器仍会写，
 *                若把它当证据，容忍窗口永不到期，真实故障就永远不重连）；
 *              - 远端通道数据刷新时间戳；
 *              - 换传输后时间戳清零（旧连接的证据不能冒充新链路健康）。
 *
 *              用自建 Duplex 而不是 PassThrough 当假通道：PassThrough 会把写进去的
 *              数据再读出来触发 data 事件，就无法区分「本机写的」和「远端来的」；
 *              真实 SSH 通道的读写是两个独立方向。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Duplex } from 'node:stream';
import { once } from 'node:events';
import { connect, type Socket } from 'node:net';
import { LocalForward } from '../../src/tunnel/forward-local.js';
import type { RemoteTransport } from '../../src/transport/types.js';

/** 假 SSH 通道流：本机写入被收集（不产生 data），远端数据由 emitRemote 主动 push */
class FakeChannelStream extends Duplex {
  /** 本机 → 远端方向收到的字节 */
  readonly written: Buffer[] = [];

  /** 读侧由 emitRemote 驱动，这里不做任何事 */
  override _read(): void {
    /* 由测试驱动 */
  }

  /** 收下本机写入的字节，但不回流成 data 事件 */
  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.written.push(chunk);
    callback();
  }

  /**
   * 模拟远端下发数据（SSH 通道的读取方向）。
   *
   * @param chunk - 远端字节
   */
  emitRemote(chunk: Buffer): void {
    this.push(chunk);
  }
}

/**
 * 等待若干毫秒，让 pipe 与事件循环跑完。
 *
 * @param ms - 等待时长（毫秒）
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * 构造只实现 openChannel 的传输桩。
 *
 * @param stream - 每条新通道复用的假流
 * @returns 可强转为 RemoteTransport 的最小对象
 */
function stubTransport(stream: FakeChannelStream | (() => FakeChannelStream)): RemoteTransport {
  return {
    async openChannel() {
      return {
        stream: typeof stream === 'function' ? stream() : stream,
        release: () => { /* 配额归还对断言无意义 */ },
      };
    },
  } as unknown as RemoteTransport;
}

describe('LocalForward 活跃度判定', () => {
  it('尚无数据流动时为 false，windowMs <= 0 恒为 false', () => {
    const forward = new LocalForward(
      stubTransport(new FakeChannelStream()), '127.0.0.1', 1, { onForwardError: () => {} },
    );
    assert.equal(forward.isRecentlyActive(60_000), false);
    assert.equal(forward.isRecentlyActive(0), false);
    assert.equal(forward.isRecentlyActive(-1), false);
    assert.equal(forward.lastActivityAt, 0);
  });

  it('本机写入不刷新时间戳，远端数据才刷新；换传输后清零', async () => {
    const remoteStream = new FakeChannelStream();
    const forward = new LocalForward(stubTransport(remoteStream), '127.0.0.1', 1, {
      onForwardError: () => {},
    });
    const port = await forward.listen(0);
    const client: Socket = connect({ host: '127.0.0.1', port });
    try {
      await once(client, 'connect');
      // 等入站连接完成 openChannel + pipe
      await delay(100);

      // 本机 → 远端：只证明浏览器发了请求，不是链路存活证据
      client.write('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
      await delay(100);
      assert.equal(
        forward.isRecentlyActive(60_000), false,
        '本机写入不应刷新活跃时间戳（静默断链时浏览器仍会写）',
      );
      assert.equal(forward.lastActivityAt, 0);
      assert.ok(remoteStream.written.length > 0, '本机写入应确实到达通道');

      // 远端 → 本机：这才是链路还在传数据的证据
      remoteStream.emitRemote(Buffer.from('HTTP/1.1 200 OK\r\n\r\n'));
      await delay(100);
      assert.equal(forward.isRecentlyActive(60_000), true, '远端数据应刷新活跃时间戳');
      assert.ok(forward.lastActivityAt > 0);

      // 换传输：旧链路的证据必须作废，否则重连后最长一个窗口内会误判为新链路健康
      forward.swapTransport(stubTransport(new FakeChannelStream()));
      assert.equal(forward.isRecentlyActive(60_000), false, '换传输后应清零活跃时间戳');
      assert.equal(forward.lastActivityAt, 0);
    } finally {
      client.destroy();
      await forward.close();
    }
  });
});

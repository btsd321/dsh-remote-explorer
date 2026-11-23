/**
 * @file session/heartbeat.ts 单元测试
 * @description 覆盖 beat() 的结果分类：健康、远端明确异常（进程退出/端口未监听/
 *              无 HTTP 响应）、命令超时、其余链路错误。会话编排层依赖
 *              failureKind 区分「高负载排队超时」与「真正断链」，故分类准确性
 *              是白屏修复的关键契约，单独成测。
 *
 *              beat() 只依赖 transport.exec；这里用最小桩注入（断言只需 stdout/
 *              抛错），不构造真实 SSH 连接。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { beat } from '../../src/session/heartbeat.js';
import type { RemoteTransport, ExecOptions, ExecResult } from '../../src/transport/types.js';
import { RemoteError } from '../../src/util/errors.js';

/**
 * 构造只提供 exec 的传输桩。
 *
 * @param exec - 自定义 exec 实现
 * @returns 可强转为 RemoteTransport 的最小对象
 */
function stubTransport(exec: (command: string, options?: ExecOptions) => Promise<ExecResult>): RemoteTransport {
  return { exec } as unknown as RemoteTransport;
}

/** 构造一次成功的 exec 结果 */
function okResult(stdout: string): ExecResult {
  return { stdout, stderr: '', exitCode: 0 };
}

describe('beat 结果分类', () => {
  it('三项检查全部通过 → 健康', async () => {
    const transport = stubTransport(async () => okResult('PID=ok\nPORT=ok\nHTTP=303\n'));
    const result = await beat(transport, { pid: 1, port: 48809, token: 'x' });
    assert.equal(result.isHealthy, true);
    assert.equal(result.failureKind, undefined);
  });

  it('PID=dead → remote-down', async () => {
    const transport = stubTransport(async () => okResult('PID=dead\nPORT=ok\nHTTP=303\n'));
    const result = await beat(transport, { pid: 1, port: 48809 });
    assert.equal(result.isHealthy, false);
    assert.equal(result.failureKind, 'remote-down');
    assert.match(result.reason ?? '', /进程/);
  });

  it('PORT=down → remote-down', async () => {
    const transport = stubTransport(async () => okResult('PID=ok\nPORT=down\n'));
    const result = await beat(transport, { pid: 1, port: 48809 });
    assert.equal(result.isHealthy, false);
    assert.equal(result.failureKind, 'remote-down');
  });

  it('HTTP=000 → remote-down（进程/端口在但 webserver 无响应）', async () => {
    const transport = stubTransport(async () => okResult('PID=ok\nPORT=ok\nHTTP=000\n'));
    const result = await beat(transport, { pid: 1, port: 48809, token: 'x' });
    assert.equal(result.isHealthy, false);
    assert.equal(result.failureKind, 'remote-down');
  });

  it('PORT=unknown 且 HTTP=unknown → 健康（工具缺失不误判）', async () => {
    const transport = stubTransport(async () => okResult('PID=ok\nPORT=unknown\nHTTP=unknown\n'));
    const result = await beat(transport, { pid: 1, port: 48809, token: 'x' });
    assert.equal(result.isHealthy, true);
  });

  it('命令超时（EXEC_FAILED 含「超时」）→ timeout', async () => {
    const transport = stubTransport(async () => {
      throw new RemoteError('EXEC_FAILED', '主机 h 上的命令超时（15000ms）：sh -c ...');
    });
    const result = await beat(transport, { pid: 1, port: 48809 });
    assert.equal(result.isHealthy, false);
    assert.equal(result.failureKind, 'timeout');
  });

  it('其余链路错误 → link-error', async () => {
    const transport = stubTransport(async () => {
      throw new RemoteError('CONNECT_FAILED', '主机 h 的连接已失效: socket hang up');
    });
    const result = await beat(transport, { pid: 1, port: 48809 });
    assert.equal(result.isHealthy, false);
    assert.equal(result.failureKind, 'link-error');
  });

  it('非 RemoteError 异常 → link-error（不误判为超时）', async () => {
    const transport = stubTransport(async () => {
      throw new Error('socket hang up');
    });
    const result = await beat(transport, { pid: 1, port: 48809 });
    assert.equal(result.isHealthy, false);
    assert.equal(result.failureKind, 'link-error');
  });
});

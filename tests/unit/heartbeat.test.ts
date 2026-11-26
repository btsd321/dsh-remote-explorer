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
import { beat, isTolerableFailure, type HeartbeatResult } from '../../src/session/heartbeat.js';
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

  it('命令超时（EXEC_TIMEOUT）→ timeout', async () => {
    const transport = stubTransport(async () => {
      throw new RemoteError('EXEC_TIMEOUT', '主机 h 上的命令超时（15000ms）：sh -c ...');
    });
    const result = await beat(transport, { pid: 1, port: 48809 });
    assert.equal(result.isHealthy, false);
    assert.equal(result.failureKind, 'timeout');
  });

  it('EXEC_FAILED 即使消息含「超时」也不算 timeout（不靠文案分类）', async () => {
    // 通道池等人为等待超时、退出码非零等都落在 EXEC_FAILED，若按消息匹配
    // 会把它们误判成「链路可能只是忙」，从而漏掉真实故障
    const transport = stubTransport(async () => {
      throw new RemoteError('EXEC_FAILED', '等待 SSH 通道超时（30000ms）：exec 类通道已用满');
    });
    const result = await beat(transport, { pid: 1, port: 48809 });
    assert.equal(result.isHealthy, false);
    assert.equal(result.failureKind, 'link-error');
  });

  it('WSL 传输包装后的超时同样归 timeout（EXEC_TIMEOUT 透传）', async () => {
    const transport = stubTransport(async () => {
      throw new RemoteError('EXEC_TIMEOUT', 'WSL 命令超时（15000ms）：wsl.exe -d Ubuntu -- bash -c ...');
    });
    const result = await beat(transport, { pid: 1, port: 48809 });
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

describe('isTolerableFailure（容忍规则）', () => {
  /** 命令超时：结果未知，可能只是链路忙 */
  const timeoutFailure: HeartbeatResult = {
    isHealthy: false, failureKind: 'timeout', reason: '命令超时',
  };
  /** 远端明确异常：进程退出 / 端口未监听 / 无 HTTP 响应 */
  const remoteDown: HeartbeatResult = {
    isHealthy: false, failureKind: 'remote-down', reason: '远端进程已退出',
  };
  /** 其余链路错误：连接已失效 */
  const linkError: HeartbeatResult = {
    isHealthy: false, failureKind: 'link-error', reason: '连接已失效',
  };

  it('超时 + 转发近期有远端数据 → 容忍', () => {
    assert.equal(isTolerableFailure(timeoutFailure, true), true);
  });

  it('超时但转发无活动 → 不容忍（照常累加断线）', () => {
    assert.equal(isTolerableFailure(timeoutFailure, false), false);
  });

  it('远端明确异常即使转发活跃也不容忍', () => {
    assert.equal(isTolerableFailure(remoteDown, true), false);
  });

  it('链路错误即使转发活跃也不容忍', () => {
    assert.equal(isTolerableFailure(linkError, true), false);
  });

  it('健康结果不算「容忍」（调用方应走 heartbeat-ok 而不是「未知」分支）', () => {
    assert.equal(isTolerableFailure({ isHealthy: true }, true), false);
  });
});

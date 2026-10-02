/**
 * @file session/lifecycle-state.ts 单元测试
 * @description 覆盖 transition() 的核心转移与**引用去重契约**：稳态事件必须
 *              返回同一引用（RemoteSession.apply 按引用判等决定是否通知
 *              onStateChange——返回新对象会让心跳周期性刷「已连接」状态日志，
 *              实测踩过）；无意义转移原样返回。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_LIFECYCLE_CONFIG, INITIAL_STATE, transition, type SessionState,
} from '../../src/session/lifecycle-state.js';

describe('transition 引用去重契约（防状态日志刷屏）', () => {
  it('已连接稳态收到 heartbeat-ok 返回同一引用', () => {
    const connected: SessionState = { tag: 'connected', missedHeartbeats: 0, reconnectAttempts: 0 };
    assert.equal(transition(connected, { type: 'heartbeat-ok' }), connected);
  });

  it('idle 收到心跳结果返回同一引用（无意义转移静默忽略）', () => {
    assert.equal(transition(INITIAL_STATE, { type: 'heartbeat-ok' }), INITIAL_STATE);
    assert.equal(transition(INITIAL_STATE, { type: 'heartbeat-fail' }), INITIAL_STATE);
  });

  it('disconnected 收到重连请求返回同一引用', () => {
    const disconnected: SessionState = { tag: 'disconnected', missedHeartbeats: 0, reconnectAttempts: 0 };
    assert.equal(transition(disconnected, { type: 'reconnect-start' }), disconnected);
  });
});

describe('transition 核心转移', () => {
  it('connect-start → connecting，connect-ready → connected', () => {
    const connecting = transition(INITIAL_STATE, { type: 'connect-start' });
    assert.equal(connecting.tag, 'connecting');
    const connected = transition(connecting, { type: 'connect-ready' });
    assert.equal(connected.tag, 'connected');
    assert.equal(connected.missedHeartbeats, 0);
  });

  it('心跳丢失累积，恢复清零回到 connected（有意义的恢复产生新对象）', () => {
    const connected: SessionState = { tag: 'connected', missedHeartbeats: 0, reconnectAttempts: 0 };
    const missed = transition(connected, { type: 'heartbeat-fail' });
    assert.equal(missed.tag, 'heartbeat-missed');
    assert.equal(missed.missedHeartbeats, 1);
    const recovered = transition(missed, { type: 'heartbeat-ok' });
    assert.equal(recovered.tag, 'connected');
    assert.equal(recovered.missedHeartbeats, 0);
    // 从 heartbeat-missed 恢复是状态变化：必须产生新对象让回调触发
    assert.notEqual(recovered, missed);
  });

  it('连续丢失达阈值进入 reconnecting', () => {
    let state: SessionState = { tag: 'connected', missedHeartbeats: 0, reconnectAttempts: 0 };
    for (let i = 0; i < DEFAULT_LIFECYCLE_CONFIG.maxMissedHeartbeats; i += 1) {
      state = transition(state, { type: 'heartbeat-fail' });
    }
    assert.equal(state.tag, 'reconnecting');
    assert.ok(state.lastError !== undefined && state.lastError.includes('心跳失败'));
  });

  it('重连成功回到 connected，失败计数并在次数用尽时终结', () => {
    const reconnecting: SessionState = {
      tag: 'reconnecting', missedHeartbeats: 5, reconnectAttempts: 0,
    };
    const ok = transition(reconnecting, { type: 'reconnect-ok' });
    assert.equal(ok.tag, 'connected');
    assert.equal(ok.reconnectAttempts, 0);

    // 显式步进至次数用尽：reconnect-start 递增计数，reconnect-fail 在
    // 「计数已达上限」时判终结（默认 3 次）
    let state = reconnecting;
    for (let attempt = 1; attempt <= DEFAULT_LIFECYCLE_CONFIG.maxReconnectAttempts; attempt += 1) {
      state = transition(state, { type: 'reconnect-start' });
      assert.equal(state.reconnectAttempts, attempt);
      state = transition(state, { type: 'reconnect-fail', error: 'timeout' });
      if (attempt < DEFAULT_LIFECYCLE_CONFIG.maxReconnectAttempts) {
        assert.equal(state.tag, 'reconnect-failed');
      }
    }
    assert.equal(state.tag, 'reconnect-exhausted');
    assert.equal(state.lastError, 'timeout');
  });

  it('disconnect 进入终结态', () => {
    const connected: SessionState = { tag: 'connected', missedHeartbeats: 0, reconnectAttempts: 0 };
    const disconnected = transition(connected, { type: 'disconnect' });
    assert.equal(disconnected.tag, 'disconnected');
  });
});

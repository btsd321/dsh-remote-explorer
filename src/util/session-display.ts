/**
 * @file 会话状态展示常量
 * @description 基础层纯常量，定义会话生命周期状态的语义色与 locale 键映射。
 *              供入口层面板（plugin-client/）与能力层交接组件（handoff/）共用，
 *              消除跨层重复定义。状态标签集合与 session/lifecycle-state.ts 的
 *              SessionStateTag 一一对应。
 */

/** 状态标签 → 语义色（状态点用；文案走各自 locale） */
export const STATE_COLORS: Record<string, string> = {
  connected: '#22c55e',
  connecting: '#3b82f6',
  idle: '#9ca3af',
  'heartbeat-missed': '#f59e0b',
  reconnecting: '#f59e0b',
  'reconnect-failed': '#f97316',
  'reconnect-exhausted': '#ef4444',
  disconnected: '#9ca3af',
};

/** 状态标签 → locale 键（值字符串与各消费方的 locale key 类型兼容） */
export const STATE_LABEL_KEYS: Record<string, string> = {
  idle: 'stateIdle',
  connecting: 'stateConnecting',
  connected: 'stateConnected',
  'heartbeat-missed': 'stateHeartbeatMissed',
  reconnecting: 'stateReconnecting',
  'reconnect-failed': 'stateReconnectFailed',
  'reconnect-exhausted': 'stateReconnectExhausted',
  disconnected: 'stateDisconnected',
};

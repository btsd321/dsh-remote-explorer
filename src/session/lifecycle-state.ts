/**
 * @file 会话生命周期状态机
 * @description 会话状态的定义与转移规则，实现为**纯函数**——不碰 IO、不持有资源，
 *              便于单独推理与测试。
 *
 * 状态划分借 Zed 的 `remote_client.rs`：它把"心跳丢失"与"正在重连"分成独立状态，
 * 比只有 connected/disconnected 更能表达故障阶段——心跳丢一两次可能只是链路抖动，
 * 与真正进入重连流程是不同处境，UI 与重连决策都需要区分二者。
 *
 * 转移规则集中在 {@link transition}，调用方不得自行改写状态字段。
 */

/** 会话状态标签 */
export type SessionStateTag =
  /** 尚未开始连接 */
  | 'idle'
  /** 正在建立连接与引导 */
  | 'connecting'
  /** 连接就绪，隧道可用 */
  | 'connected'
  /** 心跳丢失若干次，尚未判定断开 */
  | 'heartbeat-missed'
  /** 正在重连 */
  | 'reconnecting'
  /** 某次重连失败，仍有剩余次数 */
  | 'reconnect-failed'
  /** 重连次数用尽，会话终结 */
  | 'reconnect-exhausted'
  /** 用户主动断开 */
  | 'disconnected';

/** 会话状态 */
export interface SessionState {
  /** 状态标签 */
  tag: SessionStateTag;
  /** 连续丢失的心跳次数 */
  missedHeartbeats: number;
  /** 已尝试的重连次数 */
  reconnectAttempts: number;
  /** 最近一次错误消息 */
  lastError?: string;
}

/** 驱动状态机的事件 */
export type SessionEvent =
  /** 开始连接 */
  | { type: 'connect-start' }
  /** 连接就绪 */
  | { type: 'connect-ready' }
  /** 心跳成功 */
  | { type: 'heartbeat-ok' }
  /** 心跳失败 */
  | { type: 'heartbeat-fail' }
  /** 开始一次重连 */
  | { type: 'reconnect-start' }
  /** 重连成功 */
  | { type: 'reconnect-ok' }
  /** 重连失败 */
  | { type: 'reconnect-fail'; error: string }
  /** 连接彻底失败（非重连路径，如首次连接失败） */
  | { type: 'fail'; error: string }
  /** 用户主动断开 */
  | { type: 'disconnect' };

/** 重连与心跳参数 */
export interface LifecycleConfig {
  /** 判定为断开所需的连续心跳丢失次数 */
  maxMissedHeartbeats: number;
  /** 最大重连尝试次数 */
  maxReconnectAttempts: number;
}

/**
 * 默认参数，直接对标 Zed 的常量（`remote_client.rs:160`）。
 *
 * 旧实现 `remote-connection.ts` 的默认重连次数同样是 3，两者一致。
 */
export const DEFAULT_LIFECYCLE_CONFIG: LifecycleConfig = {
  maxMissedHeartbeats: 5,
  maxReconnectAttempts: 3,
};

/** 初始状态 */
export const INITIAL_STATE: SessionState = {
  tag: 'idle',
  missedHeartbeats: 0,
  reconnectAttempts: 0,
};

/**
 * 应用一个事件，得到新状态。
 *
 * 纯函数：不修改入参，不产生副作用。无意义的转移（如在 idle 上收到心跳结果）
 * 原样返回当前状态，而不是抛错——事件可能来自已被取消的定时器，
 * 静默忽略比让调用方到处判状态更简单。
 *
 * @param state - 当前状态
 * @param event - 事件
 * @param config - 生命周期参数
 * @returns 新状态
 */
export function transition(
  state: SessionState,
  event: SessionEvent,
  config: LifecycleConfig = DEFAULT_LIFECYCLE_CONFIG,
): SessionState {
  switch (event.type) {
    case 'connect-start':
      return { tag: 'connecting', missedHeartbeats: 0, reconnectAttempts: 0 };

    case 'connect-ready':
      return { tag: 'connected', missedHeartbeats: 0, reconnectAttempts: 0 };

    case 'heartbeat-ok':
      // 心跳恢复即清零计数：连续性是判定依据，偶发单次失败不该累积
      if (state.tag !== 'connected' && state.tag !== 'heartbeat-missed') return state;
      return { ...state, tag: 'connected', missedHeartbeats: 0 };

    case 'heartbeat-fail': {
      if (state.tag !== 'connected' && state.tag !== 'heartbeat-missed') return state;
      const missed = state.missedHeartbeats + 1;
      if (missed >= config.maxMissedHeartbeats) {
        // 达到阈值只是"该重连了"，是否真的重连由编排层按配置决定
        return {
          ...state,
          tag: 'reconnecting',
          missedHeartbeats: missed,
          lastError: `连续 ${missed} 次心跳失败`,
        };
      }
      return { ...state, tag: 'heartbeat-missed', missedHeartbeats: missed };
    }

    case 'reconnect-start':
      if (!canReconnect(state)) return state;
      return {
        ...state,
        tag: 'reconnecting',
        reconnectAttempts: state.reconnectAttempts + 1,
      };

    case 'reconnect-ok':
      return { tag: 'connected', missedHeartbeats: 0, reconnectAttempts: 0 };

    case 'reconnect-fail':
      if (state.reconnectAttempts >= config.maxReconnectAttempts) {
        return { ...state, tag: 'reconnect-exhausted', lastError: event.error };
      }
      return { ...state, tag: 'reconnect-failed', lastError: event.error };

    case 'fail':
      return { ...state, tag: 'reconnect-exhausted', lastError: event.error };

    case 'disconnect':
      return { ...state, tag: 'disconnected' };
  }
}

/**
 * 判断当前状态是否还能尝试重连。
 *
 * @param state - 当前状态
 * @returns 是否可重连
 */
function canReconnect(state: SessionState): boolean {
  return state.tag === 'heartbeat-missed'
    || state.tag === 'reconnecting'
    || state.tag === 'reconnect-failed';
}

/**
 * 判断状态是否为终结态（不会再自行恢复）。
 *
 * @param state - 当前状态
 * @returns 是否终结
 */
export function isTerminal(state: SessionState): boolean {
  return state.tag === 'reconnect-exhausted' || state.tag === 'disconnected';
}

/**
 * 状态的中文描述，供 CLI 展示。
 *
 * @param state - 当前状态
 * @returns 一行描述
 */
export function describeState(state: SessionState): string {
  switch (state.tag) {
    case 'idle': return '未连接';
    case 'connecting': return '连接中';
    case 'connected': return '已连接';
    case 'heartbeat-missed': return `心跳丢失 ${state.missedHeartbeats} 次`;
    case 'reconnecting': return `重连中（第 ${state.reconnectAttempts} 次）`;
    case 'reconnect-failed': return `重连失败（已试 ${state.reconnectAttempts} 次）`;
    case 'reconnect-exhausted': return `连接已断开：${state.lastError ?? '原因未知'}`;
    case 'disconnected': return '已断开';
  }
}

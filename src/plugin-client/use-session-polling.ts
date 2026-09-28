/**
 * @file 会话轮询自定义 Hook
 * @description 将 ssh-panel / wsl-panel 中几乎逐行相同的三段轮询逻辑（会话列表
 *              2s 轮询、倒计时 1s 滴答、日志增量 1.5s 轮询）提取为共享 Hook，
 *              消除约 80 行重复代码。面板通过 onSessionReady / onSessionError
 *              回调自行决定就绪后的窗口交接行为（桌面端开浮层 vs 浏览器端倒计时）。
 */

import * as React from 'react';
import type { LogEntry } from '../plugin/supervisor.js';
import { fetchSessionLog, fetchSessions, messageOf, type PanelSession } from './api.js';
import { SESSIONS_POLL_MS, LOG_POLL_MS, HANDOFF_COUNTDOWN_SECONDS } from './constants.js';

/** Hook 选项：面板注入的回调，替代内部的窗口交接逻辑 */
export interface UseSessionPollingOptions {
  /**
   * 会话就绪回调。当 pendingNav 指向的会话从 connecting 变为已就绪（url 可用）
   * 时触发，由面板决定后续行为（桌面端 openRemoteWindow、浏览器端 setCountdown）。
   */
  onSessionReady?: (session: PanelSession) => void;
  /**
   * 会话失败回调。当 pendingNav 指向的会话出现 connectError 时触发，
   * 由面板决定是否记录日志或做其他处理。
   */
  onSessionError?: (sessionId: string) => void;
}

/** Hook 返回值：面板渲染所需的全部轮询相关状态 */
export interface UseSessionPollingResult {
  /** 当前会话列表 */
  sessions: PanelSession[];
  /** 最近一次加载错误（空串 = 无错误） */
  loadError: string;
  /** 设置加载错误（面板非轮询操作如断开连接也需要写入此状态） */
  setLoadError: React.Dispatch<React.SetStateAction<string>>;
  /** 当前选中的会话 id（用于日志面板高亮与日志轮询） */
  selectedId: string | null;
  /** 设置选中会话 id */
  setSelectedId: (id: string | null) => void;
  /** 选中会话的增量日志条目 */
  log: LogEntry[];
  /** 待交接导航引用（连接发起时写入，就绪/失败后清除） */
  pendingNav: React.MutableRefObject<{ sessionId: string; mode: 'current' | 'new' | 'window' } | null>;
  /** 同标签自动导航倒计时；null = 无待跳转 */
  countdown: { url: string; seconds: number } | null;
  /** 设置倒计时状态 */
  setCountdown: React.Dispatch<React.SetStateAction<{ url: string; seconds: number } | null>>;
}

/**
 * 封装会话列表轮询、倒计时滴答、日志增量轮询三个 effect 及相关状态。
 *
 * @param options - 面板注入的就绪/失败回调
 * @returns 轮询相关状态与控制函数
 */
export function useSessionPolling(options: UseSessionPollingOptions): UseSessionPollingResult {
  const { onSessionReady, onSessionError } = options;

  // ---- 数据状态 ----
  const [sessions, setSessions] = React.useState<PanelSession[]>([]);
  const [loadError, setLoadError] = React.useState('');
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [log, setLog] = React.useState<LogEntry[]>([]);
  const lastSeq = React.useRef(0);

  // ---- 窗口形态交接 ----
  const pendingNav = React.useRef<{ sessionId: string; mode: 'current' | 'new' | 'window' } | null>(null);
  const [countdown, setCountdown] = React.useState<{ url: string; seconds: number } | null>(null);

  // 用 ref 持有最新回调，避免 effect 依赖变化导致轮询重启
  const onSessionReadyRef = React.useRef(onSessionReady);
  onSessionReadyRef.current = onSessionReady;
  const onSessionErrorRef = React.useRef(onSessionError);
  onSessionErrorRef.current = onSessionError;

  // 会话列表轮询（挂载期 2s 一次）
  React.useEffect(() => {
    let stopped = false;
    const tick = async (): Promise<void> => {
      try {
        const next = await fetchSessions();
        if (stopped) return;
        setSessions(next);
        setLoadError('');
        // 交接：会话就绪后通知面板，由面板按形态分流（桌面端浮层 / 浏览器端倒计时）
        const pending = pendingNav.current;
        if (pending !== null) {
          const ready = next.find(item => item.sessionId === pending.sessionId
            && !item.connecting && item.url !== undefined);
          if (ready?.url !== undefined) {
            // 先通知面板再清除引用，让回调能读到 pendingNav.current.mode
            onSessionReadyRef.current?.(ready);
            pendingNav.current = null;
          } else if (next.some(item => item.sessionId === pending.sessionId
            && item.connectError !== undefined)) {
            onSessionErrorRef.current?.(pending.sessionId);
            pendingNav.current = null;
          }
        }
      } catch (error) {
        if (!stopped) setLoadError(messageOf(error));
      }
    };
    void tick();
    const timer = setInterval(() => { void tick(); }, SESSIONS_POLL_MS);
    return () => { stopped = true; clearInterval(timer); };
  }, []);

  // 倒计时滴答：归零即同标签切入远端（VS Code Connect Current Window 的等价物）
  React.useEffect(() => {
    if (countdown === null) return;
    if (countdown.seconds <= 0) {
      window.location.href = countdown.url;
      return;
    }
    const timer = setTimeout(() => {
      setCountdown(previous => (previous === null ? null : { ...previous, seconds: previous.seconds - 1 }));
    }, 1_000);
    return () => { clearTimeout(timer); };
  }, [countdown]);

  // 选中会话的日志增量轮询（1.5s，?since=seq 追加）
  React.useEffect(() => {
    if (selectedId === null) { setLog([]); lastSeq.current = 0; return; }
    let stopped = false;
    lastSeq.current = 0;
    setLog([]);
    const tick = async (): Promise<void> => {
      try {
        const result = await fetchSessionLog(selectedId, lastSeq.current);
        if (stopped) return;
        if (result.log.length > 0) {
          lastSeq.current = result.log[result.log.length - 1]?.seq ?? lastSeq.current;
          setLog(previous => [...previous, ...result.log]);
        }
      } catch { /* 会话可能刚被移除；下一轮列表刷新会纠正选中态 */ }
    };
    void tick();
    const timer = setInterval(() => { void tick(); }, LOG_POLL_MS);
    return () => { stopped = true; clearInterval(timer); };
  }, [selectedId]);

  return {
    sessions,
    loadError,
    setLoadError,
    selectedId,
    setSelectedId,
    log,
    pendingNav,
    countdown,
    setCountdown,
  };
}

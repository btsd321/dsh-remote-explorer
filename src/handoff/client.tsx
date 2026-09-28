/**
 * @file handoff bundle 浏览器半（运行在远端 dsh 页面内）
 * @description VS Code 状态栏远端标识的等价物：侧栏底部 `sidebar.footer.action`
 *              槽里一枚状态 pill（主机别名 + 状态点，与「设置」按钮同排由壳排版
 *              ——fixed 自定位会压住设置齿轮，交给壳排版从结构上排除冲突），
 *              点开是管理菜单——连接状态、进度日志尾、三个动作：返回本地管理页 /
 *              关闭远程连接并返回 / 停止远端 dsh 并返回。
 *
 * 数据全部同源 fetch 本 bundle 宿主半的路由（`/api/dsh-remote-handoff/*`，
 * 远端 dsh 自身 Cookie 鉴权），宿主半再经反向隧道回调本机监督器。
 *
 * 两条降级路径：
 * - meta 读不到（宿主半材料缺失/路由不在）→ 整个 pill 不渲染，远端页面零感知
 * - managerUrl 缺省（CLI 形态会话）或协议版本不匹配 → 菜单只读 + 说明文案
 *
 * 「关闭/停止并返回」是 navigate-then-act：断开会立刻杀死经隧道服务的本页面，
 * 所以先同标签导航回本机管理页（带 intent hash），由管理页加载后执行——
 * VS Code「Close Remote Connection 后窗口重载回本地」的拓扑等价物。
 *
 * 样式纪律与本地面板一致：不猜设计令牌名，中性色一律 inherit/rgba 半透明灰，
 * 仅状态点用语义色；深浅主题都成立。
 */

import * as React from 'react';
import type { ReactNode } from 'react';
import type { Context as ClientContext } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-locale/client';
import type {} from '@deepseek-ai/dsh-client-ui-layout/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client';
import {
  HANDOFF_PROTOCOL_VERSION, HANDOFF_ROUTE_PREFIX, type HandoffMeta,
} from './protocol.js';
import { STATE_COLORS, STATE_LABEL_KEYS } from '../util/session-display.js';

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** 远端交接组件文案 */
    'dshRemoteHandoff': HandoffLocaleKey;
  }
}

/** 文案键集（zh/en 同键） */
type HandoffLocaleKey =
  | 'pill' | 'menuTitle' | 'log' | 'logEmpty'
  | 'managerOpen' | 'managerClose' | 'managerStop'
  | 'managerMissing' | 'versionMismatch' | 'managerUnreachable'
  | 'stateConnecting' | 'stateConnected' | 'stateHeartbeatMissed'
  | 'stateReconnecting' | 'stateReconnectFailed' | 'stateReconnectExhausted'
  | 'stateDisconnected' | 'stateIdle';

const zh: Record<HandoffLocaleKey, string> = {
  pill: '远程会话（本机管理）',
  menuTitle: '本机连接管理',
  log: '进度日志',
  logEmpty: '暂无日志',
  managerOpen: '返回本地管理页',
  managerClose: '关闭远程连接并返回',
  managerStop: '停止远端 dsh 并返回',
  managerMissing: '本机管理页地址未知（CLI 形态会话）——请用 CLI 的 status/kill 管理',
  versionMismatch: '本机与远端交接组件版本不一致，菜单降级为只读',
  managerUnreachable: '本机管理通道不可达（本地 dsh 可能已退出）',
  stateConnecting: '连接中',
  stateConnected: '已连接',
  stateHeartbeatMissed: '心跳丢失',
  stateReconnecting: '重连中',
  stateReconnectFailed: '重连失败',
  stateReconnectExhausted: '重连次数用尽',
  stateDisconnected: '已断开',
  stateIdle: '未开始',
};

const en: Record<HandoffLocaleKey, string> = {
  pill: 'Remote session (managed locally)',
  menuTitle: 'Local connection manager',
  log: 'Progress log',
  logEmpty: 'No log yet',
  managerOpen: 'Back to local manager',
  managerClose: 'Close remote connection and return',
  managerStop: 'Stop remote dsh and return',
  managerMissing: 'Local manager URL unknown (CLI session) — manage it via CLI status/kill',
  versionMismatch: 'Handoff protocol mismatch; menu is read-only',
  managerUnreachable: 'Local manager unreachable (local dsh may have exited)',
  stateConnecting: 'Connecting',
  stateConnected: 'Connected',
  stateHeartbeatMissed: 'Heartbeat missed',
  stateReconnecting: 'Reconnecting',
  stateReconnectFailed: 'Reconnect failed',
  stateReconnectExhausted: 'Reconnect exhausted',
  stateDisconnected: 'Disconnected',
  stateIdle: 'Idle',
};

/** locale 命名空间 */
const LOCALE_NS = 'dshRemoteHandoff';

/** 状态轮询间隔（毫秒，与本地面板一致） */
const STATE_POLL_MS = 2_000;

/** 菜单打开时日志增量轮询间隔 */
const LOG_POLL_MS = 1_500;

/** 本机监督器经反向隧道回报的状态快照（裁剪形状） */
interface HandoffState {
  sessionId: string;
  hostAlias: string;
  state: { tag: string };
  connecting: boolean;
  localPort?: number;
}

/** 一条日志（与本机 LogEntry 同形状） */
interface HandoffLogEntry {
  seq: number;
  ts: string;
  kind: string;
  text: string;
}

export const name = 'dsh-remote-handoff';

export const inject = ['slots', 'locale'];

/**
 * 浏览器半激活入口。
 *
 * @param ctx - 远端页面的 cordis 上下文
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(
    () => ctx.locale.register(LOCALE_NS, { zh, en }),
    'dsh-remote-handoff: locales',
  );
  // 侧栏底部动作位（设置按钮旁）：壳负责排版，永不与设置齿轮重叠；
  // 窄栏（rail）形态组件自收 wide=false，只渲染状态点
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'dsh-remote-handoff',
    locale: LOCALE_NS,
  }, HandoffPill));
}

/** pill 的 props：locale 面由 slots 框架注入，wide 由侧栏壳注入（列状态） */
interface HandoffPillProps {
  t: (key: HandoffLocaleKey) => string;
  /** 侧栏是否宽栏（false = 56px rail，只渲染状态点） */
  wide: boolean;
}

/**
 * 状态 pill 与管理菜单。
 *
 * @param props - locale 注入面
 * @returns overlay 内容；meta 不可用时不渲染
 */
function HandoffPill(props: HandoffPillProps): ReactNode {
  const { t, wide } = props;
  const [meta, setMeta] = React.useState<HandoffMeta | null | undefined>(undefined);
  const [state, setState] = React.useState<HandoffState | null>(null);
  const [unreachable, setUnreachable] = React.useState(false);
  const [open, setOpen] = React.useState(false);
  const [log, setLog] = React.useState<HandoffLogEntry[]>([]);
  const [menuPos, setMenuPos] = React.useState<{ left: number; bottom: number } | null>(null);
  const lastSeq = React.useRef(0);
  const logBoxRef = React.useRef<HTMLDivElement | null>(null);
  const buttonRef = React.useRef<HTMLButtonElement | null>(null);

  // meta 只拉一次：不可达则整个组件静默退场（远端页面无感知）
  React.useEffect(() => {
    let stopped = false;
    void fetch(`${HANDOFF_ROUTE_PREFIX}/meta`)
      .then(response => (response.ok ? response.json() as Promise<HandoffMeta> : Promise.reject(new Error())))
      .then(value => { if (!stopped) setMeta(value); })
      .catch(() => { if (!stopped) setMeta(null); });
    return () => { stopped = true; };
  }, []);

  // 状态轮询（挂载期 2s 一次）；502 = 本机通道不可达，菜单给说明
  React.useEffect(() => {
    if (meta === undefined || meta === null) return;
    let stopped = false;
    const tick = async (): Promise<void> => {
      try {
        const response = await fetch(`${HANDOFF_ROUTE_PREFIX}/state?id=${encodeURIComponent(meta.sessionId)}`);
        if (stopped) return;
        if (response.ok) {
          setState(await response.json() as HandoffState);
          setUnreachable(false);
        } else if (response.status === 502) {
          setUnreachable(true);
        }
      } catch { /* 网络抖动等下一轮 */ }
    };
    void tick();
    const timer = setInterval(() => { void tick(); }, STATE_POLL_MS);
    return () => { stopped = true; clearInterval(timer); };
  }, [meta]);

  // 菜单打开时增量拉日志
  React.useEffect(() => {
    if (!open || state === null) { setLog([]); lastSeq.current = 0; return; }
    let stopped = false;
    lastSeq.current = 0;
    setLog([]);
    const tick = async (): Promise<void> => {
      try {
        const response = await fetch(
          `${HANDOFF_ROUTE_PREFIX}/log?id=${encodeURIComponent(state.sessionId)}&since=${lastSeq.current}`,
        );
        if (stopped || !response.ok) return;
        const body = await response.json() as { log: HandoffLogEntry[] };
        if (body.log.length > 0) {
          lastSeq.current = body.log[body.log.length - 1]?.seq ?? lastSeq.current;
          setLog(previous => [...previous, ...body.log]);
        }
      } catch { /* 会话可能正在消失，下一轮状态轮询会纠正 */ }
    };
    void tick();
    const timer = setInterval(() => { void tick(); }, LOG_POLL_MS);
    return () => { stopped = true; clearInterval(timer); };
  }, [open, state]);

  React.useEffect(() => {
    const box = logBoxRef.current;
    if (box !== null) box.scrollTop = box.scrollHeight;
  }, [log]);

  if (meta === undefined || meta === null) return null;

  const readOnly = meta.managerUrl === undefined
    || meta.protocolVersion !== HANDOFF_PROTOCOL_VERSION;
  const tag = state?.connecting === true ? 'connecting' : state?.state.tag ?? 'idle';
  const dotColor = STATE_COLORS[tag] ?? '#9ca3af';
  const label = t((STATE_LABEL_KEYS[tag] ?? 'stateIdle') as HandoffLocaleKey);

  const intent = (hash: string): void => {
    if (meta.managerUrl === undefined || state === null) return;
    // navigate-then-act：本页随隧道断开而死，动作交给管理页加载后执行
    window.location.href = `${meta.managerUrl}/#${hash}=${encodeURIComponent(state.sessionId)}`;
  };

  const buttonStyle: React.CSSProperties = {
    background: 'transparent',
    color: 'inherit',
    border: '1px solid rgba(127,127,127,0.5)',
    borderRadius: 6,
    padding: '4px 10px',
    cursor: 'pointer',
    fontSize: 12,
    width: '100%',
    textAlign: 'left',
  };

  // 菜单按按钮 rect 测量后 fixed 定位：槽位在侧栏内部，absolute 会被侧栏
  // overflow 裁剪；fixed + 视口坐标既不被裁，也天然避开设置按钮所在行
  const toggle = (): void => {
    if (open) {
      setOpen(false);
      return;
    }
    const rect = buttonRef.current?.getBoundingClientRect();
    setMenuPos(rect === undefined
      ? { left: 8, bottom: 56 }
      : {
        left: Math.max(8, Math.min(rect.right + 8, window.innerWidth - 372)),
        bottom: Math.max(8, window.innerHeight - rect.top),
      });
    setOpen(true);
  };

  return (
    <>
      {open && menuPos !== null
        ? (
          <div style={{
            position: 'fixed', left: menuPos.left, bottom: menuPos.bottom,
            width: 360, maxHeight: '70vh', overflowY: 'auto',
            display: 'flex', flexDirection: 'column', gap: 10,
            padding: 12,
            background: 'rgba(30,30,30,0.92)', color: '#e5e5e5',
            border: '1px solid rgba(127,127,127,0.4)', borderRadius: 8,
            boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
            zIndex: 1300, fontFamily: 'inherit',
          }}
          >
            <strong style={{ fontSize: 13 }}>{t('menuTitle')}</strong>
            {unreachable
              ? <span style={{ fontSize: 12, color: '#f59e0b' }}>{t('managerUnreachable')}</span>
              : null}
            {meta.protocolVersion !== HANDOFF_PROTOCOL_VERSION
              ? <span style={{ fontSize: 12, color: '#f59e0b' }}>{t('versionMismatch')}</span>
              : null}
            {meta.managerUrl === undefined
              ? <span style={{ fontSize: 12, opacity: 0.75 }}>{t('managerMissing')}</span>
              : null}
            {state !== null
              ? (
                <span style={{ fontSize: 12, opacity: 0.85 }}>
                  {state.hostAlias}
                  {' · '}
                  {label}
                  {state.localPort !== undefined ? ` · 127.0.0.1:${state.localPort}` : ''}
                </span>
              )
              : null}
            <strong style={{ fontSize: 12 }}>{t('log')}</strong>
            <div ref={logBoxRef} style={{
              height: 160, overflowY: 'auto', whiteSpace: 'pre-wrap',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
              fontSize: 11, lineHeight: 1.5, padding: '4px 6px',
              border: '1px solid rgba(127,127,127,0.35)', borderRadius: 6,
            }}
            >
              {log.length === 0
                ? <span style={{ opacity: 0.55 }}>{t('logEmpty')}</span>
                : log.map(entry => (
                  <div key={entry.seq}>
                    <span style={{ opacity: 0.55 }}>{entry.ts.slice(11, 19)}</span>
                    {' '}
                    <span style={entry.kind === 'error' ? { color: '#ef4444' } : undefined}>
                      {entry.text}
                    </span>
                  </div>
                ))}
            </div>
            {readOnly
              ? null
              : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <button type="button" style={buttonStyle}
                    onClick={() => {
                      // 桌面端 webview 里 window.open 被 Electron guest 默认 deny；
                      // 改用 location.href 导航触发 will-navigate → handleIntentUrl
                      // 截获（无 hash = 纯返回意图 → closeRemoteWindow）。
                      // 浏览器端同理：同标签导航回本机管理页根路径
                      if (meta.managerUrl !== undefined) window.location.href = meta.managerUrl;
                    }}>
                    {t('managerOpen')}
                  </button>
                  <button type="button" style={buttonStyle}
                    onClick={() => { intent('handoff-disconnect'); }}>
                    {t('managerClose')}
                  </button>
                  <button type="button" style={buttonStyle}
                    onClick={() => { intent('handoff-stop'); }}>
                    {t('managerStop')}
                  </button>
                </div>
              )}
          </div>
        )
        : null}
      <button
        ref={buttonRef}
        type="button"
        title={t('pill')}
        onClick={toggle}
        style={{
          display: 'flex', alignItems: 'center', gap: 6,
          width: '100%', padding: wide ? '6px 10px' : '6px 0',
          justifyContent: wide ? 'flex-start' : 'center',
          background: 'transparent', color: 'inherit', border: 'none',
          cursor: 'pointer', fontSize: 12, fontFamily: 'inherit',
        }}
      >
        <span style={{
          width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
          backgroundColor: dotColor, display: 'inline-block',
        }}
        />
        {wide
          ? (
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {state?.hostAlias ?? '…'}
            </span>
          )
          : null}
      </button>
    </>
  );
}

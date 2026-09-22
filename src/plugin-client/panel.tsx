/**
 * @file 远程会话管理面板（全局面板内容，main 槽 keyed 注册）
 * @description 单页三区：连接表单、会话表、进度日志。数据全部来自宿主
 *              /api/dsh-remote-explorer/* 路由（同源 fetch 自动带 dsh 会话
 *              Cookie），列表 2s 轮询、选中会话的日志 1.5s 增量轮询。
 *
 * 「打开」链接 = session.url（隧道转发后的**远端 dsh 界面**，含远端访问
 * 令牌），target=_blank 弹新页——语义等同 CLI 把 URL 打进终端后用户点开。
 *
 * 样式纪律：不猜 dsh 设计令牌名（错名 = 文字不可见，参考插件踩过 *-fill
 * 当文字色的坑）——中性色一律 inherit/rgba 半透明灰，仅状态点用语义色；
 * 深浅主题都成立。
 *
 * 凭据纪律：密码框旁明示「仅存宿主进程内存」；提交成功或失败后立即清掉
 * 本地 state 引用（宿主侧同样不落盘不进日志）。
 */

import * as React from 'react';
import type { ReactNode } from 'react';
import type { SshHostSummary } from '../hosts/ssh-config-parser.js';
import type { LogEntry } from '../plugin/supervisor.js';
import type { RemoteExplorerLocaleKey } from './locales.js';
import {
  ApiError, fetchHosts, fetchSessionLog, fetchSessions, postConnect, postDisconnect,
  type PanelSession,
} from './api.js';

/** 会话列表轮询间隔（毫秒） */
const SESSIONS_POLL_MS = 2_000;

/** 选中会话的日志增量轮询间隔（毫秒） */
const LOG_POLL_MS = 1_500;

/** localStorage 里「上次远端目录」的键前缀（按主机别名记忆） */
const LAST_CWD_KEY_PREFIX = 'dsh-remote-explorer:lastCwd:';

/** 状态标签 → 语义色（状态点用；文案走 locale） */
const STATE_COLORS: Record<string, string> = {
  connected: '#22c55e',
  connecting: '#3b82f6',
  idle: '#9ca3af',
  'heartbeat-missed': '#f59e0b',
  reconnecting: '#f59e0b',
  'reconnect-failed': '#f97316',
  'reconnect-exhausted': '#ef4444',
  disconnected: '#9ca3af',
};

/** 状态标签 → locale 键 */
const STATE_LABEL_KEYS: Record<string, RemoteExplorerLocaleKey> = {
  idle: 'stateIdle',
  connecting: 'stateConnecting',
  connected: 'stateConnected',
  'heartbeat-missed': 'stateHeartbeatMissed',
  reconnecting: 'stateReconnecting',
  'reconnect-failed': 'stateReconnectFailed',
  'reconnect-exhausted': 'stateReconnectExhausted',
  disconnected: 'stateDisconnected',
};

/** 面板 props：locale 面由 slots 框架注入（注册时声明了 locale 命名空间） */
export interface SessionPanelProps {
  /** 命名空间绑定的翻译函数 */
  t: (key: RemoteExplorerLocaleKey) => string;
}

/**
 * 把未知异常归一成展示文本。
 *
 * @param error - 捕获值
 * @returns 中文消息
 */
function messageOf(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * 远程会话管理面板。
 *
 * @param props - locale 注入面
 * @returns 面板内容
 */
export function SessionPanel(props: SessionPanelProps): ReactNode {
  const { t } = props;

  // ---- 连接表单状态 ----
  const [host, setHost] = React.useState('');
  const [cwd, setCwd] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [privateKey, setPrivateKey] = React.useState('');
  const [localPort, setLocalPort] = React.useState('');
  const [nodeVersion, setNodeVersion] = React.useState('');
  const [dshVersion, setDshVersion] = React.useState('');
  const [forceRestart, setForceRestart] = React.useState(false);
  const [refreshMirrors, setRefreshMirrors] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [formError, setFormError] = React.useState('');

  // ---- 数据状态 ----
  const [hosts, setHosts] = React.useState<SshHostSummary[]>([]);
  const [sessions, setSessions] = React.useState<PanelSession[]>([]);
  const [loadError, setLoadError] = React.useState('');
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [log, setLog] = React.useState<LogEntry[]>([]);
  const [stopRemote, setStopRemote] = React.useState(true);
  const lastSeq = React.useRef(0);
  const logBoxRef = React.useRef<HTMLDivElement | null>(null);

  // 主机列表：挂载时拉一次；「刷新」按钮带 refresh=1 让宿主重读 ssh config
  const loadHosts = React.useCallback(async (refresh: boolean): Promise<void> => {
    try {
      setHosts(await fetchHosts(refresh));
    } catch (error) {
      setLoadError(messageOf(error));
    }
  }, []);
  React.useEffect(() => { void loadHosts(false); }, [loadHosts]);

  // 会话列表轮询（挂载期 2s 一次）
  React.useEffect(() => {
    let stopped = false;
    const tick = async (): Promise<void> => {
      try {
        const next = await fetchSessions();
        if (stopped) return;
        setSessions(next);
        setLoadError('');
      } catch (error) {
        if (!stopped) setLoadError(messageOf(error));
      }
    };
    void tick();
    const timer = setInterval(() => { void tick(); }, SESSIONS_POLL_MS);
    return () => { stopped = true; clearInterval(timer); };
  }, []);

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

  // 日志自动滚底
  React.useEffect(() => {
    const box = logBoxRef.current;
    if (box !== null) box.scrollTop = box.scrollHeight;
  }, [log]);

  // 换主机时带出上次用过的远端目录（localStorage 记忆）
  const onHostChange = (value: string): void => {
    setHost(value);
    try {
      setCwd(localStorage.getItem(`${LAST_CWD_KEY_PREFIX}${value}`) ?? '');
    } catch { /* 隐私模式等场景 localStorage 不可用，跳过记忆 */ }
  };

  const onConnect = async (): Promise<void> => {
    if (host.trim() === '' || busy) return;
    setBusy(true);
    setFormError('');
    try {
      const port = Number.parseInt(localPort, 10);
      const session = await postConnect({
        hostAlias: host.trim(),
        ...(cwd.trim() !== '' ? { cwd: cwd.trim() } : {}),
        ...(password !== '' ? { password } : {}),
        ...(privateKey.trim() !== '' ? { privateKey: privateKey.trim() } : {}),
        ...(Number.isFinite(port) && port > 0 ? { localPort: port } : {}),
        ...(nodeVersion.trim() !== '' ? { nodeVersion: nodeVersion.trim() } : {}),
        ...(dshVersion.trim() !== '' ? { dshVersion: dshVersion.trim() } : {}),
        forceRestart,
        refreshMirrors,
      });
      try {
        localStorage.setItem(`${LAST_CWD_KEY_PREFIX}${host.trim()}`, cwd.trim());
      } catch { /* 记忆失败不影响连接 */ }
      setSelectedId(session.sessionId);
    } catch (error) {
      setFormError(messageOf(error));
    } finally {
      // 无论成败立即丢弃密码引用（宿主侧也只存内存）
      setPassword('');
      setBusy(false);
    }
  };

  const onDisconnect = async (target: string): Promise<void> => {
    setLoadError('');
    try {
      await postDisconnect(target, stopRemote);
    } catch (error) {
      setLoadError(messageOf(error));
    }
  };

  const inputStyle: React.CSSProperties = {
    background: 'transparent',
    color: 'inherit',
    border: '1px solid rgba(127,127,127,0.4)',
    borderRadius: 6,
    padding: '4px 8px',
    minWidth: 0,
  };
  const buttonStyle: React.CSSProperties = {
    background: 'transparent',
    color: 'inherit',
    border: '1px solid rgba(127,127,127,0.5)',
    borderRadius: 6,
    padding: '4px 12px',
    cursor: 'pointer',
  };

  // 全局面板自带页头（settings 弹窗时代标题由设置壳显示，迁出后自己给）；
  // 根容器全高滚动：中央列高度由 layout 决定，内容超长时面板内滚动
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 16,
      padding: '16px 20px', height: '100%', overflowY: 'auto', boxSizing: 'border-box',
    }}>
      <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>{t('nav')}</h2>
      <p style={{ margin: 0, opacity: 0.75, fontSize: 13 }}>{t('sectionIntro')}</p>

      {/* ---- 连接表单 ---- */}
      <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: '1 1 220px' }}>
            <span style={{ fontSize: 12, opacity: 0.75 }}>{t('host')}</span>
            <span style={{ display: 'flex', gap: 4 }}>
              <input
                list="dsh-remote-explorer-hosts"
                value={host}
                placeholder={t('hostPlaceholder')}
                style={{ ...inputStyle, flex: 1 }}
                onChange={event => onHostChange(event.target.value)}
              />
              <button type="button" style={buttonStyle} title={t('refreshHosts')}
                onClick={() => { void loadHosts(true); }}>↻</button>
            </span>
          </label>
          <datalist id="dsh-remote-explorer-hosts">
            {hosts.map(item => (
              <option key={item.alias} value={item.alias}>
                {`${item.user === '' ? '' : `${item.user}@`}${item.hostName}:${item.port}`}
              </option>
            ))}
          </datalist>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: '2 1 300px' }}>
            <span style={{ fontSize: 12, opacity: 0.75 }}>{t('cwd')}</span>
            <input value={cwd} placeholder={t('cwdPlaceholder')} style={inputStyle}
              onChange={event => setCwd(event.target.value)} />
          </label>
        </div>

        <details>
          <summary style={{ cursor: 'pointer', fontSize: 13, opacity: 0.75 }}>{t('advanced')}</summary>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 8, marginTop: 8 }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span style={{ fontSize: 12, opacity: 0.75 }}>{t('localPort')}</span>
              <input value={localPort} inputMode="numeric" style={inputStyle}
                onChange={event => setLocalPort(event.target.value)} />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span style={{ fontSize: 12, opacity: 0.75 }}>{t('privateKey')}</span>
              <input value={privateKey} style={inputStyle}
                onChange={event => setPrivateKey(event.target.value)} />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span style={{ fontSize: 12, opacity: 0.75 }}>{t('nodeVersion')}</span>
              <input value={nodeVersion} placeholder="v24.20.0" style={inputStyle}
                onChange={event => setNodeVersion(event.target.value)} />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span style={{ fontSize: 12, opacity: 0.75 }}>{t('dshVersion')}</span>
              <input value={dshVersion} style={inputStyle}
                onChange={event => setDshVersion(event.target.value)} />
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
              <input type="checkbox" checked={forceRestart}
                onChange={event => setForceRestart(event.target.checked)} />
              {t('forceRestart')}
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
              <input type="checkbox" checked={refreshMirrors}
                onChange={event => setRefreshMirrors(event.target.checked)} />
              {t('refreshMirrors')}
            </label>
          </div>
        </details>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 2, maxWidth: 420 }}>
          <span style={{ fontSize: 12, opacity: 0.75 }}>{t('password')}</span>
          <input type="password" value={password} autoComplete="off" style={inputStyle}
            onChange={event => setPassword(event.target.value)} />
          <span style={{ fontSize: 11, opacity: 0.6 }}>{t('passwordWarning')}</span>
        </label>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button type="button" style={{ ...buttonStyle, fontWeight: 600 }}
            disabled={busy || host.trim() === ''}
            onClick={() => { void onConnect(); }}>
            {busy ? t('connecting') : t('connect')}
          </button>
          {formError !== ''
            ? <span style={{ color: '#ef4444', fontSize: 13 }}>{t('connectError')}：{formError}</span>
            : null}
        </div>
      </section>

      {/* ---- 会话表 ---- */}
      <section>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
          <strong style={{ fontSize: 14 }}>{t('sessions')}</strong>
          <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, opacity: 0.75 }}>
            <input type="checkbox" checked={stopRemote}
              onChange={event => setStopRemote(event.target.checked)} />
            {t('stopRemote')}
          </label>
        </div>
        {loadError !== ''
          ? <div style={{ color: '#ef4444', fontSize: 13, marginBottom: 6 }}>{t('loadError')}：{loadError}</div>
          : null}
        {sessions.length === 0
          ? <div style={{ fontSize: 13, opacity: 0.6 }}>{t('noSessions')}</div>
          : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {sessions.map(session => renderSessionRow(session, selectedId, t, {
                onSelect: setSelectedId,
                onDisconnect: target => { void onDisconnect(target); },
              }))}
            </div>
          )}
      </section>

      {/* ---- 进度日志 ---- */}
      <section>
        <strong style={{ fontSize: 14 }}>{t('log')}</strong>
        <div ref={logBoxRef} style={{
          marginTop: 6, height: 240, overflowY: 'auto', whiteSpace: 'pre-wrap',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          fontSize: 12, lineHeight: 1.5, padding: '6px 8px',
          border: '1px solid rgba(127,127,127,0.35)', borderRadius: 6,
        }}>
          {selectedId === null || log.length === 0
            ? <span style={{ opacity: 0.55 }}>{t('logEmpty')}</span>
            : log.map(entry => (
              <div key={entry.seq}>
                <span style={{ opacity: 0.55 }}>{entry.ts.slice(11, 19)}</span>
                {' '}
                <span style={{ opacity: 0.75 }}>[{entry.kind}]</span>
                {' '}
                <span style={entry.kind === 'error' ? { color: '#ef4444' } : undefined}>{entry.text}</span>
              </div>
            ))}
        </div>
      </section>
    </div>
  );
}

/** 行回调集合 */
interface RowActions {
  /** 选中看日志 */
  onSelect: (sessionId: string) => void;
  /** 断开 */
  onDisconnect: (target: string) => void;
}

/**
 * 渲染一行会话。
 *
 * @param session - 面板会话对象
 * @param selectedId - 当前选中（高亮）
 * @param t - 翻译函数
 * @param actions - 行回调
 * @returns 行内容
 */
function renderSessionRow(
  session: PanelSession,
  selectedId: string | null,
  t: (key: RemoteExplorerLocaleKey) => string,
  actions: RowActions,
): ReactNode {
  const stateTag = session.connecting ? 'connecting' : session.state.tag;
  const stateLabel = t(STATE_LABEL_KEYS[stateTag] ?? 'stateIdle');
  const stateColor = STATE_COLORS[stateTag] ?? '#9ca3af';
  const missingKeys = session.missingKeyEnvs ?? [];
  return (
    <div
      key={session.sessionId}
      onClick={() => actions.onSelect(session.sessionId)}
      style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: '6px 8px',
        border: '1px solid rgba(127,127,127,0.3)', borderRadius: 6, cursor: 'pointer',
        background: session.sessionId === selectedId ? 'rgba(127,127,127,0.12)' : 'transparent',
        flexWrap: 'wrap',
      }}
    >
      <span title={stateLabel} style={{
        width: 9, height: 9, borderRadius: '50%', flexShrink: 0,
        backgroundColor: stateColor, display: 'inline-block',
      }} />
      <span style={{ fontWeight: 600, fontSize: 13 }}>{session.hostAlias}</span>
      <span style={{ fontSize: 12, opacity: 0.7 }}>
        {session.remoteCwd === '' ? '~' : session.remoteCwd}
      </span>
      <span style={{ fontSize: 12, opacity: 0.7 }}>{stateLabel}</span>
      {session.localPort !== undefined
        ? <span style={{ fontSize: 12, opacity: 0.7 }}>127.0.0.1:{session.localPort}</span>
        : null}
      {session.external === true
        ? <span style={{ fontSize: 11, opacity: 0.6 }}>{t('external')}</span>
        : null}
      {session.connectError !== undefined
        ? <span style={{ fontSize: 12, color: '#ef4444' }}>{session.connectError}</span>
        : null}
      {missingKeys.length > 0
        ? <span style={{ fontSize: 11, color: '#f59e0b' }} title={missingKeys.join(', ')}>
          {t('missingKeys')}: {missingKeys.join(', ')}
        </span>
        : null}
      <span style={{ flex: 1 }} />
      {session.url !== undefined
        ? (
          <a href={session.url} target="_blank" rel="noreferrer"
            onClick={event => event.stopPropagation()}
            style={{ fontSize: 13 }}>
            {t('open')} ↗
          </a>
        )
        : null}
      {session.external === true
        ? null
        : (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              actions.onDisconnect(session.sessionId);
            }}
            style={{
              background: 'transparent', color: 'inherit', fontSize: 12,
              border: '1px solid rgba(127,127,127,0.5)', borderRadius: 6,
              padding: '2px 8px', cursor: 'pointer',
            }}
          >
            {t('disconnect')}
          </button>
        )}
    </div>
  );
}

/**
 * @file WSL 远程会话管理面板
 * @description 专管 WSL（Windows Subsystem for Linux）传输类型的连接表单、
 *              会话表与进度日志。布局与 SSH 面板类似但简化：无密码/私钥字段，
 *              以发行版下拉选择替代主机别名输入。数据全部来自宿主
 *              /api/dsh-remote-explorer/* 路由（同源 fetch 自动带 dsh 会话
 *              Cookie），列表 2s 轮询、选中会话的日志 1.5s 增量轮询。
 *
 * 窗口形态分流逻辑与 SSH 面板一致（桌面端整窗浮层、浏览器端双入口）。
 * 连接时 postConnect 传 transportType='wsl' + distroName + wslUser。
 *
 * 样式纪律同 ssh-panel.tsx：inherit/rgba 半透明灰，不猜设计令牌名。
 */

import * as React from 'react';
import type { ReactNode } from 'react';
import type { LogEntry } from '../plugin/supervisor.js';
import type { RemoteExplorerLocaleKey } from './locales.js';
import {
  ApiError, fetchSessionLog, fetchSessions, fetchWslDistros, postConnect, postDisconnect,
  type PanelSession, type WslDistroSummary,
} from './api.js';
import { isDesktopShell } from './desktop-bridge.js';
import { openRemoteWindow, OVERLAY_INTENT_ORIGIN } from './remote-window.js';
import { renderSessionRow } from './ssh-panel.js';
import { createLogger } from '../util/logger.js';

const logger = createLogger('wsl-panel');

/** 会话列表轮询间隔（毫秒） */
const SESSIONS_POLL_MS = 2_000;

/** 选中会话的日志增量轮询间隔（毫秒） */
const LOG_POLL_MS = 1_500;

/** 当前标签形态就绪后的自动导航倒计时（秒，可取消） */
const HANDOFF_COUNTDOWN_SECONDS = 3;

/** localStorage 里「上次远端目录」的键前缀（按发行版记忆） */
const LAST_CWD_KEY_PREFIX = 'dsh-remote-explorer:wsl:lastCwd:';

/** 是否桌面壳（preload 注入先于一切脚本，页面生命周期内不变，模块级算一次） */
const DESKTOP = isDesktopShell();

/** 面板 props：locale 面由 slots 框架注入 */
export interface WslSessionPanelProps {
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
 * WSL 远程会话管理面板。
 *
 * @param props - locale 注入面
 * @returns 面板内容
 */
export function WslSessionPanel(props: WslSessionPanelProps): ReactNode {
  const { t } = props;

  // ---- 连接表单状态 ----
  const [distroName, setDistroName] = React.useState('');
  const [cwd, setCwd] = React.useState('');
  const [wslUser, setWslUser] = React.useState('');
  const [localPort, setLocalPort] = React.useState('');
  const [nodeVersion, setNodeVersion] = React.useState('');
  const [dshVersion, setDshVersion] = React.useState('');
  const [forceRestart, setForceRestart] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [formError, setFormError] = React.useState('');

  // ---- 数据状态 ----
  const [distros, setDistros] = React.useState<WslDistroSummary[]>([]);
  const [sessions, setSessions] = React.useState<PanelSession[]>([]);
  const [loadError, setLoadError] = React.useState('');
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [log, setLog] = React.useState<LogEntry[]>([]);
  const [stopRemote, setStopRemote] = React.useState(true);
  const lastSeq = React.useRef(0);
  const logBoxRef = React.useRef<HTMLDivElement | null>(null);

  // ---- 窗口形态交接 ----
  const pendingNav = React.useRef<{ sessionId: string; mode: 'current' | 'new' | 'window' } | null>(null);
  const [countdown, setCountdown] = React.useState<{ url: string; seconds: number } | null>(null);

  // 发行版列表：挂载时拉一次；「刷新」按钮带 refresh=1
  const loadDistros = React.useCallback(async (refresh: boolean): Promise<void> => {
    try {
      setDistros(await fetchWslDistros(refresh));
    } catch (error) {
      setLoadError(messageOf(error));
    }
  }, []);
  React.useEffect(() => { void loadDistros(false); }, [loadDistros]);

  // 会话列表轮询（挂载期 2s 一次）
  React.useEffect(() => {
    let stopped = false;
    const tick = async (): Promise<void> => {
      try {
        const next = await fetchSessions();
        if (stopped) return;
        setSessions(next);
        setLoadError('');
        // 交接：会话就绪后按形态分流
        const pending = pendingNav.current;
        if (pending !== null) {
          const ready = next.find(item => item.sessionId === pending.sessionId
            && !item.connecting && item.url !== undefined);
          if (ready?.url !== undefined) {
            // 会话就绪：一次性日志 + 触发窗口交接
            logger.info('会话就绪，触发窗口交接', { mode: pending.mode, url: ready.url, sessionId: ready.sessionId });
            pendingNav.current = null;
            if (pending.mode === 'window') {
              openRemoteWindow({
                sessionId: ready.sessionId,
                url: ready.url,
                hostAlias: ready.hostAlias,
              });
            } else if (pending.mode === 'current') {
              setCountdown({ url: ready.url, seconds: HANDOFF_COUNTDOWN_SECONDS });
            }
          } else if (next.some(item => item.sessionId === pending.sessionId
            && item.connectError !== undefined)) {
            logger.info('会话连接失败', { sessionId: pending.sessionId });
            pendingNav.current = null;
          }
          // 连接中状态不输出日志（每 2s 轮询，避免刷屏）
        }
      } catch (error) {
        if (!stopped) setLoadError(messageOf(error));
      }
    };
    void tick();
    const timer = setInterval(() => { void tick(); }, SESSIONS_POLL_MS);
    return () => { stopped = true; clearInterval(timer); };
  }, []);

  // 倒计时滴答
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

  // 选中会话的日志增量轮询
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

  // 换发行版时带出上次用过的远端目录
  const onDistroChange = (value: string): void => {
    setDistroName(value);
    try {
      setCwd(localStorage.getItem(`${LAST_CWD_KEY_PREFIX}${value}`) ?? '');
    } catch { /* 隐私模式等场景 localStorage 不可用，跳过记忆 */ }
  };

  /**
   * 发起 WSL 连接。
   *
   * @param mode - 窗口形态
   */
  const onConnect = async (mode: 'current' | 'new' | 'window'): Promise<void> => {
    if (distroName.trim() === '' || busy) return;
    setBusy(true);
    setFormError('');
    try {
      const port = Number.parseInt(localPort, 10);
      logger.info('postConnect 请求', { distroName: distroName.trim(), mode, desktop: DESKTOP });
      const session = await postConnect({
        // WSL 模式下 hostAlias 带 wsl: 前缀，与 CLI 和 WslTransport.hostAlias 保持一致
        hostAlias: `wsl:${distroName.trim()}`,
        transportType: 'wsl',
        distroName: distroName.trim(),
        ...(wslUser.trim() !== '' ? { wslUser: wslUser.trim() } : {}),
        ...(cwd.trim() !== '' ? { cwd: cwd.trim() } : {}),
        ...(Number.isFinite(port) && port > 0 ? { localPort: port } : {}),
        ...(nodeVersion.trim() !== '' ? { nodeVersion: nodeVersion.trim() } : {}),
        ...(dshVersion.trim() !== '' ? { dshVersion: dshVersion.trim() } : {}),
        forceRestart,
        managerUrl: DESKTOP ? OVERLAY_INTENT_ORIGIN : window.location.origin,
      });
      logger.info('postConnect 返回', { sessionId: session.sessionId, connecting: session.connecting, url: session.url });
      pendingNav.current = { sessionId: session.sessionId, mode };
      try {
        localStorage.setItem(`${LAST_CWD_KEY_PREFIX}${distroName.trim()}`, cwd.trim());
      } catch { /* 记忆失败不影响连接 */ }
      setSelectedId(session.sessionId);
    } catch (error) {
      setFormError(messageOf(error));
    } finally {
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

  /** 格式化发行版状态文案 */
  const formatState = (state: string): string => {
    const lower = state.toLowerCase();
    if (lower === 'running') return t('wslStateRunning');
    if (lower === 'stopped') return t('wslStateStopped');
    return state;
  };

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 16,
      padding: '16px 20px', height: '100%', overflowY: 'auto', boxSizing: 'border-box',
    }}>
      <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>{t('nav')}</h2>
      <p style={{ margin: 0, opacity: 0.75, fontSize: 13 }}>{t('wslSectionIntro')}</p>

      {/* ---- 同标签自动切入远端的倒计时（可取消） ---- */}
      {countdown !== null
        ? (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
            <span>{t('countdown')} {countdown.seconds}s</span>
            <button type="button" style={buttonStyle}
              onClick={() => { pendingNav.current = null; setCountdown(null); }}>
              {t('cancelCountdown')}
            </button>
          </div>
        )
        : null}

      {/* ---- 连接表单 ---- */}
      <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: '1 1 220px' }}>
            <span style={{ fontSize: 12, opacity: 0.75 }}>{t('wslDistro')}</span>
            <span style={{ display: 'flex', gap: 4 }}>
              <input
                list="dsh-remote-explorer-wsl-distros"
                value={distroName}
                placeholder={t('wslDistroPlaceholder')}
                style={{ ...inputStyle, flex: 1 }}
                onChange={event => onDistroChange(event.target.value)}
              />
              <button type="button" style={buttonStyle} title={t('refreshDistros')}
                onClick={() => { void loadDistros(true); }}>↻</button>
            </span>
          </label>
          <datalist id="dsh-remote-explorer-wsl-distros">
            {distros.map(distro => (
              <option key={distro.name} value={distro.name}>
                {`${distro.name} (${t('wslVersion')} ${distro.version}, ${formatState(distro.state)}${distro.isDefault ? `, ${t('wslDefault')}` : ''})`}
              </option>
            ))}
          </datalist>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: '2 1 300px' }}>
            <span style={{ fontSize: 12, opacity: 0.75 }}>{t('cwd')}</span>
            <input value={cwd} placeholder={t('cwdPlaceholder')} style={inputStyle}
              onChange={event => setCwd(event.target.value)} />
          </label>
        </div>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 2, maxWidth: 320 }}>
          <span style={{ fontSize: 12, opacity: 0.75 }}>{t('wslUser')}</span>
          <input value={wslUser} placeholder={t('wslUserPlaceholder')} style={inputStyle}
            onChange={event => setWslUser(event.target.value)} />
        </label>

        {distros.length === 0 && loadError === ''
          ? <div style={{ fontSize: 13, opacity: 0.6 }}>{t('wslNoDistros')}</div>
          : null}

        <details>
          <summary style={{ cursor: 'pointer', fontSize: 13, opacity: 0.75 }}>{t('advanced')}</summary>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 8, marginTop: 8 }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span style={{ fontSize: 12, opacity: 0.75 }}>{t('localPort')}</span>
              <input value={localPort} inputMode="numeric" style={inputStyle}
                onChange={event => setLocalPort(event.target.value)} />
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
          </div>
        </details>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {DESKTOP
            ? (
              <button type="button" style={{ ...buttonStyle, fontWeight: 600 }}
                disabled={busy || distroName.trim() === ''}
                onClick={() => { void onConnect('window'); }}>
                {busy ? t('connecting') : t('connectWindow')}
              </button>
            )
            : (
              <>
                <button type="button" style={{ ...buttonStyle, fontWeight: 600 }}
                  disabled={busy || distroName.trim() === ''}
                  onClick={() => { void onConnect('current'); }}>
                  {busy ? t('connecting') : t('connectCurrent')}
                </button>
                <button type="button" style={buttonStyle}
                  disabled={busy || distroName.trim() === ''}
                  onClick={() => { void onConnect('new'); }}>
                  {t('connectNew')}
                </button>
              </>
            )}
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
              {sessions.map(session => renderSessionRow(session, selectedId, t, DESKTOP, {
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

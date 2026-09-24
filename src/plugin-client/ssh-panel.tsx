/**
 * @file SSH 远程会话管理面板
 * @description 从原 panel.tsx 拆分而来，专管 SSH 传输类型的连接表单、会话表
 *              与进度日志。数据全部来自宿主 /api/dsh-remote-explorer/* 路由
 *              （同源 fetch 自动带 dsh 会话 Cookie），列表 2s 轮询、选中会话
 *              的日志 1.5s 增量轮询。
 *
 * 窗口形态按环境分流（桌面壳单 OS 窗口，跨 origin 导航全被甩给系统浏览器）：
 * - 桌面端：单按钮「在新窗口连接」；就绪后开整窗浮动桌面（remote-window.tsx
 *   的 body 级 webview 覆盖浮层，远程页面铺满整窗、无自建顶栏）。managerUrl 传
 *   假意图 origin，让远端 handoff pill 的返回/关闭/停止变成可被浮层拦截的意图信号
 * - 浏览器端：双入口原样——「当前标签」就绪后 3 秒倒计时同标签切入；
 *   「新标签」target=_blank 弹新页（session.url = 隧道转发后的**远端 dsh
 *   界面**，含远端访问令牌，语义等同 CLI 把 URL 打进终端后用户点开）
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
import type { RemoteExplorerLocaleKey } from './locales.js';
import {
  fetchHosts, messageOf, postConnect, postDisconnect, type PanelSession,
} from './api.js';
import { openRemoteWindow, OVERLAY_INTENT_ORIGIN } from './remote-window.js';
import { RemotePluginsSection } from './panel-plugins.js';
import { STATE_COLORS, STATE_LABEL_KEYS } from '../util/session-display.js';
import { inputStyle, buttonStyle } from './styles.js';
import { DESKTOP, HANDOFF_COUNTDOWN_SECONDS } from './constants.js';
import { useSessionPolling } from './use-session-polling.js';

/** localStorage 里「上次远端目录」的键前缀（按主机别名记忆） */
const LAST_CWD_KEY_PREFIX = 'dsh-remote-explorer:lastCwd:';

/** 面板 props：locale 面由 slots 框架注入（注册时声明了 locale 命名空间） */
export interface SshSessionPanelProps {
  /** 命名空间绑定的翻译函数 */
  t: (key: RemoteExplorerLocaleKey) => string;
}

/**
 * SSH 远程会话管理面板。
 *
 * @param props - locale 注入面
 * @returns 面板内容
 */
export function SshSessionPanel(props: SshSessionPanelProps): ReactNode {
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
  const [stopRemote, setStopRemote] = React.useState(true);
  const logBoxRef = React.useRef<HTMLDivElement | null>(null);

  // ---- 会话轮询（提取到共享 Hook，消除与 wsl-panel 的重复） ----
  const {
    sessions, loadError, setLoadError, selectedId, setSelectedId, log,
    pendingNav, countdown, setCountdown,
  } = useSessionPolling({
    onSessionReady: (ready) => {
      // Hook 保证调用时 ready.url 已定义；此处再守一次满足类型检查
      if (ready.url === undefined) return;
      // 桌面端直接开整窗浮层；浏览器端「当前标签」起倒计时，「新标签」
      // 不起（弹窗拦截不允许无手势开标签），会话行按钮接管
      if (pendingNav.current?.mode === 'window') {
        openRemoteWindow({
          sessionId: ready.sessionId,
          url: ready.url,
          hostAlias: ready.hostAlias,
        });
      } else if (pendingNav.current?.mode === 'current') {
        setCountdown({ url: ready.url, seconds: HANDOFF_COUNTDOWN_SECONDS });
      }
    },
    // 失败不空等：错误已在表单区呈现
  });

  // 主机列表：挂载时拉一次；「刷新」按钮带 refresh=1 让宿主重读 ssh config
  const loadHosts = React.useCallback(async (refresh: boolean): Promise<void> => {
    try {
      setHosts(await fetchHosts(refresh));
    } catch (error) {
      setLoadError(messageOf(error));
    }
  }, [setLoadError]);
  React.useEffect(() => { void loadHosts(false); }, [loadHosts]);

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

  /**
   * 发起连接。
   *
   * @param mode - 窗口形态：current/new = 浏览器端双入口（同标签倒计时 / 会话行
   *               开新标签）；window = 桌面端整窗浮动桌面
   */
  const onConnect = async (mode: 'current' | 'new' | 'window'): Promise<void> => {
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
        // 管理页 origin：浏览器端给真实 origin（handoff「返回」同标签导航回管理页）；
        // 桌面端给假意图 origin——webview 策略拒绝导航回应用 origin，改用这个 origin
        // 让 handoff 三个动作变成可被整窗浮层拦截的意图信号（window.open / will-navigate），
        // handoff 代码零改动、菜单不再只读（见 remote-window.tsx 文件头）
        managerUrl: DESKTOP ? OVERLAY_INTENT_ORIGIN : window.location.origin,
      });
      pendingNav.current = { sessionId: session.sessionId, mode };
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

  // 全局面板自带页头（settings 弹窗时代标题由设置壳显示，迁出后自己给）；
  // 根容器全高滚动：中央列高度由 layout 决定，内容超长时面板内滚动
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 16,
      padding: '16px 20px', height: '100%', overflowY: 'auto', boxSizing: 'border-box',
    }}>
      <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>{t('nav')}</h2>
      <p style={{ margin: 0, opacity: 0.75, fontSize: 13 }}>{t('sshSectionIntro')}</p>

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
              <input value={nodeVersion} placeholder="v24.21.0" style={inputStyle}
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

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {DESKTOP
            ? (
              // 桌面端单入口：就绪后开整窗浮动桌面（桌面壳无跨 origin 导航能力）
              <button type="button" style={{ ...buttonStyle, fontWeight: 600 }}
                disabled={busy || host.trim() === ''}
                onClick={() => { void onConnect('window'); }}>
                {busy ? t('connecting') : t('connectWindow')}
              </button>
            )
            : (
              // 浏览器端双入口（VS Code 语义）：当前标签 = 就绪后同标签切入；新标签 = 本页留守管理
              <>
                <button type="button" style={{ ...buttonStyle, fontWeight: 600 }}
                  disabled={busy || host.trim() === ''}
                  onClick={() => { void onConnect('current'); }}>
                  {busy ? t('connecting') : t('connectCurrent')}
                </button>
                <button type="button" style={buttonStyle}
                  disabled={busy || host.trim() === ''}
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

      {/* ---- 远端插件管理（VS Code「本地视图管远端」表面） ---- */}
      <RemotePluginsSection sessionId={selectedId} t={t} />

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
export interface RowActions {
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
 * @param isDesktop - 是否桌面壳（决定行内入口按钮形态）
 * @param actions - 行回调
 * @returns 行内容
 */
export function renderSessionRow(
  session: PanelSession,
  selectedId: string | null,
  t: (key: RemoteExplorerLocaleKey) => string,
  isDesktop: boolean,
  actions: RowActions,
): ReactNode {
  const stateTag = session.connecting ? 'connecting' : session.state.tag;
  const stateLabel = t((STATE_LABEL_KEYS[stateTag] ?? 'stateIdle') as RemoteExplorerLocaleKey);
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
          isDesktop
            ? (
              // 桌面端单入口：开整窗浮动桌面（跨 origin 导航会被桌面壳甩给系统浏览器）
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  openRemoteWindow({
                    sessionId: session.sessionId,
                    url: session.url ?? '',
                    hostAlias: session.hostAlias,
                  });
                }}
                style={{
                  background: 'transparent', color: 'inherit', fontSize: 12, fontWeight: 600,
                  border: '1px solid rgba(127,127,127,0.5)', borderRadius: 6,
                  padding: '2px 8px', cursor: 'pointer',
                }}
              >
                {t('openWindow')}
              </button>
            )
            : (
              // 浏览器端双入口：同标签切入 / 新标签
              <>
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    window.location.href = session.url ?? '';
                  }}
                  style={{
                    background: 'transparent', color: 'inherit', fontSize: 12, fontWeight: 600,
                    border: '1px solid rgba(127,127,127,0.5)', borderRadius: 6,
                    padding: '2px 8px', cursor: 'pointer',
                  }}
                >
                  {t('enterCurrent')}
                </button>
                <a href={session.url} target="_blank" rel="noreferrer"
                  onClick={event => event.stopPropagation()}
                  style={{ fontSize: 13 }}>
                  {t('openNew')} ↗
                </a>
              </>
            )
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

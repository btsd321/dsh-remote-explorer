/**
 * @file SSH 远程会话管理面板
 * @description 面板壳：连接表单（ssh-connect-form，含高级选项三弹窗）、
 *              会话表与进度日志的编排。数据全部来自宿主
 *              /api/dsh-remote-explorer/* 路由（同源 fetch 自动带 dsh 会话
 *              Cookie），列表 2s 轮询、选中会话的日志 1.5s 增量轮询。
 *              连接表单子系统已拆出（状态与提交逻辑见 ssh-connect-form.tsx），
 *              本文件只做轮询接线与会话/日志呈现。
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
 *   当文字色的坑）——中性色一律 inherit/rgba 半透明灰，仅状态点用语义色；
 *   深浅主题都成立。
 */

import * as React from 'react';
import type { ReactNode } from 'react';
import type { SshHostSummary } from '../hosts/ssh-config-parser.js';
import type { RemoteExplorerLocaleKey } from './locales.js';
import {
  fetchHosts, messageOf, postDisconnect, type PanelSession,
} from './api.js';
import { openRemoteWindow } from './remote-window.js';
import { SshConnectForm } from './ssh-connect-form.js';
import { STATE_COLORS, STATE_LABEL_KEYS } from '../util/session-display.js';
import { DESKTOP, HANDOFF_COUNTDOWN_SECONDS } from './constants.js';
import { useSessionPolling } from './use-session-polling.js';

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

  // 连接已受理（表单回调）：接管选中态与窗口导航意图
  const onConnected = (session: PanelSession, mode: 'current' | 'new' | 'window'): void => {
    pendingNav.current = { sessionId: session.sessionId, mode };
    setSelectedId(session.sessionId);
  };

  const onDisconnect = async (target: string): Promise<void> => {
    setLoadError('');
    try {
      await postDisconnect(target, stopRemote);
    } catch (error) {
      setLoadError(messageOf(error));
    }
  };

  // 有活跃会话（含连接中与外部视图）的主机集合：连接表单的「已连接」
  // 标记（combobox 浮层 + 按钮形态切换）共用同一判定
  const connectedHostAliases = React.useMemo(() => {
    const set = new Set<string>();
    for (const item of sessions) {
      if (item.connecting || item.state.tag !== 'disconnected') set.add(item.hostAlias);
    }
    return set;
  }, [sessions]);

  /**
   * 断开某主机在本进程维持的全部活跃会话（连接表单的「断开」按钮）。
   *
   * 串行逐个断开（对远端操作默认串行的仓库纪律）；连接中的会话会被宿主
   * 拒绝（still_connecting）并提示，不阻断其余；外部会话不归本进程管，
   * 只提示不操作。
   *
   * @param hostAlias - 目标主机别名
   */
  const onDisconnectHost = async (hostAlias: string): Promise<void> => {
    const targets = sessions.filter(item =>
      item.hostAlias === hostAlias
      && item.external !== true
      && (item.connecting || item.state.tag !== 'disconnected'));
    if (targets.length === 0) {
      // 集合判定含外部会话：走到这里说明该主机的会话全由其他本机进程维持
      setLoadError(t('hostDisconnectExternal'));
      return;
    }
    const errors: string[] = [];
    try {
      for (const item of targets) {
        try {
          await postDisconnect(item.sessionId, stopRemote);
        } catch (error) {
          errors.push(messageOf(error));
        }
      }
    } finally {
      if (errors.length > 0) setLoadError(errors.join('；'));
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
            <button type="button" style={{ color: 'inherit', background: 'transparent',
              border: '1px solid rgba(127,127,127,0.5)', borderRadius: 6, padding: '2px 8px',
              cursor: 'pointer', fontSize: 12 }}
              onClick={() => { pendingNav.current = null; setCountdown(null); }}>
              {t('cancelCountdown')}
            </button>
          </div>
        )
        : null}

      {/* ---- 连接表单（含高级选项三弹窗；状态与提交在表单内） ---- */}
      <SshConnectForm
        t={t}
        hosts={hosts}
        connectedHostAliases={connectedHostAliases}
        onConnected={onConnected}
        onDisconnectHost={hostAlias => { void onDisconnectHost(hostAlias); }}
        onRefreshHosts={() => { void loadHosts(true); }}
      />

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

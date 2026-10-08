/**
 * @file SSH 连接表单（含高级选项三弹窗）
 * @description 从 ssh-panel.tsx 拆出的连接表单子系统：主机/目录/密码/私钥
 *              等连接字段、高级选项折叠区（端口/版本/开关 + 跳板机/环境
 *              变量/代理三个弹窗入口）与连接发起。面板（ssh-panel）只保留
 *              会话表、进度日志与轮询编排——表单经 onConnected 回调上抛
 *              连接结果，不感知轮询细节。
 *
 * 高级选项的持久化语义（用户拍板）：
 * - **按传输形态分域只记上一次输入**（~/.dsh/remote-advanced.json 的 ssh
 *   域，域内不按主机区分）：换主机连接沿用同一份 env/proxy/跳板
 *   target+私钥；WSL 域另存（本表单只读写 ssh 域）
 * - **连接密码绝不落盘**：表单密码与跳板机密码都只在内存（连接请求携带），
 *   连接尝试结束后立即清除引用（JS 字符串不可清零是已知限制，靠 GC）
 * - 跳板机按主机类型分流（详见 jump-host-dialog）：config 别名只读、
 *   user@host[:port] 可编辑；连接请求只在直连目标时携带跳板条目
 *
 * 凭据纪律：密码框旁明示「仅存宿主进程内存」；提交成功或失败后立即清掉
 * 本地 state 引用（宿主侧同样不落盘不进日志）。
 */

import * as React from 'react';
import type { ReactNode } from 'react';
import type { JumpEntry, SshHostSummary } from '../hosts/ssh-config-parser.js';
import type { RemoteExplorerLocaleKey } from './locales.js';
import { messageOf, postConnect, type PanelSession } from './api.js';
import { HostPicker } from './host-picker.js';
import { VersionPicker } from './version-picker.js';
import { useDshVersions } from './use-dsh-versions.js';
import { useNodeVersions } from './use-node-versions.js';
import { OVERLAY_INTENT_ORIGIN } from './remote-window.js';
import { EnvDialog } from './dialogs/env-dialog.js';
import { ProxyDialog } from './dialogs/proxy-dialog.js';
import { JumpHostDialog } from './dialogs/jump-host-dialog.js';
import { inputStyle, buttonStyle } from './styles.js';
import { DESKTOP } from './constants.js';

/** localStorage 里「上次远端目录」的键前缀（按主机别名记忆） */
const LAST_CWD_KEY_PREFIX = 'dsh-remote-explorer:lastCwd:';

/** localStorage 里「上次 dsh 版本」的键（SSH 域，不按主机区分） */
const DSH_VERSION_KEY = 'dsh-remote-explorer:dshVersion:ssh';

/** localStorage 里「上次 Node 版本」的键（SSH 域，不按主机区分） */
const NODE_VERSION_KEY = 'dsh-remote-explorer:nodeVersion:ssh';

/** 直连语法粗判（与宿主 parseAdHocHost 同族形态：user@host[:port]） */
const AD_HOC_HOST_RE = /^([^@\s]+)@([^@\s]+?)(?::(\d+))?$/;

/** 表单 props */
export interface SshConnectFormProps {
  /** 命名空间绑定的翻译函数 */
  t: (key: RemoteExplorerLocaleKey) => string;
  /** 主机列表（HostPicker 与跳板机弹窗分流共用） */
  hosts: SshHostSummary[];
  /** 已连接主机别名集合（按钮形态切换判定） */
  connectedHostAliases: ReadonlySet<string>;
  /**
   * 连接已受理回调（postConnect 成功）：面板接管选中态与窗口导航意图，
   * 表单不感知轮询细节
   */
  onConnected: (session: PanelSession, mode: 'current' | 'new' | 'window') => void;
  /** 断开某主机在本进程维持的全部活跃会话（面板层：需要会话表数据） */
  onDisconnectHost: (hostAlias: string) => void;
  /** 刷新主机列表（面板层：重读 ssh config） */
  onRefreshHosts: () => void;
}

/**
 * SSH 连接表单。
 *
 * @param props - 见 {@link SshConnectFormProps}
 * @returns 表单区块
 */
export function SshConnectForm(props: SshConnectFormProps): ReactNode {
  const { t, hosts, connectedHostAliases, onConnected, onDisconnectHost, onRefreshHosts } = props;

  // ---- 连接表单状态 ----
  const [host, setHost] = React.useState('');
  const [cwd, setCwd] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [privateKey, setPrivateKey] = React.useState('');
  const [localPort, setLocalPort] = React.useState('');
  const [nodeVersion, setNodeVersion] = React.useState(() => {
    try { return localStorage.getItem(NODE_VERSION_KEY) ?? ''; } catch { return ''; }
  });
  const [dshVersion, setDshVersion] = React.useState(() => {
    try { return localStorage.getItem(DSH_VERSION_KEY) ?? ''; } catch { return ''; }
  });
  const [forceRestart, setForceRestart] = React.useState(false);
  const [refreshMirrors, setRefreshMirrors] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [formError, setFormError] = React.useState('');

  // ---- 高级选项弹窗（null = 全关；三个互斥，同时只开一个） ----
  const [openDialog, setOpenDialog] = React.useState<'jump' | 'env' | 'proxy' | null>(null);
  const closeDialog = React.useCallback((): void => {
    setOpenDialog(null);
  }, []);

  // ---- 跳板机条目（直连主机专用；含内存态密码，绝不落盘） ----
  /**
   * 弹窗保存后的完整条目快照。undefined = 用户未保存过弹窗（连接请求不带
   * jumpHosts，宿主回落全局存储的持久化子集）；密码在每次连接尝试后清除
   * （targets/私钥保留在内存里继续沿用）
   */
  const [jumpEntries, setJumpEntries] = React.useState<JumpEntry[] | undefined>(undefined);

  // ---- 版本下拉列表（挂载时探测 registry/发行站填充 datalist） ----
  const dshVersions = useDshVersions();
  const nodeVersions = useNodeVersions();

  /**
   * 主机输入是否直连语法（跳板机携带判据：仅直连目标把面板跳板条目放进
   * 连接请求——config 别名主机的跳板由 ssh config 决定，带了也会被服务端
   * 忽略并打 warn，不如前端就不带）。
   */
  const hostIsAdHoc = (value: string): boolean => {
    const trimmed = value.trim();
    if (trimmed === '') return false;
    if (AD_HOC_HOST_RE.test(trimmed) === false) return false;
    return !hosts.some(item => item.alias.toLowerCase() === trimmed.toLowerCase());
  };

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
   * @param mode - 窗口形态：current/new = 浏览器端双入口（同标签倒计时 /
   *               会话行开新标签）；window = 桌面端整窗浮动桌面
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
        // 跳板机条目：仅直连目标携带（分流规则见文件头）；面板未配置过弹窗
        // 时不带（宿主回落全局存储的持久化子集）
        ...(hostIsAdHoc(host) && jumpEntries !== undefined && jumpEntries.length > 0
          ? { jumpHosts: jumpEntries }
          : {}),
        // 管理页 origin：浏览器端给真实 origin（handoff「返回」同标签导航回
        // 管理页）；桌面端给假意图 origin——webview 策略拒绝导航回应用
        // origin，改用这个 origin 让 handoff 三个动作变成可被整窗浮层拦截
        // 的意图信号（见 remote-window.tsx 文件头）
        managerUrl: DESKTOP ? OVERLAY_INTENT_ORIGIN : window.location.origin,
      });
      try {
        localStorage.setItem(`${LAST_CWD_KEY_PREFIX}${host.trim()}`, cwd.trim());
        // dsh 版本按传输形态（SSH）记忆，下次连接时恢复上次选择
        localStorage.setItem(DSH_VERSION_KEY, dshVersion.trim());
        // Node 版本同纪律（SSH 域独立记忆）
        localStorage.setItem(NODE_VERSION_KEY, nodeVersion.trim());
      } catch { /* 记忆失败不影响连接 */ }
      onConnected(session, mode);
    } catch (error) {
      setFormError(messageOf(error));
    } finally {
      // 无论成败立即丢弃密码引用（宿主侧也只存内存）；跳板机密码同纪律——
      // targets/私钥保留，下次连接要重新输密码
      setPassword('');
      setJumpEntries(prev => prev === undefined ? undefined : stripJumpPasswords(prev));
      setBusy(false);
    }
  };

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: '1 1 220px' }}>
          <span style={{ fontSize: 12, opacity: 0.75 }}>{t('host')}</span>
          <span style={{ display: 'flex', gap: 4 }}>
            {/* combobox：点开浮层始终列全部主机（datalist 会按残留值过滤，
                弃用）；已连接主机带标记，选择直通 cwd 记忆 */}
            <HostPicker
              value={host}
              onChange={onHostChange}
              hosts={hosts}
              connectedHosts={connectedHostAliases}
              t={t}
            />
            <button type="button" style={buttonStyle} title={t('refreshHosts')}
              onClick={onRefreshHosts}>↻</button>
          </span>
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: '2 1 300px' }}>
          <span style={{ fontSize: 12, opacity: 0.75 }}>{t('cwd')}</span>
          <input value={cwd} placeholder={t('cwdPlaceholder')} style={inputStyle}
            onChange={event => setCwd(event.target.value)} />
        </label>
      </div>

      <details>
        <summary style={{ cursor: 'pointer', fontSize: 13, opacity: 0.75 }}>{t('advanced')}</summary>
        {/* 高级选项三弹窗入口：连接前可配（全局记忆；跳板机按主机类型分流） */}
        <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
          <button type="button" style={buttonStyle}
            onClick={() => { setOpenDialog('jump'); }}>{t('advancedJump')}</button>
          <button type="button" style={buttonStyle}
            onClick={() => { setOpenDialog('env'); }}>{t('advancedEnv')}</button>
          <button type="button" style={buttonStyle}
            onClick={() => { setOpenDialog('proxy'); }}>{t('advancedProxy')}</button>
        </div>
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
            <VersionPicker value={nodeVersion} onChange={setNodeVersion}
              versions={nodeVersions} placeholder="v24.21.0" />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ fontSize: 12, opacity: 0.75 }}>{t('dshVersion')}</span>
            <VersionPicker value={dshVersion} onChange={setDshVersion}
              versions={dshVersions} />
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
        {host.trim() !== '' && connectedHostAliases.has(host.trim())
          ? (
            // 选中已连接主机：按钮组整体切换为「断开」（含连接中与外部视图的
            // 主机都算已连接；断开逻辑在面板层——需要会话表数据）
            <button type="button" style={{ ...buttonStyle, fontWeight: 600 }}
              disabled={busy}
              onClick={() => { void onDisconnectHost(host.trim()); }}>
              {busy ? t('connecting') : t('disconnect')}
            </button>
          )
          : DESKTOP
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

      {/* ---- 高级选项弹窗（三选一挂载；共享 DialogShell 浮层）。环境变量
          弹窗读写 ssh 域——高级选项按传输形态分域存储 ---- */}
      {openDialog === 'jump'
        ? <JumpHostDialog hostValue={host} hosts={hosts} onClose={closeDialog}
          onSaved={entries => { setJumpEntries(entries); }} t={t} />
        : null}
      {openDialog === 'env' ? <EnvDialog transportType="ssh" onClose={closeDialog} t={t} /> : null}
      {openDialog === 'proxy' ? <ProxyDialog onClose={closeDialog} t={t} /> : null}
    </section>
  );
}

/**
 * 剥离跳板机条目的密码字段（连接尝试后的内存清理——targets/私钥保留，
 * 密码要求用户下次连接重新输入）。
 *
 * @param entries - 完整条目（可能含密码）
 * @returns 不含密码的条目
 */
function stripJumpPasswords(entries: readonly JumpEntry[]): JumpEntry[] {
  return entries.map(entry => ({
    target: entry.target,
    ...(entry.identityFile !== undefined ? { identityFile: entry.identityFile } : {}),
  }));
}

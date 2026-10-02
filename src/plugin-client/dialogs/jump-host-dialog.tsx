/**
 * @file 跳板机弹窗（高级选项之一，按主机类型分流）
 * @description 连接表单选中的主机决定弹窗形态：
 *              - **config 别名主机**：只读视图——链来自 ssh config 的
 *                ProxyJump（hosts 接口的 jumpChain 字段），附提示行「修改请
 *                编辑 ~/.ssh/config」；面板不提供编辑入口
 *              - **user@host[:port] 直连主机**：可编辑行列表（每条 target +
 *                可选私钥路径 + 可选密码），保存 target/identityFile 子集到
 *                全局存储；**密码不落盘**——只随 onSaved 回调进父组件内存，
 *                由连接请求携带
 *              - 未选中/无法识别：提示先选主机
 *
 * 凭据纪律：密码输入框 type=password（界面不显示明文）；保存不发密码；
 * 行内错误只回显 target 不回显密码。
 */

import * as React from 'react';
import type { ReactNode } from 'react';
import { fetchAdvanced, messageOf, postAdvanced } from '../api.js';
import type { StoredJumpEntry } from '../../plugin/advanced-store.js';
import type { JumpEntry, SshHostSummary } from '../../hosts/ssh-config-parser.js';
import type { RemoteExplorerLocaleKey } from '../locales.js';
import { inputStyle, buttonStyle } from '../styles.js';
import { DialogShell, dialogLoadState, rowButtonStyle } from './dialog-shell.js';

/** 等宽字体（跳板机条目是技术字符串） */
const MONO_FONT_FAMILY = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

/** 直连语法粗判（与宿主 parseAdHocHost 同族形态：user@host[:port]） */
const AD_HOC_HOST_RE = /^([^@\s]+)@([^@\s]+?)(?::(\d+))?$/;

/** 可编辑行（编辑中 target 允许为空，保存时跳过空行） */
interface JumpRow {
  /** 跳板机标识（别名或 user@host[:port]） */
  target: string;
  /** 私钥路径（空 = config / 交互） */
  identityFile: string;
  /** 密码（不落盘；空 = 未填） */
  password: string;
}

/** 弹窗 props */
export interface JumpHostDialogProps {
  /** 连接表单当前的主机输入（分流判据） */
  hostValue: string;
  /** 主机列表（config 别名集合 + 各自跳板机链） */
  hosts: SshHostSummary[];
  /** 关闭弹窗（取消或保存成功后由父组件卸载） */
  onClose: () => void;
  /**
   * 保存成功回调：携带完整条目（含内存态密码，JumpEntry）——父组件存进
   * 连接表单 state，连接请求携带；密码在父组件连接后清除
   */
  onSaved: (entries: JumpEntry[]) => void;
  /** 命名空间绑定的翻译函数 */
  t: (key: RemoteExplorerLocaleKey) => string;
}

/**
 * 跳板机弹窗。
 *
 * @param props - 见 {@link JumpHostDialogProps}
 * @returns 弹窗浮层
 */
export function JumpHostDialog(props: JumpHostDialogProps): ReactNode {
  const { hostValue, hosts, onClose, onSaved, t } = props;

  // 分流判据：输入值命中主机列表的别名 = config 主机；匹配直连语法 = 直连
  const trimmed = hostValue.trim();
  const configHost = trimmed !== ''
    ? hosts.find(item => item.alias.toLowerCase() === trimmed.toLowerCase())
    : undefined;
  const isAdHoc = configHost === undefined && trimmed !== '' && AD_HOC_HOST_RE.test(trimmed);
  const mode: 'config' | 'adHoc' | 'unknown' = configHost !== undefined
    ? 'config' : isAdHoc ? 'adHoc' : 'unknown';

  const [rows, setRows] = React.useState<JumpRow[]>([]);
  /** 加载阶段：loading 拉取中；ready 可编辑；error 拉取失败（可重试） */
  const [loadPhase, setLoadPhase] = React.useState<'loading' | 'ready' | 'error'>('loading');
  const [loadError, setLoadError] = React.useState('');
  const [saveError, setSaveError] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  /** 重试计数：自增触发加载 effect 重跑 */
  const [reloadTick, setReloadTick] = React.useState(0);

  // 直连模式打开时拉既有配置；config/unknown 模式不拉（无编辑面）
  React.useEffect(() => {
    if (mode !== 'adHoc') return;
    let stopped = false;
    setLoadPhase('loading');
    setLoadError('');
    void fetchAdvanced()
      .then(advanced => {
        if (stopped) return;
        const stored = advanced.jumpHosts ?? [];
        setRows(stored.length > 0
          ? stored.map(entry => ({
            target: entry.target,
            identityFile: entry.identityFile ?? '',
            password: '',
          }))
          : [{ target: '', identityFile: '', password: '' }]);
        setLoadPhase('ready');
      })
      .catch((error: unknown) => {
        if (stopped) return;
        setLoadError(messageOf(error));
        setLoadPhase('error');
      });
    return () => { stopped = true; };
  }, [mode, reloadTick]);

  /** 更新第 index 行的字段 */
  const updateRow = (index: number, patch: Partial<JumpRow>): void => {
    setRows(prev => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };

  /** 删除第 index 行 */
  const removeRow = (index: number): void => {
    setRows(prev => prev.filter((_, i) => i !== index));
  };

  /** 追加一行空行 */
  const addRow = (): void => {
    setRows(prev => [...prev, { target: '', identityFile: '', password: '' }]);
  };

  /**
   * 保存（仅直连模式）：target/identityFile 子集 POST 落盘（部分更新语义，
   * 不动 env/proxy）；完整条目（含密码）经 onSaved 交父组件内存持有。
   * 空行跳过；全部删光 = 清除跳板配置。
   */
  const onSave = async (): Promise<void> => {
    if (busy || loadPhase !== 'ready') return;
    setSaveError('');
    const filled = rows.filter(row => row.target.trim() !== '');
    for (const row of filled) {
      if (/\s/.test(row.target.trim())) {
        setSaveError(`${t('jumpTarget')}：${row.target.trim()}`);
        return;
      }
    }
    const stored: StoredJumpEntry[] = filled.map((row): StoredJumpEntry => ({
      target: row.target.trim(),
      ...(row.identityFile.trim() !== '' ? { identityFile: row.identityFile.trim() } : {}),
    }));
    setBusy(true);
    try {
      await postAdvanced({ jumpHosts: stored });
      // 完整条目（含密码）交父组件内存持有；密码为空的行不带 password 字段
      onSaved(filled.map((row): JumpEntry => ({
        target: row.target.trim(),
        ...(row.identityFile.trim() !== '' ? { identityFile: row.identityFile.trim() } : {}),
        ...(row.password !== '' ? { password: row.password } : {}),
      })));
      onClose();
    } catch (error) {
      setSaveError(messageOf(error));
    } finally {
      setBusy(false);
    }
  };

  // ─── config 别名主机：只读视图 ───
  if (mode === 'config') {
    const chain = configHost?.jumpChain;
    return (
      <DialogShell title={`${t('jumpDialogTitle')}：${configHost?.alias ?? ''}`} onClose={onClose}>
        <div style={{ fontSize: 12, opacity: 0.7, lineHeight: 1.5 }}>{t('jumpConfigHint')}</div>
        {configHost?.hasProxyJump !== true
          ? <div style={{ opacity: 0.7 }}>{t('jumpNoChain')}</div>
          : chain !== undefined && chain.length > 0
            ? (
              <ol style={{ margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 4 }}>
                {chain.map((hop, index) => (
                  <li key={index} style={{ fontFamily: MONO_FONT_FAMILY, fontSize: 12 }}>
                    {hop.username !== '' ? `${hop.username}@` : ''}{hop.host}:{hop.port}
                  </li>
                ))}
              </ol>
            )
            : (
              // 有 ProxyJump 但链解析失败（坏引用）：显示原文供排查
              <div style={{ fontFamily: MONO_FONT_FAMILY, fontSize: 12, opacity: 0.8 }}>
                {configHost?.proxyJump}
              </div>
            )}
      </DialogShell>
    );
  }

  // ─── 未识别主机：提示先选 ───
  if (mode === 'unknown') {
    return (
      <DialogShell title={t('jumpDialogTitle')} onClose={onClose}>
        <div style={{ opacity: 0.7 }}>{t('jumpUnknownHost')}</div>
      </DialogShell>
    );
  }

  // ─── 直连主机：可编辑行列表 ───
  return (
    <DialogShell
      title={`${t('jumpDialogTitle')}：${trimmed}`} onClose={onClose}
      footer={(
        <>
          <button type="button" style={buttonStyle} disabled={busy} onClick={onClose}>
            {t('dlgCancel')}
          </button>
          <button type="button" style={{ ...buttonStyle, fontWeight: 600 }}
            disabled={busy || loadPhase !== 'ready'}
            onClick={() => { void onSave(); }}>
            {busy ? t('dlgSaving') : t('dlgSave')}
          </button>
        </>
      )}
    >
      <div style={{ fontSize: 12, opacity: 0.7, lineHeight: 1.5 }}>{t('jumpDirectHint')}</div>
      {dialogLoadState(loadPhase, loadError, () => { setReloadTick(value => value + 1); }, t)}
      {loadPhase === 'ready'
        ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {rows.map((row, index) => (
              <div key={index} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <input
                    value={row.target}
                    placeholder={t('jumpTarget')}
                    spellCheck={false}
                    style={{ ...inputStyle, flex: 1, fontFamily: MONO_FONT_FAMILY }}
                    onChange={event => updateRow(index, { target: event.target.value })}
                  />
                  <button type="button" style={rowButtonStyle} title={t('jumpRemoveRow')}
                    onClick={() => removeRow(index)}>✕</button>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <input
                    value={row.identityFile}
                    placeholder={t('jumpIdentity')}
                    spellCheck={false}
                    style={{ ...inputStyle, flex: 1, fontSize: 12 }}
                    onChange={event => updateRow(index, { identityFile: event.target.value })}
                  />
                  <input
                    type="password"
                    value={row.password}
                    placeholder={t('jumpPassword')}
                    autoComplete="off"
                    style={{ ...inputStyle, flex: '0 0 32%', fontSize: 12 }}
                    onChange={event => updateRow(index, { password: event.target.value })}
                  />
                </div>
              </div>
            ))}
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button type="button" style={rowButtonStyle} onClick={addRow}>
                + {t('jumpAddRow')}
              </button>
            </div>
            <div style={{ fontSize: 11, opacity: 0.6 }}>{t('jumpPasswordHint')}</div>
          </div>
        )
        : null}
      {saveError !== ''
        ? <div style={{ color: '#ef4444', fontSize: 12 }}>{t('dlgSaveError')}{saveError}</div>
        : null}
    </DialogShell>
  );
}

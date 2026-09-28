/**
 * @file 主机环境变量配置弹窗
 * @description 方案 B（REMOTE_PROXY_ENV_REPORT.md §B.3）的编辑界面：按 hostAlias
 *              维护一组环境变量，保存到宿主侧 ~/.dsh/remote-host-env.json，
 *              下一次连接该主机时注入远端 dsh 进程。前端只负责读写 UI——
 *              校验与注入语义归宿主半路由（键名正则两端一致，后端校验为准）。
 *
 * 交互约束：
 * - 弹窗为固定定位浮层（半透明遮罩 + 居中卡片 + 最高 z-index）。slot 内
 *   React 直接渲染即可——只需盖住面板区域，不必像 remote-window 那样挂
 *   body 去盖桌面壳标题栏
 * - 点击遮罩不关闭：行编辑是无暂存的本地 state，误触丢失成本高；关闭走
 *   「取消」按钮或 Esc（等同取消，不保存）
 * - 未填变量名的空行保存时跳过；值留空的行保留（POSIX 允许空值变量）
 * - 代理快捷项一键填入/更新 https_proxy 与 http_proxy，值为 SSH 反向隧道
 *   在远端回环的监听地址（占位默认，按实际 net_proxy 脚本的 RemotePort 改）
 *
 * 样式纪律：中性色一律 inherit/rgba 半透明灰，不猜设计令牌名——卡片背景用
 * 仓库浮层先例的 var(--dsw-alias-bg-base, #1e1e22)（dropdown-menu.tsx 同款），
 * 深浅主题都成立。
 */

import * as React from 'react';
import type { ReactNode } from 'react';
import { fetchHostEnv, messageOf, postHostEnv } from './api.js';
import type { RemoteExplorerLocaleKey } from './locales.js';
import { inputStyle, buttonStyle } from './styles.js';

/** 变量名合法形态（与宿主半 /host-env 路由的校验一致，两端正则必须同步改） */
const KEY_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** 保留键：DSH_HOME/DSH_AGENTS_HOME 是远端落盘隔离契约本体、PATH 走 pathPrefix 通道，均由工具自身管理 */
const RESERVED_KEYS = ['DSH_HOME', 'DSH_AGENTS_HOME', 'PATH'];

/** 值中的控制字符（会破坏远端 runner 脚本的 env 赋值行；宿主半同样拒绝，前端先拦给即时提示） */
const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]/;

/** 代理快捷项的预设值：SSH 反向隧道在远端回环的监听地址（占位默认，按实际 RemotePort 调整） */
const PROXY_PRESET_URL = 'http://127.0.0.1:18890';

/** 代理快捷项要填的两个变量名 */
const PROXY_PRESET_KEYS = ['https_proxy', 'http_proxy'] as const;

/** 等宽字体（与进度日志框一致，环境变量名/值是技术字符串） */
const MONO_FONT_FAMILY = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

/** 可编辑行 */
interface EnvRow {
  /** 变量名（编辑中允许为空，保存时跳过空行） */
  name: string;
  /** 变量值（空串合法：POSIX 允许空值变量） */
  value: string;
}

/** 弹窗 props */
export interface HostEnvDialogProps {
  /** 目标主机别名（ssh config 别名或 user@host[:port]） */
  hostAlias: string;
  /** 关闭弹窗（用户取消或保存成功后由父组件卸载） */
  onClose: () => void;
  /** 命名空间绑定的翻译函数 */
  t: (key: RemoteExplorerLocaleKey) => string;
}

/** 行内小按钮样式（删除行按钮用，与会话行内按钮同规格） */
const rowButtonStyle: React.CSSProperties = {
  background: 'transparent',
  color: 'inherit',
  border: '1px solid rgba(127,127,127,0.5)',
  borderRadius: 6,
  padding: '2px 8px',
  cursor: 'pointer',
  fontSize: 12,
};

/**
 * 主机环境变量配置弹窗。
 *
 * 打开时加载既有配置（fetchHostEnv），编辑在本地行 state 上进行；保存由
 * 弹窗内部调 postHostEnv 完成，错误显示在弹窗内，成功后回调 onClose 卸载。
 *
 * @param props - hostAlias、关闭回调、locale 面
 * @returns 弹窗浮层
 */
export function HostEnvDialog(props: HostEnvDialogProps): ReactNode {
  const { hostAlias, onClose, t } = props;
  const [rows, setRows] = React.useState<EnvRow[]>([]);
  /** 加载阶段：loading 拉取中；ready 可编辑；error 拉取失败（可重试） */
  const [loadPhase, setLoadPhase] = React.useState<'loading' | 'ready' | 'error'>('loading');
  const [loadError, setLoadError] = React.useState('');
  const [saveError, setSaveError] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  /** 重试计数：自增触发加载 effect 重跑 */
  const [reloadTick, setReloadTick] = React.useState(0);

  // 打开（或换主机别名）时拉既有配置；stopped 防卸载后回写 state
  React.useEffect(() => {
    let stopped = false;
    setLoadPhase('loading');
    setLoadError('');
    void fetchHostEnv(hostAlias)
      .then(env => {
        if (stopped) return;
        const entries = Object.entries(env);
        setRows(entries.length > 0
          ? entries.map(([name, value]) => ({ name, value }))
          // 空配置也给一行空行，省一次「添加一行」点击
          : [{ name: '', value: '' }]);
        setLoadPhase('ready');
      })
      .catch((error: unknown) => {
        if (stopped) return;
        setLoadError(messageOf(error));
        setLoadPhase('error');
      });
    return () => { stopped = true; };
  }, [hostAlias, reloadTick]);

  // Esc 关闭（等同取消，不保存）——与 remote-window 浮层的兜底键位一致
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => { window.removeEventListener('keydown', onKeyDown); };
  }, [onClose]);

  /**
   * 保存：前端先校验一遍（键名正则/保留键/重复行/控制字符，与宿主半一致），
   * 通过后 POST；失败把 ApiError.message 留在弹窗内展示，成功后 onClose。
   */
  const onSave = async (): Promise<void> => {
    if (busy || loadPhase !== 'ready') return;
    setSaveError('');
    // 1. 跳过未填变量名的空行（值留空的行保留——空值变量合法）
    const filled = rows.filter(row => row.name.trim() !== '');
    const env: Record<string, string> = {};
    for (const row of filled) {
      const name = row.name.trim();
      // 2. 键名形态（与宿主半同一正则，改要两端同步）
      if (!KEY_NAME_PATTERN.test(name)) {
        setSaveError(`${t('hostEnvInvalidKey')}${name}`);
        return;
      }
      // 3. 保留键：由工具自身管理，用户 env 不允许覆盖
      if (RESERVED_KEYS.includes(name)) {
        setSaveError(`${t('hostEnvReservedKey')}${name}`);
        return;
      }
      // 4. 重复行：静默后者覆盖前者太隐蔽，显式报错
      if (Object.hasOwn(env, name)) {
        setSaveError(`${t('hostEnvDuplicateKey')}${name}`);
        return;
      }
      // 5. 值含控制字符（宿主半为准，这里先拦一道）
      if (CONTROL_CHAR_PATTERN.test(row.value)) {
        setSaveError(`${t('hostEnvInvalidValue')}${name}`);
        return;
      }
      env[name] = row.value;
    }
    setBusy(true);
    try {
      await postHostEnv(hostAlias, env);
      onClose();
    } catch (error) {
      // 后端校验失败（bad_usage 等）：中文 message 直接展示在弹窗内
      setSaveError(messageOf(error));
    } finally {
      setBusy(false);
    }
  };

  /** 代理快捷项：一键填入/更新 https_proxy 与 http_proxy 两行 */
  const onProxyPreset = (): void => {
    setRows(prev => {
      const next = [...prev];
      for (const name of PROXY_PRESET_KEYS) {
        const index = next.findIndex(row => row.name.trim() === name);
        if (index >= 0) {
          next[index] = { name, value: PROXY_PRESET_URL };
          continue;
        }
        // 优先复用首个整行皆空的占位行，否则追加
        const blank = next.findIndex(row => row.name.trim() === '' && row.value.trim() === '');
        if (blank >= 0) next[blank] = { name, value: PROXY_PRESET_URL };
        else next.push({ name, value: PROXY_PRESET_URL });
      }
      return next;
    });
  };

  /** 更新第 index 行的字段 */
  const updateRow = (index: number, patch: Partial<EnvRow>): void => {
    setRows(prev => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };

  /** 删除第 index 行 */
  const removeRow = (index: number): void => {
    setRows(prev => prev.filter((_, i) => i !== index));
  };

  /** 追加一行空行 */
  const addRow = (): void => {
    setRows(prev => [...prev, { name: '', value: '' }]);
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 2147483647,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(0,0,0,0.45)', padding: 24, boxSizing: 'border-box',
    }}>
      <div
        role="dialog" aria-modal="true" aria-label={t('hostEnvTitle')}
        style={{
          width: 'min(560px, 100%)', maxHeight: '80vh', overflowY: 'auto',
          display: 'flex', flexDirection: 'column', gap: 10,
          background: 'var(--dsw-alias-bg-base, #1e1e22)', color: 'inherit',
          border: '1px solid rgba(127,127,127,0.4)', borderRadius: 8,
          padding: '14px 16px', boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
          fontSize: 13,
        }}
      >
        <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>
          {t('hostEnvTitle')}：{hostAlias}
        </h3>
        <div style={{ fontSize: 12, opacity: 0.7, lineHeight: 1.5 }}>{t('hostEnvHint')}</div>

        {loadPhase === 'loading'
          ? <div style={{ opacity: 0.6 }}>{t('hostEnvLoading')}</div>
          : null}
        {loadPhase === 'error'
          ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start' }}>
              <div style={{ color: '#ef4444', fontSize: 12 }}>{t('hostEnvLoadError')}{loadError}</div>
              <button type="button" style={buttonStyle}
                onClick={() => { setReloadTick(value => value + 1); }}>
                {t('retry')}
              </button>
            </div>
          )
          : null}

        {loadPhase === 'ready'
          ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {rows.map((row, index) => (
                <div key={index} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <input
                    value={row.name}
                    placeholder={t('hostEnvKey')}
                    spellCheck={false}
                    style={{ ...inputStyle, flex: '0 0 38%', fontFamily: MONO_FONT_FAMILY }}
                    onChange={event => updateRow(index, { name: event.target.value })}
                  />
                  <input
                    value={row.value}
                    placeholder={t('hostEnvValue')}
                    spellCheck={false}
                    style={{ ...inputStyle, flex: 1, fontFamily: MONO_FONT_FAMILY }}
                    onChange={event => updateRow(index, { value: event.target.value })}
                  />
                  <button type="button" style={rowButtonStyle} title={t('hostEnvRemoveRow')}
                    onClick={() => removeRow(index)}>✕</button>
                </div>
              ))}
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <button type="button" style={rowButtonStyle} onClick={addRow}>
                  + {t('hostEnvAddRow')}
                </button>
                <span style={{ fontSize: 11, opacity: 0.6 }}>{t('hostEnvSkipHint')}</span>
              </div>
            </div>
          )
          : null}

        {/* 代理快捷项：预设值指向 SSH 反向隧道的远端端口，见 PROXY_PRESET_URL 注释。
            仅在行列表可见（加载完成）时给出——否则改的是看不见的行数据 */}
        {loadPhase === 'ready'
          ? (
            <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
              <button type="button" style={buttonStyle} onClick={onProxyPreset}>
                {t('hostEnvProxyPreset')}
              </button>
              <span style={{ fontSize: 11, opacity: 0.6, flex: 1, minWidth: 180 }}>
                {t('hostEnvProxyHint')}
              </span>
            </div>
          )
          : null}

        <div style={{ fontSize: 12, opacity: 0.7, lineHeight: 1.5 }}>{t('hostEnvApplyHint')}</div>

        {saveError !== ''
          ? <div style={{ color: '#ef4444', fontSize: 12 }}>{t('hostEnvSaveError')}{saveError}</div>
          : null}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" style={buttonStyle} disabled={busy} onClick={onClose}>
            {t('hostEnvCancel')}
          </button>
          <button type="button" style={{ ...buttonStyle, fontWeight: 600 }}
            disabled={busy || loadPhase !== 'ready'}
            onClick={() => { void onSave(); }}>
            {busy ? t('hostEnvSaving') : t('hostEnvSave')}
          </button>
        </div>
      </div>
    </div>
  );
}

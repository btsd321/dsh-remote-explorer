/**
 * @file 环境变量弹窗（高级选项之一，按传输形态分域）
 * @description 环境变量编辑器：打开时 GET /advanced?transportType= 读回
 *              **当前传输形态对应域**的 env，保存时 POST 部分更新（只提交
 *              env 字段，缺省字段保持域内原值——同域弹窗互不清除对方）。
 *              配置按连接形态（SSH / WSL）分开保存，互不影响：SSH 表单挂
 *              本弹窗读写 ssh 域，WSL 面板挂本弹窗读写 wsl 域；域内不按
 *              主机/发行版区分——换主机连接沿用同一份（用户拍板的语义，
 *              取代旧 per-host 齿轮模型）。
 *
 * 改造自旧 HostEnvDialog（代理快捷项已移除——代理独立成弹窗与字段）。
 *
 * 交互约束：
 * - 未填变量名的空行保存时跳过；值留空的行保留（POSIX 允许空值变量）
 * - 前端先校验（键名正则/保留键/重复行/控制字符），后端为准——两端正则
 *   必须同步改（宿主侧 advanced-store）
 *
 * 凭据纪律：值可能含密（token/代理认证信息），错误提示只回显键名不回显值。
 */

import * as React from 'react';
import type { ReactNode } from 'react';
import { fetchAdvanced, messageOf, postAdvanced } from '../api.js';
import type { RemoteExplorerLocaleKey } from '../locales.js';
import { inputStyle, buttonStyle } from '../styles.js';
import { DialogShell, dialogLoadState, rowButtonStyle } from './dialog-shell.js';

/** 变量名合法形态（与宿主侧 advanced-store 的校验一致，两端正则必须同步改） */
const KEY_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** 保留键：DSH_HOME/DSH_AGENTS_HOME 是远端落盘隔离契约本体、PATH 走 pathPrefix 通道，均由工具自身管理 */
const RESERVED_KEYS = ['DSH_HOME', 'DSH_AGENTS_HOME', 'PATH'];

/** 值中的控制字符（会破坏远端 runner 脚本的 env 赋值行；宿主半同样拒绝） */
const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]/;

/** 等宽字体（与环境变量名/值的技术字符串气质一致） */
const MONO_FONT_FAMILY = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

/** 可编辑行 */
interface EnvRow {
  /** 变量名（编辑中允许为空，保存时跳过空行） */
  name: string;
  /** 变量值（空串合法：POSIX 允许空值） */
  value: string;
}

/** 弹窗 props */
export interface EnvDialogProps {
  /** 传输形态（高级选项分域的域键）：SSH 表单传 'ssh'，WSL 面板传 'wsl' */
  transportType: 'ssh' | 'wsl';
  /** 关闭弹窗（取消或保存成功后由父组件卸载） */
  onClose: () => void;
  /** 命名空间绑定的翻译函数 */
  t: (key: RemoteExplorerLocaleKey) => string;
}

/**
 * 环境变量弹窗。
 *
 * 打开时加载 transportType 对应域的既有配置，编辑在本地行 state 上进行；
 * 保存由弹窗内部调 postAdvanced 完成（只提交 env 字段——其余字段缺省 =
 * 清除，所以必须在服务端原值上合并……见 onSave 的实现注释），错误显示在
 * 弹窗内，成功后回调 onClose 卸载。
 *
 * @param props - 传输形态、关闭回调、locale 面
 * @returns 弹窗浮层
 */
export function EnvDialog(props: EnvDialogProps): ReactNode {
  const { transportType, onClose, t } = props;
  const [rows, setRows] = React.useState<EnvRow[]>([]);
  /** 加载阶段：loading 拉取中；ready 可编辑；error 拉取失败（可重试） */
  const [loadPhase, setLoadPhase] = React.useState<'loading' | 'ready' | 'error'>('loading');
  const [loadError, setLoadError] = React.useState('');
  const [saveError, setSaveError] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  /** 重试计数：自增触发加载 effect 重跑 */
  const [reloadTick, setReloadTick] = React.useState(0);

  // 打开时拉 transportType 对应域的既有配置；stopped 防卸载后回写 state
  React.useEffect(() => {
    let stopped = false;
    setLoadPhase('loading');
    setLoadError('');
    void fetchAdvanced(transportType)
      .then(advanced => {
        if (stopped) return;
        const entries = Object.entries(advanced.env);
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
  }, [transportType, reloadTick]);

  /**
   * 保存：前端先校验（键名/保留键/重复行/控制字符，与宿主半一致），
   * 通过后 POST；失败把错误留在弹窗内展示，成功后 onClose。
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
        setSaveError(`${t('envInvalidKey')}${name}`);
        return;
      }
      // 3. 保留键：由工具自身管理，用户 env 不允许覆盖
      if (RESERVED_KEYS.includes(name)) {
        setSaveError(`${t('envReservedKey')}${name}`);
        return;
      }
      // 4. 重复行：静默后者覆盖前者太隐蔽，显式报错
      if (Object.hasOwn(env, name)) {
        setSaveError(`${t('envDuplicateKey')}${name}`);
        return;
      }
      // 5. 值含控制字符（宿主半为准，这里先拦一道）
      if (CONTROL_CHAR_PATTERN.test(row.value)) {
        setSaveError(`${t('envInvalidValue')}${name}`);
        return;
      }
      env[name] = row.value;
    }
    setBusy(true);
    try {
      // 只提交 env 字段：POST 是按域的部分更新语义——缺省字段（proxy/
      // jumpHosts，仅 ssh 域有）保持存储原值，本弹窗不清除同域其他弹窗的配置
      await postAdvanced(transportType, { env });
      onClose();
    } catch (error) {
      setSaveError(messageOf(error));
    } finally {
      setBusy(false);
    }
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
    <DialogShell
      title={t('envDialogTitle')} onClose={onClose}
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
      <div style={{ fontSize: 12, opacity: 0.7, lineHeight: 1.5 }}>{t('envDialogHint')}</div>
      <div style={{ fontSize: 12, opacity: 0.7, lineHeight: 1.5 }}>{t('envDialogDomainHint')}</div>
      {dialogLoadState(loadPhase, loadError, () => { setReloadTick(value => value + 1); }, t)}
      {loadPhase === 'ready'
        ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {rows.map((row, index) => (
              <div key={index} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input
                  value={row.name}
                  placeholder={t('envKey')}
                  spellCheck={false}
                  style={{ ...inputStyle, flex: '0 0 38%', fontFamily: MONO_FONT_FAMILY }}
                  onChange={event => updateRow(index, { name: event.target.value })}
                />
                <input
                  value={row.value}
                  placeholder={t('envValue')}
                  spellCheck={false}
                  style={{ ...inputStyle, flex: 1, fontFamily: MONO_FONT_FAMILY }}
                  onChange={event => updateRow(index, { value: event.target.value })}
                />
                <button type="button" style={rowButtonStyle} title={t('envRemoveRow')}
                  onClick={() => removeRow(index)}>✕</button>
              </div>
            ))}
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button type="button" style={rowButtonStyle} onClick={addRow}>
                + {t('envAddRow')}
              </button>
              <span style={{ fontSize: 11, opacity: 0.6 }}>{t('envSkipHint')}</span>
            </div>
          </div>
        )
        : null}
      <div style={{ fontSize: 12, opacity: 0.7, lineHeight: 1.5 }}>{t('envDialogApplyHint')}</div>
      {saveError !== ''
        ? <div style={{ color: '#ef4444', fontSize: 12 }}>{t('dlgSaveError')}{saveError}</div>
        : null}
    </DialogShell>
  );
}

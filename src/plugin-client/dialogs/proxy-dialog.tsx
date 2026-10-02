/**
 * @file 代理弹窗（高级选项之一，SSH 域专属）
 * @description 代理 URL 编辑器：打开时 GET /advanced?transportType=ssh 读回
 *              **ssh 域**配置，保存时 POST 部分更新（只提交 proxy 字段，
 *              空串 = 清除）。本弹窗只在 SSH 连接表单挂载（WSL 无代理概念，
 *              wsl 域不存 proxy），fetch/post 一律固定传 'ssh'。连接时宿主
 *              侧经 collectProxyEnv(explicit) 展开为八个代理键注入远端 dsh
 *              （优先级：用户 env > 本代理 > DSH_REMOTE_PROXY，仅 SSH 连接）。
 *
 * 表单只有一个 URL 输入——形态校验（http(s) origin、无 path/query）在宿主
 * 侧 advanced-store 为准，前端不做重复校验，错误消息直接透传展示。
 *
 * 凭据纪律：URL 可能含 userinfo（user:pass@host）——连接日志打印时宿主侧
 * 打码；本弹窗输入框用明文（用户正在编辑自己的值），不做回显打码。
 */

import * as React from 'react';
import type { ReactNode } from 'react';
import { fetchAdvanced, messageOf, postAdvanced } from '../api.js';
import type { RemoteExplorerLocaleKey } from '../locales.js';
import { inputStyle, buttonStyle } from '../styles.js';
import { DialogShell, dialogLoadState } from './dialog-shell.js';

/** 弹窗 props */
export interface ProxyDialogProps {
  /** 关闭弹窗（取消或保存成功后由父组件卸载） */
  onClose: () => void;
  /** 命名空间绑定的翻译函数 */
  t: (key: RemoteExplorerLocaleKey) => string;
}

/**
 * 代理弹窗。
 *
 * @param props - 关闭回调、locale 面
 * @returns 弹窗浮层
 */
export function ProxyDialog(props: ProxyDialogProps): ReactNode {
  const { onClose, t } = props;
  const [proxy, setProxy] = React.useState('');
  /** 加载阶段：loading 拉取中；ready 可编辑；error 拉取失败（可重试） */
  const [loadPhase, setLoadPhase] = React.useState<'loading' | 'ready' | 'error'>('loading');
  const [loadError, setLoadError] = React.useState('');
  const [saveError, setSaveError] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  /** 重试计数：自增触发加载 effect 重跑 */
  const [reloadTick, setReloadTick] = React.useState(0);

  // 打开时拉既有配置（弹窗只在 SSH 表单挂载，域键固定 'ssh'）；stopped 防
  // 卸载后回写 state
  React.useEffect(() => {
    let stopped = false;
    setLoadPhase('loading');
    setLoadError('');
    void fetchAdvanced('ssh')
      .then(advanced => {
        if (stopped) return;
        setProxy(advanced.proxy ?? '');
        setLoadPhase('ready');
      })
      .catch((error: unknown) => {
        if (stopped) return;
        setLoadError(messageOf(error));
        setLoadPhase('error');
      });
    return () => { stopped = true; };
  }, [reloadTick]);

  /**
   * 保存：只提交 proxy 字段（按域部分更新语义，不清除 env/jumpHosts）。
   * 空串 = 清除代理配置。形态校验在宿主侧，错误透传展示。域键固定 'ssh'
   * （本弹窗只在 SSH 表单挂载）。
   */
  const onSave = async (): Promise<void> => {
    if (busy || loadPhase !== 'ready') return;
    setSaveError('');
    setBusy(true);
    try {
      await postAdvanced('ssh', { proxy: proxy.trim() });
      onClose();
    } catch (error) {
      setSaveError(messageOf(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogShell
      title={t('proxyDialogTitle')} onClose={onClose}
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
      <div style={{ fontSize: 12, opacity: 0.7, lineHeight: 1.5 }}>{t('proxyDialogHint')}</div>
      {dialogLoadState(loadPhase, loadError, () => { setReloadTick(value => value + 1); }, t)}
      {loadPhase === 'ready'
        ? (
          <input
            value={proxy}
            placeholder={t('proxyPlaceholder')}
            spellCheck={false}
            style={inputStyle}
            onChange={event => setProxy(event.target.value)}
          />
        )
        : null}
      <div style={{ fontSize: 12, opacity: 0.7, lineHeight: 1.5 }}>{t('proxyDialogApplyHint')}</div>
      {saveError !== ''
        ? <div style={{ color: '#ef4444', fontSize: 12 }}>{t('dlgSaveError')}{saveError}</div>
        : null}
    </DialogShell>
  );
}

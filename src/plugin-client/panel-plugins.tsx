/**
 * @file 面板「远端插件」区
 * @description VS Code「本地视图管远端插件」的表面：对选中会话的远端 profile
 *              做清单 / 安装 / 启停 / 卸载。全部动作经宿主半路由 → 监督器 →
 *              会话既有 SSH 通道在远端执行（pnpm + 清单改写），启停经远端 hmr
 *              热生效；安装规格原样交给远端 pnpm（quote 转义在宿主半完成）。
 *
 *              与远端窗口原生插件 UI 的关系：两面操作同一份 profile 清单，
 *              谁改的都经 hmr 热加载，互不锁——并发修改清单的竞态由「最后
 *              写赢」收敛，与 VS Code 多窗口同 profile 的行为同级。
 *
 * 样式纪律与 panel.tsx 一致：inherit/rgba 半透明灰，不猜设计令牌名。
 */

import * as React from 'react';
import type { ReactNode } from 'react';
import {
  fetchRemotePlugins, postRemotePluginAction, type RemotePluginAction, type RemotePluginInfo,
} from './api.js';
import type { RemoteExplorerLocaleKey } from './locales.js';

/** 区块 props */
export interface RemotePluginsSectionProps {
  /** 当前选中会话 id；null = 未选中，只给提示 */
  sessionId: string | null;
  /** 命名空间绑定的翻译函数 */
  t: (key: RemoteExplorerLocaleKey) => string;
}

/**
 * 远端插件管理区块。
 *
 * @param props - 选中会话与 locale 面
 * @returns 区块内容
 */
export function RemotePluginsSection(props: RemotePluginsSectionProps): ReactNode {
  const { sessionId, t } = props;
  const [plugins, setPlugins] = React.useState<RemotePluginInfo[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [spec, setSpec] = React.useState('');
  const [error, setError] = React.useState('');

  // 选中会话变化时拉清单
  React.useEffect(() => {
    if (sessionId === null) { setPlugins([]); return; }
    let stopped = false;
    void fetchRemotePlugins(sessionId)
      .then(list => { if (!stopped) { setPlugins(list); setError(''); } })
      .catch(err => { if (!stopped) setError(err instanceof Error ? err.message : String(err)); });
    return () => { stopped = true; };
  }, [sessionId]);

  /**
   * 执行一个动作并刷新清单。
   *
   * @param op - 动作
   */
  const run = async (op: RemotePluginAction): Promise<void> => {
    if (sessionId === null || busy) return;
    setBusy(true);
    setError('');
    try {
      setPlugins(await postRemotePluginAction(sessionId, op));
      if (op.action === 'install') setSpec('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
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
    padding: '2px 8px',
    cursor: 'pointer',
    fontSize: 12,
  };

  return (
    <section>
      <strong style={{ fontSize: 14 }}>{t('pluginsTitle')}</strong>
      {sessionId === null
        ? <div style={{ fontSize: 13, opacity: 0.6, marginTop: 6 }}>{t('pluginsNoSession')}</div>
        : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
            {error !== ''
              ? <div style={{ color: '#ef4444', fontSize: 13 }}>{error}</div>
              : null}
            {plugins.length === 0
              ? <div style={{ fontSize: 13, opacity: 0.6 }}>{t('pluginsEmpty')}</div>
              : plugins.map(plugin => (
                <div key={plugin.name} style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '4px 8px', fontSize: 13,
                  border: '1px solid rgba(127,127,127,0.3)', borderRadius: 6,
                }}
                >
                  {/* 启停只对 bundle 有意义（bundles 列表只装 bundle） */}
                  <input
                    type="checkbox"
                    disabled={!plugin.bundle || busy}
                    checked={plugin.enabled}
                    title={t('pluginsEnabled')}
                    onChange={event => { void run({ action: 'toggle', name: plugin.name, enabled: event.target.checked }); }}
                  />
                  <span style={{ fontWeight: 600 }}>{plugin.name}</span>
                  <span style={{ fontSize: 12, opacity: 0.7 }}>{plugin.version}</span>
                  {plugin.bundle
                    ? <span style={{ fontSize: 11, opacity: 0.6 }}>{t('pluginsBundle')}</span>
                    : null}
                  <span style={{ flex: 1 }} />
                  <button type="button" style={buttonStyle} disabled={busy}
                    onClick={() => { void run({ action: 'remove', name: plugin.name }); }}>
                    {t('pluginsRemove')}
                  </button>
                </div>
              ))}
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                value={spec}
                placeholder={t('pluginsSpecPlaceholder')}
                style={{ ...inputStyle, flex: 1 }}
                onChange={event => setSpec(event.target.value)}
              />
              <button type="button" style={{ ...buttonStyle, fontWeight: 600 }}
                disabled={busy || spec.trim() === ''}
                onClick={() => { void run({ action: 'install', spec: spec.trim() }); }}>
                {t('pluginsInstall')}
              </button>
            </div>
          </div>
        )}
    </section>
  );
}

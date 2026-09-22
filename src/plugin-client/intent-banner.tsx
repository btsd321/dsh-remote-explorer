/**
 * @file 远端交接意图横幅（shell.overlay 全局浮层）
 * @description 远端窗口的「关闭远程连接并返回 / 停止远端 dsh 并返回」是
 *              navigate-then-act：远端菜单先同标签导航回本管理页（带
 *              `#handoff-disconnect=` / `#handoff-stop=` intent hash），动作由
 *              存活的本页执行——断开会立刻杀死经隧道服务的远端页面，反之则不会。
 *
 *              横幅注册在 shell.overlay 而非面板内部：导航回来时默认落在主聊天
 *              视图，面板未必挂载；overlay 与视图选择无关，用户无需先找面板。
 *              确认才执行（断开/停止都是不可逆动作），执行或取消都清掉 hash
 *              （避免刷新后重复询问）。
 */

import * as React from 'react';
import type { ReactNode } from 'react';
import { postDisconnect } from './api.js';
import type { RemoteExplorerLocaleKey } from './locales.js';

/** intent 横幅 props（locale 面由 slots 框架注入） */
export interface IntentBannerProps {
  /** 命名空间绑定的翻译函数 */
  t: (key: RemoteExplorerLocaleKey) => string;
}

/** 解析结果：目标会话 id 与是否连远端一起停 */
interface Intent {
  id: string;
  stop: boolean;
}

/**
 * 从地址栏解析交接意图。
 *
 * @returns 意图；hash 不匹配时 null
 */
function parseIntent(): Intent | null {
  const match = /^#handoff-(disconnect|stop)=([^&]+)$/.exec(window.location.hash);
  if (match === null) return null;
  return { id: decodeURIComponent(match[2] ?? ''), stop: match[1] === 'stop' };
}

/** 清掉地址栏的交接意图 hash（避免刷新后重复弹确认） */
function clearIntentHash(): void {
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
}

/**
 * 交接意图横幅。
 *
 * @param props - locale 注入面
 * @returns 横幅；无 intent 时不渲染
 */
export function IntentBanner(props: IntentBannerProps): ReactNode {
  const { t } = props;
  const [intent, setIntent] = React.useState<Intent | null>(() => parseIntent());
  const [error, setError] = React.useState('');

  // 执行后远端页面已死、本页可能随后被用户切走；hash 变化（如再次交接）也重读
  React.useEffect(() => {
    const onHash = (): void => { setIntent(parseIntent()); };
    window.addEventListener('hashchange', onHash);
    return () => { window.removeEventListener('hashchange', onHash); };
  }, []);

  if (intent === null) return null;

  const dismiss = (): void => {
    setIntent(null);
    clearIntentHash();
  };

  const run = async (): Promise<void> => {
    const { id, stop } = intent;
    dismiss();
    try {
      await postDisconnect(id, stop);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const buttonStyle: React.CSSProperties = {
    background: 'transparent',
    color: 'inherit',
    border: '1px solid rgba(127,127,127,0.5)',
    borderRadius: 6,
    padding: '4px 10px',
    cursor: 'pointer',
    fontSize: 12,
  };

  return (
    <div style={{
      position: 'fixed', top: 12, left: '50%', transform: 'translateX(-50%)',
      zIndex: 1300, display: 'flex', gap: 8, alignItems: 'center',
      maxWidth: 560, padding: '8px 12px', fontSize: 13,
      background: 'rgba(30,30,30,0.92)', color: '#e5e5e5',
      border: '1px solid rgba(245,158,11,0.6)', borderRadius: 8,
      boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
    }}
    >
      <span style={{ flex: 1 }}>
        {intent.stop ? t('intentStop') : t('intentDisconnect')}
        {error !== '' ? <span style={{ color: '#ef4444' }}>（{error}）</span> : null}
      </span>
      <button type="button" style={{ ...buttonStyle, fontWeight: 600 }}
        onClick={() => { void run(); }}>
        {t('intentExecute')}
      </button>
      <button type="button" style={buttonStyle} onClick={dismiss}>
        {t('intentCancel')}
      </button>
    </div>
  );
}

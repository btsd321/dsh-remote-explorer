/**
 * @file dsh 插件浏览器半入口
 * @module
 * @description 构建为 lib/client.js 后经 dsh 的 clientModules 机制下发：
 *              包声明 `dsh.client` + `exports["./client"]` → 扫进 window.__DSH_BOOT__
 *              引导图 → `GET /plugins/??<包名>/client.js&rev=` 组合脚本下发 →
 *              浏览器侧由 build 脚本包的 `window.__ModuleLoader__.load({ id, factory })`
 *              外壳注册（**id 必须等于包名**，graph 行以包名为键）。
 *
 * factory 收到同步 require：react 由平台种子提供（React 18.2），esbuild 以
 * external 处理，产物里的 require('react') 恰好命中。
 *
 * 注册面（复刻第一方 ui-plugin-manager 的全局面板模式）：
 * - locale 命名空间 'dshRemoteExplorer'（zh/en 字典，en 兜底）
 * - slots.inject('main')：keyed root 槽注册 RemoteSessionRouter 路由容器
 *   （内部按 activeView 状态切换 SSH / WSL 子面板）
 * - slots.inject('sidebar.panellist')：左导航图标按钮（与「插件」按钮平级），
 *   点击切换由 sidebar 壳调 layout.selectPanel 完成，本插件零 onClick 逻辑
 *
 * 0.6.x 前这块 UI 注册在 settings.section——设置页语义是偏好配置，不承载
 * 常驻工作流（主机管理/实时会话），故整体迁出，设置里不再留入口。
 */

import * as React from 'react';
import type { ReactNode } from 'react';
import type { Context as ClientContext } from '@deepseek-ai/cordis';
// 以下 type-only 导入只为激活 Context/SlotMap 的模块类型增广，
// esbuild 打包时整体擦除，浏览器 bundle 不含任何框架运行时代码
import type {} from '@deepseek-ai/dsh-client-locale/client';
import type {} from '@deepseek-ai/dsh-client-ui-layout/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client';
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client';
import { en, zh, type RemoteExplorerLocaleKey } from './locales.js';
import { RemoteSessionsIcon } from './icon.js';
import { IntentBanner } from './intent-banner.js';
import { RemoteWindowOverlay } from './remote-window.js';
import { SshSessionPanel } from './ssh-panel.js';
import { WslSessionPanel } from './wsl-panel.js';
import { fetchWslDistros } from './api.js';
import type { RemoteType } from './dropdown-menu.js';

// 把本插件的 locale 命名空间并进全局键表——ctx.locale.register/bind 的
// 类型化重载靠它把键集收窄到 RemoteExplorerLocaleKey
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** 远程会话面板文案 */
    'dshRemoteExplorer': RemoteExplorerLocaleKey;
  }
}

/** locale 命名空间（全 dsh 唯一） */
const LOCALE_NS = 'dshRemoteExplorer';

/**
 * 全局面板 id：main 槽的 key 与 sidebar.panellist 条目的 id 必须同值
 * （branded 类型，断言方式与第一方 ui-plugin-manager 一致）。
 */
const PANEL_ID = 'remote-sessions' as MainPanelId;

/** 左导航按钮排序（第一方「插件」为 0；schedule 的 TaskManagerIcon 占 10——
 *  dsh 0.1.7-rc.2 起随 web 组合提供（默认禁用、用户可开启），同号会让
 *  两者排序取决于注册顺序，故本插件再让一档到 20） */
const PANEL_ORDER = 20;

/** 插件名（与宿主半一致；浏览器半的注册 id 是包名，由构建脚本的外壳承载） */
export const name = 'dsh-remote-explorer';

/** 依赖的浏览器侧服务：slots（typed Slots 注册）与 locale（zh/en 字典） */
export const inject = ['slots', 'locale'];

/** 路由容器的视图状态 */
type ActiveView = 'menu' | RemoteType;

/** 路由容器 props（locale 面由 slots 框架注入） */
interface RemoteSessionRouterProps {
  /** 命名空间绑定的翻译函数 */
  t: (key: RemoteExplorerLocaleKey) => string;
}

/**
 * 检测当前是否运行在 Windows 平台（WSL 仅在 Windows 上可用）。
 *
 * navigator.platform 在 Electron/浏览器中返回 Win32/Win64 等值；
 * Linux/macOS 返回 Linux/x86_64 等。
 */
function isWindowsPlatform(): boolean {
  try {
    return /win/i.test(navigator.platform ?? '');
  } catch {
    return false;
  }
}

/**
 * 远程会话路由容器：main 槽的入口组件。
 *
 * 初始显示类型选择卡片列表（SSH / WSL），点击后进入对应子面板。
 * 仅 Windows 平台显示 WSL 卡片；点击 WSL 卡片时先检测 WSL 是否安装，
 * 未安装则显示安装引导提示。
 *
 * @param props - locale 注入面
 * @returns 路由容器内容
 */
function RemoteSessionRouter(props: RemoteSessionRouterProps): ReactNode {
  const { t } = props;
  const [activeView, setActiveView] = React.useState<ActiveView>('menu');
  /** WSL 可用性检测结果：null = 未检测，true = 可用，false = 不可用 */
  const [wslAvailable, setWslAvailable] = React.useState<boolean | null>(null);
  /** WSL 检测中状态 */
  const [wslChecking, setWslChecking] = React.useState(false);

  const buttonStyle: React.CSSProperties = {
    background: 'transparent',
    color: 'inherit',
    border: '1px solid rgba(127,127,127,0.5)',
    borderRadius: 6,
    padding: '4px 12px',
    cursor: 'pointer',
    fontSize: 13,
  };

  const cardStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    padding: '12px 16px',
    border: '1px solid rgba(127,127,127,0.4)',
    borderRadius: 8,
    cursor: 'pointer',
    background: 'transparent',
    color: 'inherit',
    textAlign: 'left',
    width: '100%',
    transition: 'background 0.15s',
  };

  /**
   * 点击 WSL 卡片时检测 WSL 可用性。
   * 通过后端 /wsl-distros API 判断：返回空列表 = WSL 未安装或无发行版。
   */
  const onWslCardClick = async (): Promise<void> => {
    setWslChecking(true);
    try {
      const distros = await fetchWslDistros(true);
      if (distros.length > 0) {
        setWslAvailable(true);
        setActiveView('wsl');
      } else {
        setWslAvailable(false);
      }
    } catch {
      setWslAvailable(false);
    } finally {
      setWslChecking(false);
    }
  };

  // 菜单视图：标题 + 类型选择卡片列表
  if (activeView === 'menu') {
    const showWsl = isWindowsPlatform();
    return (
      <div style={{
        display: 'flex', flexDirection: 'column', gap: 16,
        padding: '16px 20px', height: '100%', boxSizing: 'border-box',
      }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>{t('nav')}</h2>
        <p style={{ margin: 0, opacity: 0.75, fontSize: 13 }}>{t('sectionIntro')}</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8, maxWidth: 400 }}>
          <button
            type="button"
            style={cardStyle}
            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(127,127,127,0.1)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
            onClick={() => { setActiveView('ssh'); }}
          >
            <span style={{ fontWeight: 600, fontSize: 14 }}>{t('menuSsh')}</span>
            <span style={{ fontSize: 12, opacity: 0.7 }}>{t('sshSectionIntro')}</span>
          </button>
          {showWsl && (
            <button
              type="button"
              style={cardStyle}
              onMouseEnter={e => { e.currentTarget.style.background = 'rgba(127,127,127,0.1)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
              onClick={() => { void onWslCardClick(); }}
              disabled={wslChecking}
            >
              <span style={{ fontWeight: 600, fontSize: 14 }}>
                {wslChecking ? `${t('menuWsl')}…` : t('menuWsl')}
              </span>
              <span style={{ fontSize: 12, opacity: 0.7 }}>{t('wslSectionIntro')}</span>
            </button>
          )}
        </div>
        {/* WSL 未安装提示 */}
        {wslAvailable === false && (
          <div style={{
            marginTop: 8, padding: '12px 16px', maxWidth: 400,
            border: '1px solid rgba(239,68,68,0.4)', borderRadius: 8,
            fontSize: 13, lineHeight: 1.6,
          }}>
            <strong style={{ color: '#ef4444' }}>{t('wslNotInstalledTitle')}</strong>
            <p style={{ margin: '6px 0 0', opacity: 0.85 }}>{t('wslNotInstalledHint')}</p>
            <button
              type="button"
              style={{ ...buttonStyle, marginTop: 8, fontSize: 12 }}
              onClick={() => { setWslAvailable(null); }}
            >
              {t('retry')}
            </button>
          </div>
        )}
      </div>
    );
  }

  // 子面板视图：顶部返回按钮 + 对应面板
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '8px 20px 0', flexShrink: 0 }}>
        <button
          type="button"
          style={buttonStyle}
          onClick={() => { setActiveView('menu'); }}
        >
          ← {t('nav')}
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        {activeView === 'ssh'
          ? <SshSessionPanel t={t} />
          : <WslSessionPanel t={t} />}
      </div>
    </div>
  );
}

/**
 * 浏览器半激活入口。
 *
 * @param ctx - 浏览器侧 cordis 上下文
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(
    () => ctx.locale.register(LOCALE_NS, { zh, en }),
    'dsh-remote-explorer: locales',
  );

  // 中央整块面板：keyed root 槽，注册路由容器（内部按 activeView 切换子面板）；
  // 数据由面板组件同源 fetch 自取（/api/dsh-remote-explorer/*，Cookie 自动鉴权）
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: LOCALE_NS,
  }, RemoteSessionRouter));

  // 左导航图标按钮：注册组件即图标本体（只收 { size, active }）；
  // label 由注册方本地化并随 locale 切换重注册（框架契约：shell 不订阅 locale）
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: PANEL_ORDER,
    label: () => ctx.locale.bind(LOCALE_NS)('nav'),
    locale: LOCALE_NS,
  }, RemoteSessionsIcon));

  // 远端窗口的交接意图横幅：全局浮层，与面板开合无关（导航回来时默认落在
  // 主聊天视图，面板未必挂载）
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'dsh-remote-explorer-intent',
    locale: LOCALE_NS,
  }, IntentBanner));

  // 桌面端整窗浮动桌面（浏览器端渲染 null）：webview 覆盖浮层，打开/收起
  // 由 remote-window.tsx 的模块级 store 驱动（面板按钮调用）
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'dsh-remote-explorer-remote-window',
    locale: LOCALE_NS,
  }, RemoteWindowOverlay));
}

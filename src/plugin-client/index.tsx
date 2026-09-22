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
 * - slots.inject('main')：keyed root 槽注册整块远程会话面板（key = PANEL_ID）
 * - slots.inject('sidebar.panellist')：左导航图标按钮（与「插件」按钮平级），
 *   点击切换由 sidebar 壳调 layout.selectPanel 完成，本插件零 onClick 逻辑
 *
 * 0.6.x 前这块 UI 注册在 settings.section——设置页语义是偏好配置，不承载
 * 常驻工作流（主机管理/实时会话），故整体迁出，设置里不再留入口。
 */

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
import { SessionPanel } from './panel.js';

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

/** 左导航按钮排序（第一方「插件」为 0，本插件让出一档） */
const PANEL_ORDER = 10;

/** 插件名（与宿主半一致；浏览器半的注册 id 是包名，由构建脚本的外壳承载） */
export const name = 'dsh-remote-explorer';

/** 依赖的浏览器侧服务：slots（typed Slots 注册）与 locale（zh/en 字典） */
export const inject = ['slots', 'locale'];

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

  // 中央整块面板：keyed root 槽，无 Session 绑定——数据由面板组件同源
  // fetch 自取（/api/dsh-remote-explorer/*，Cookie 自动鉴权）
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: LOCALE_NS,
  }, SessionPanel));

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

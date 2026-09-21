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
 * 注册面（对齐官方 ui-agent-preset 的模式）：
 * - locale 命名空间 'settings.dshRemoteExplorer'（zh/en 字典，en 兜底）
 * - slots.inject('settings.section')：Settings → 远程 SSH 会话 面板
 *   order 45（在 Agent presets(20)/Models 之后，插件管理之前）
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis';
// 以下三个 type-only 导入只为激活 Context/SlotMap 的模块类型增广，
// esbuild 打包时整体擦除，浏览器 bundle 不含任何框架运行时代码
import type {} from '@deepseek-ai/dsh-client-locale/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-ui-settings/client';
import { en, zh, type RemoteExplorerLocaleKey } from './locales.js';
import { SessionPanel } from './panel.js';

// 把本插件的 locale 命名空间并进全局键表——ctx.locale.register/bind 的
// 类型化重载靠它把键集收窄到 RemoteExplorerLocaleKey
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** 远程 SSH 会话面板文案 */
    'settings.dshRemoteExplorer': RemoteExplorerLocaleKey;
  }
}

/** locale 命名空间（全 dsh 唯一） */
const LOCALE_NS = 'settings.dshRemoteExplorer';

/** 面板在 Settings 导航里的排序（Agent presets=20 之后） */
const SECTION_ORDER = 45;

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

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'dsh-remote-explorer',
    order: SECTION_ORDER,
    // label 由注册方本地化并随 locale 切换重注册（框架契约：shell 不订阅 locale）
    label: () => ctx.locale.bind(LOCALE_NS)('nav'),
    locale: LOCALE_NS,
  }, SessionPanel));
}

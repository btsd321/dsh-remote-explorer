/**
 * @file 桌面端整窗浮动桌面（body 级覆盖层 + webview 载体）
 * @description 桌面壳是单 OS 窗口，且主窗口标题栏控件（收起侧边栏/应用/编辑）渲染在
 *              比 shell.overlay（z-index 20）更高的层叠上下文里——slot 内的 React 盖
 *              不住它们。又因浏览器半 bundle 只 external `react`、不含 react-dom，
 *              用不了 createPortal。所以浮层用 **vanilla DOM 直接挂到 document.body**、
 *              给最高 z-index：完整盖住主窗口全部网页内容（含那排标题栏按钮），远程
 *              dsh 页面铺满整窗，观感即一个独立窗口；右上角原生的最小化/最大化/关闭
 *              由 Electron 绘制，永远浮在网页之上（盖不掉，也本就该留着）。
 *
 * 载体契约（与第一方 ui-sidebar-browser 的 ElectronWebViewImpl 同一时序）：
 * - webview 必须以 about:blank#<lease> 创建并带 partition，主进程 will-attach-webview
 *   才放行；首次 dom-ready 后才能 loadURL；关闭必须 release（泄漏会占住 partition）。
 *
 * 返回/关闭/停止全部走远程页面自己的 handoff pill（侧栏底部绿点+主机名）——不再自建
 * 顶栏。桌面端把 managerUrl 设成假意图 origin OVERLAY_INTENT_ORIGIN，于是 handoff 的
 * 三个动作变成可被本浮层拦截的意图信号（handoff 代码零改动、无需重新引导）：
 * - 「返回本地管理页」= window.open(managerUrl) → 被桌面壳 deny 并经 browserOpenRequested
 *   转发到 onOpenRequested → 收起浮层（会话保留）
 * - 「关闭/停止并返回」= location.href = managerUrl/#handoff-(disconnect|stop)=<id> →
 *   本浮层监听 webview 的 will-navigate 截获 → 执行 postDisconnect 后收起
 * 兜底：宿主 document 有焦点时（webview 尚未就绪/未夺焦）Esc 也可收起浮层。
 *
 * 链接处理：桌面壳把 guest 的 window.open 一律 deny、只把 URL 转发给本组件，
 * 且不拦 guest 的跨站主框架导航。两类 URL 都必须自己分流——意图 URL 归 handoff，
 * 同 origin 的留在浮层（远端 SPA 路由），其余 http(s) 交系统浏览器；否则前者
 * 点了没反应、后者会把整个浮层导航走。判据见 link-policy.ts。
 *
 * 已知取舍：应用重载后浮层不自动恢复（lease 是进程生命周期），从面板重开即可；
 * webview 夺焦后宿主收不到键盘事件，故 Esc 仅在加载阶段可靠，之后以 handoff pill 为准。
 */

import * as React from 'react';
import type { ReactNode } from 'react';
import { desktopBrowser } from './desktop-bridge.js';
import { isSameSessionOrigin, shouldOpenExternally } from './link-policy.js';
import { overlayTopInset, adaptOverlayRoot } from './overlay-inset.js';
import { createLogger } from '../util/logger.js';

const log = createLogger('remote-window');
import { postDisconnect } from './api.js';
import type { RemoteExplorerLocaleKey } from './locales.js';

/**
 * 桌面浮层模式下交给 handoff 的假 managerUrl origin。
 *
 * 不是真实网络地址：handoff 的「返回」用它 window.open（被桌面壳 deny 并转发给
 * 浮层），「关闭/停止」用它做 location.href 目标（浮层监听 will-navigate 截获）。
 * 选 https 且非本机 dsh host，才能过桌面壳 guest 的 allowedNavigation 白名单。
 */
export const OVERLAY_INTENT_ORIGIN = 'https://dsh-remote-handoff.overlay';

/** Electron webview 元素的最小扩展面（loadURL/getURL 等由 Electron 注入，DOM 标准类型没有） */
interface WebViewElement extends HTMLWebViewElement {
  /** 导航到指定 URL（返回 Promise，加载失败 reject） */
  loadURL(url: string): Promise<void>;
  /** 当前 URL */
  getURL(): string;
  /** 中止进行中的导航（webview 的 will-navigate DOM 事件不可 preventDefault，必须显式 stop） */
  stop(): void;
  /** 在 guest 内执行 JS 并取回结果（用于探测首屏是否真正渲染） */
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
}

/** Electron webview 的导航事件（will-navigate / did-navigate，DOM 标准类型没有） */
interface WebViewNavigateEvent extends Event {
  /** 目标或已提交的 URL */
  url?: string;
}

/** Electron webview 的页内导航事件（did-navigate-in-page，DOM 标准类型没有） */
interface WebViewInPageNavigateEvent extends WebViewNavigateEvent {
  /** 是否为主框架导航 */
  isMainFrame?: boolean;
}

/** Electron webview 的加载失败事件（did-fail-load，DOM 标准类型没有） */
interface WebViewFailLoadEvent extends Event {
  /** 失败错误码（Chromium net error，如 -105 ERR_NAME_NOT_RESOLVED） */
  errorCode?: number;
  /** 失败描述 */
  errorDescription?: string;
  /** 是否为主框架加载失败 */
  isMainFrame?: boolean;
}

/** Chromium ERR_ABORTED：主动 stop()/新导航取消，不视为错误 */
const ERR_ABORTED = -3;

/**
 * 首屏渲染看门狗参数（毫秒）。
 *
 * 主文档 load 完成不代表 React 已挂载：dsh 前端依赖大量静态资源（实测首屏
 * gzip 后约 2.6MB），弱网下稍慢即可能长时间白屏。加载完成后轮询 guest 的
 * #root 是否有内容：渲染出来才撤加载层；超过上限仍是空白则给出「重试」，
 * 避免把空白 #root 直接亮成白屏（看不到任何可操作入口）。
 */
const BOOT_WATCHDOG_MS = 30_000;

/** 首屏渲染轮询间隔（毫秒） */
const BOOT_POLL_MS = 1_500;

/** 浮层目标：打开哪条会话 */
export interface RemoteWindowTarget {
  /** 会话 id（断开动作的目标） */
  sessionId: string;
  /** 隧道转发后的远端 dsh 界面地址（含远端访问令牌） */
  url: string;
  /** 主机别名（仅作诊断/日志，不再渲染成顶栏 pill） */
  hostAlias: string;
}

/** 当前浮层目标；null = 未开 */
let currentTarget: RemoteWindowTarget | null = null;

/** 订阅者集合（面板按钮与浮层组件分属不同 slot，经本 store 通信） */
const listeners = new Set<() => void>();

/** 通知全部订阅者 */
function publish(): void {
  for (const listener of [...listeners]) listener();
}

/** store 的 useSyncExternalStore 订阅面 */
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** store 快照（引用稳定，未变时返回同一对象） */
function getTarget(): RemoteWindowTarget | null {
  return currentTarget;
}

/**
 * 打开整窗浮层（桌面端调用）。
 *
 * @param next - 目标会话；重复打开同一会话幂等，换会话则整体替换
 */
export function openRemoteWindow(next: RemoteWindowTarget): void {
  log.info('打开远程窗口', { sessionId: next.sessionId, hostAlias: next.hostAlias });
  currentTarget = next;
  publish();
}

/** 收起浮层（lease 由组件 effect 清理时 release；远端会话保留） */
export function closeRemoteWindow(): void {
  if (currentTarget !== null) {
    currentTarget = null;
    publish();
  }
}

/** 浮层 props（locale 面由 slots 框架注入） */
export interface RemoteWindowOverlayProps {
  /** 命名空间绑定的翻译函数 */
  t: (key: RemoteExplorerLocaleKey) => string;
}

/** 把未知异常归一成展示文本 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 整窗浮层入口（注册在 shell.overlay；渲染 null，真正 DOM 挂 body 由 effect 管理）。
 *
 * @param props - locale 注入面
 * @returns 恒 null（浮层不在 slot 树里渲染，见文件头）
 */
export function RemoteWindowOverlay(props: RemoteWindowOverlayProps): ReactNode {
  const { t } = props;

  // 诊断标记：确认组件是否被 React 挂载（绕过 console 限制）
  const target = React.useSyncExternalStore(subscribe, getTarget);

  React.useEffect(() => {
    if (target === null) return;
    log.info('远程窗口浮层启动', { sessionId: target.sessionId });
    const bridge = desktopBrowser();
    let disposed = false;
    let lease: string | undefined;
    let offOpenRequested: (() => void) | undefined;
    // 首屏渲染看门狗定时器（effect 级持有，卸载时必须清理）
    let bootTimer: ReturnType<typeof setTimeout> | undefined;

    // ---- body 级容器：最高 z-index 盖住主窗口一切网页内容 ----
    // 浮层从 top:0 铺满整窗，不再用 top 让位——改为在浮层内部顶部放一条不透明
    // 遮蔽条盖住 caption 行。caption 行里有网页内渲染的控件（侧栏开关、品牌图标
    // /New Session 按钮、可拖拽区），远程会话中它们操作的是宿主窗口界面、不该
    // 可见可点；右上角的最小化/最大化/关闭按钮由 Electron 原生绘制、永远在网页
    // 之上，会自然盖在遮蔽条上面，仍然可见可用。
    //
    // 遮蔽条高度来自 overlayTopInset：优先吃 dsh 本体发布在根元素上的 CSS 变量
    // --dsh-frame-chrome-top（语义即 chrome 顶部带宽，且全屏归零）→ 回退
    // --dsh-frame-top-clearance → 平台标记硬编码。写成 CSS var() 链而非读 JS
    // 计算值：var() 会随全屏切换自动重算，JS 读到的是挂载瞬间的快照，用户切
    // 全屏就失效。
    //
    // webview 与状态层用 top 偏移到遮蔽条底部（不能用 padding-top：绝对定位
    // 子元素的包含块是内边距盒，padding 移不动 inset:0 的子元素）。
    const topInset = overlayTopInset(adaptOverlayRoot(document.documentElement));
    const container = document.createElement('div');
    container.style.cssText = 'position:fixed;left:0;right:0;bottom:0;top:0;z-index:2147483647;'
      + 'background:var(--dsw-alias-bg-base,#101014);';
    // caption 遮蔽条：不透明、全宽、盖住 caption 行中网页内渲染的控件。
    // Electron 原生 caption 按钮画在网页之上，会自然盖在此条上面（仍可见可用）。
    // 高度用 var() 链随全屏切换自动归零——全屏时无原生控件也无 caption 行。
    //
    // -webkit-app-region: drag 让遮蔽条成为窗口拖拽区——与原 caption 行行为一致：
    // 原来被遮蔽的 caption 行本身就是可拖拽区（dsh .frame::before 带 app-region: drag，
    // macOS topStrip 带 data-window-drag）。不加这条属性时，鼠标在遮蔽条上拖动会
    // 命中被遮蔽的底层按钮（toggle/New Session），弹出禁止点击光标——不符合用户习惯。
    // Electron 原生 caption 按钮画在更上层且自带 no-drag，不受此声明影响。
    //
    // 背景色按平台区分：
    // - Windows：caption 行原背景是 --dsw-specific-sidebar-fill（见 dsh AppFrame.module.css
    //   .frame::before），遮蔽条用同色与原 caption 行无缝衔接
    // - macOS：frame 透明（靠窗口 vibrancy），sidebarCol 是半透明渐变——纯色无法匹配
    //   vibrancy，用 --dsw-alias-bg-base 让远端界面从顶部起一体（视觉上 caption 行
    //   变成了内容区底色，比色差更自然）
    // 用 CSS var() 链回退：优先 sidebar-fill（Windows），缺失时回退 bg-base（macOS/网页）
    const captionBar = document.createElement('div');
    captionBar.style.cssText = `position:absolute;left:0;right:0;top:0;height:${topInset};`
      + 'background:var(--dsw-specific-sidebar-fill,var(--dsw-alias-bg-base,#101014));'
      + 'z-index:2;-webkit-app-region:drag;';
    // 状态层（加载/错误/断开中）：不透明、压在 webview 之上（z-index:1），
    // 居中文字；就绪后隐藏让位给 webview。webview 本身全程可见——Electron 的
    // guest view 在 display:none 下 attach 拿不到真实尺寸、之后显示也不重新
    // 布局（实测只渲染顶部一条、下面全白），所以绝不能用隐藏 webview 来做加载态。
    // top 偏移到遮蔽条底部（caption 行下方），不覆盖 caption 遮蔽条。
    const status = document.createElement('div');
    status.style.cssText = `position:absolute;left:0;right:0;bottom:0;top:${topInset};z-index:1;`
      + 'display:flex;flex-direction:column;gap:14px;'
      + 'align-items:center;justify-content:center;color:#e5e5e5;font-size:13px;'
      + 'font-family:inherit;text-align:center;padding:24px;white-space:pre-wrap;'
      + 'background:var(--dsw-alias-bg-base,#101014);';
    status.textContent = t('overlayLoading');
    container.appendChild(captionBar);
    container.appendChild(status);
    document.body.appendChild(container);

    /**
     * 显示状态文字；可附带一个「重试」按钮。
     *
     * @param message - 展示文案（可含换行）
     * @param retry - 可选重试动作；提供时在文案下方渲染重试按钮
     */
    const showStatus = (message: string, retry?: () => void): void => {
      status.textContent = message;
      if (retry !== undefined) {
        const button = document.createElement('button');
        button.textContent = t('retry');
        button.style.cssText = 'padding:6px 18px;border-radius:6px;border:1px solid rgba(255,255,255,.3);'
          + 'background:rgba(255,255,255,.08);color:inherit;font-size:13px;font-family:inherit;cursor:pointer;'
          + 'white-space:nowrap;';
        button.addEventListener('click', () => {
          // 立刻切回加载态并禁用自身：否则双击会并发两条 loadURL + 两条看门狗链，
          // 而界面还停在旧错误文案上，看起来像「点了没反应」。retry 内部会重新
          // 渲染状态层（加载成功撤层，失败重建按钮）。
          button.disabled = true;
          button.style.opacity = '0.5';
          button.style.cursor = 'default';
          status.textContent = t('overlayLoading');
          retry();
        });
        status.appendChild(button);
      }
      status.style.display = 'flex';
    };
    /** 就绪：隐藏状态层，露出已铺满的 webview */
    const showWebview = (): void => {
      status.style.display = 'none';
    };

    /** 执行「关闭/停止并返回」：先盖住 webview，断开成功后收起浮层 */
    const runStop = (sessionId: string, stop: boolean): void => {
      showStatus(stop ? t('overlayStoppingRemote') : t('overlayStopping'));
      void postDisconnect(sessionId, stop)
        .then(() => { closeRemoteWindow(); })
        .catch((error: unknown) => {
          if (!disposed) showStatus(`${messageOf(error)}\n${t('overlayReturnHint')}`);
        });
    };

    /**
     * 解析并执行一个意图 URL；非意图 origin 返回 false（放行给远程页面自身导航）。
     *
     * @param url - onOpenRequested / will-navigate 带来的 URL
     * @returns 是否已消费为意图
     */
    const handleIntentUrl = (url: string): boolean => {
      if (!url.startsWith(OVERLAY_INTENT_ORIGIN)) return false;
      const match = /#handoff-(disconnect|stop)=([^&]+)/.exec(url);
      if (match !== null) {
        runStop(decodeURIComponent(match[2] ?? ''), match[1] === 'stop');
        return true;
      }
      // 裸 origin（来自 handoff「返回本地管理页」的 window.open）= 回退主窗口
      closeRemoteWindow();
      return true;
    };

    /**
     * 外开去重窗口（毫秒）：同一 URL 在窗口内只交给系统浏览器一次。
     *
     * 必要性：`will-navigate` 外开之后，若该次跨站导航仍在 `stop()` 前提交，
     * `did-navigate` 兜底会再外开一次；服务端持续 302 到同一跨站地址时也会
     * 反复命中。去重让这些竞态都收敛成「只开一个标签页」。
     */
    const EXTERNAL_DEDUPE_MS = 3_000;
    /** 最近一次交给系统浏览器的 URL 与时间 */
    let lastExternal: { url: string; at: number } | undefined;

    /**
     * 在系统默认浏览器打开外部链接。
     *
     * 桌面壳不允许网页创建新 OS 窗口：宿主文档的 `window.open` 会命中主进程的
     * `setWindowOpenHandler`（http/https → `shell.openExternal`，其余拒绝），
     * 因此这里只需把 URL 交给宿主——与壳处理所有普通链接的既有行为一致。
     *
     * @param url - 已判定为外部链接的 http(s) URL
     */
    const openExternal = (url: string): void => {
      const now = Date.now();
      if (
        lastExternal !== undefined
        && lastExternal.url === url
        && now - lastExternal.at <= EXTERNAL_DEDUPE_MS
      ) {
        log.debug('同一外链在去重窗口内重复请求，跳过', { url });
        return;
      }
      lastExternal = { url, at: now };
      window.open(url, '_blank', 'noopener,noreferrer');
    };

    // Esc 兜底（仅宿主 document 有焦点时生效；webview 夺焦后收不到，以 handoff pill 为准）
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closeRemoteWindow();
    };
    window.addEventListener('keydown', onKeyDown);

    if (bridge === undefined) {
      // 防御性兜底：浏览器端不会调 openRemoteWindow，这里只保证不崩、可 Esc 退出
      log.warn('bridge 不可用，显示错误状态');
      showStatus(`${t('overlayLeaseFailed')}\n${t('overlayReturnHint')}`);
    } else {
      // 1. 预约 lease（workspace id 按会话隔离 → 远端 cookie 各会话独立）
      log.info('开始 acquire lease...');
      void bridge.acquire(`dsh-remote-explorer:${target.sessionId}`)
        .then((result) => {
          log.info('lease 获取成功', { lease: result.lease, partition: result.partition });
          if (disposed) { void bridge.release(result.lease).catch(() => {}); return; }
          lease = result.lease;
          // 2. 创建 webview（与第一方 ui-sidebar-browser 的 ElectronWebviewPresentation 对齐）：
          //    - partition + about:blank#<lease> 供主进程 will-attach-webview 校验放行；
          //    - allowpopups 必须显式设置：Electron <webview> 默认 disablePopups=true，
          //      而桌面壳在 will-attach-webview 里特意保留了 disablePopups；缺少该属性
          //      会让 guest 的 window.open() 在到达 setWindowOpenHandler 前就被掐死，
          //      导致 browserOpenRequested / onOpenRequested 永远收不到任何链接
          //      （壳的 guest setWindowOpenHandler 仍一律 deny，不会弹出失控窗口）
          const element = document.createElement('webview') as unknown as WebViewElement;
          element.setAttribute('name', result.lease);
          element.setAttribute('partition', result.partition);
          element.setAttribute('allowpopups', '');
          element.setAttribute('src', `about:blank#${result.lease}`);
          // webview 全程可见（隐藏 attach 会丢尺寸，见状态层注释）；加载态由
          // 不透明状态层盖住，就绪后隐藏状态层即可。top 偏移到遮蔽条底部
          // （caption 行下方），不覆盖 caption 遮蔽条。
          // 不用 height:100%——包含块是整窗高度，加 top 偏移后 100% 会溢出底部
          // （底部内容被截到窗口外）。用 top+bottom:0 撑满遮蔽条下方的剩余空间。
          element.style.cssText = `position:absolute;left:0;right:0;bottom:0;top:${topInset};border:none;`;
          // 3. handoff「返回」经 window.open 被桌面壳转发到这里；壳对 guest 的
          //    window.open 一律 deny、只把 URL 转发过来，所以外部链接必须自己
          //    交给系统浏览器（否则点了没反应），同 origin 的则要在浮层内导航
          //    （否则同样「没反应」——远端 dsh 里 target="_blank" 的会话/设置
          //    链接就走这条路径）。注册必须在 element 创建之后：回调要用 element。
          offOpenRequested = bridge.onOpenRequested(result.lease, (url) => {
            if (handleIntentUrl(url)) return;
            if (shouldOpenExternally(url, target.url)) {
              openExternal(url);
              return;
            }
            if (isSameSessionOrigin(url, target.url)) {
              log.info('同站 window.open 在浮层内导航', { url });
              void element.loadURL(url).catch(() => { /* 失败由 did-fail-load 兜底 */ });
              return;
            }
            // 非 http(s)（mailto: / blob: / dsh-resource: 等）不归本策略管
            log.debug('onOpenRequested 忽略非 http(s) 链接', { url });
          });
          // 4. 导航兜底状态：lastSessionUrl = 最近一次停留在远端会话同 origin
          //    下的地址（跨站导航被拦下后重载回它）；interceptingExternal =
          //    当前跨站导航是否已由 will-navigate 外开过，避免 did-navigate 重复外开
          let lastSessionUrl = target.url;
          // 标记当前跨站导航是否已由 will-navigate 触发过外开，避免 did-navigate 兜底重复打开
          let interceptingExternal = false;
          // 跨站导航自动回退的次数上限与统计窗口：服务端持续 302 到外部域时，
          // 「外开 → 回退 → 再外开」必须有尽头上限，否则会不断弹系统浏览器标签
          const MAX_EXTERNAL_RECOVERIES = 3;
          const EXTERNAL_RECOVERY_WINDOW_MS = 60_000;
          let externalRecoveries = 0;
          let externalRecoverySince = 0;
          const stopNavigation = (): void => {
            try { element.stop(); } catch { /* guest 尚未就绪或已销毁 */ }
          };
          // 首屏渲染看门狗的定时器与代际号。
          // clearBootTimer 只能取消尚未触发的 setTimeout，取消不了已经挂在
          // `await executeJavaScript` 里的 check——这种「迟到的 check」会把新一轮
          // 刚展示的错误层又盖掉、或再挂一条并行轮询链，所以用代际号让过期轮次退出。
          let bootGeneration = 0;
          const clearBootTimer = (): void => {
            bootGeneration += 1;
            if (bootTimer !== undefined) {
              clearTimeout(bootTimer);
              bootTimer = undefined;
            }
          };
          /**
           * 轮询 guest 的主挂载容器是否已有内容：渲染出来才撤加载层；
           * 超过上限仍是空白则给出「重试」，避免空白页面直接亮成白屏。
           */
          const startBootWatchdog = (): void => {
            bootGeneration += 1;
            const generation = bootGeneration;
            const startedAt = Date.now();
            const check = async (): Promise<void> => {
              if (disposed || generation !== bootGeneration) return;
              let children = -1;
              try {
                const value = await element.executeJavaScript(
                  // 主挂载点 #root，并兼容改名后的 #app：两者任一有子元素即算已渲染。
                  // 不用 body 兜底——body 里的 <script> 也是子元素，白屏时会误判成
                  // 渲染完成，看门狗就形同虚设。
                  // 只读探测不需要用户手势：别白送 guest 剪贴板写/全屏等手势能力。
                  '(document.getElementById("root")?.childElementCount ?? 0)'
                    + ' || (document.getElementById("app")?.childElementCount ?? 0)',
                  false,
                );
                children = typeof value === 'number' ? value : -1;
              } catch {
                // executeJavaScript 不可用（旧壳/受限分区）：无法探测，直接放行，
                // 宁可露出 webview 也不要把用户卡在加载层
                if (!disposed && generation === bootGeneration) showWebview();
                return;
              }
              if (disposed || generation !== bootGeneration) return;
              if (children > 0) {
                // 成功即收尾：清掉句柄，避免留下「还有定时器」的残留语义
                bootTimer = undefined;
                showWebview();
                return;
              }
              if (Date.now() - startedAt >= BOOT_WATCHDOG_MS) {
                log.warn('远程界面长时间空白，疑似首屏资源加载失败', { url: target.url });
                showStatus(`${t('overlayBootStalled')}\n${t('overlayReturnHint')}`, loadRemote);
                return;
              }
              bootTimer = setTimeout(() => { void check(); }, BOOT_POLL_MS);
            };
            void check();
          };
          // 同一次主框架失败会同时触发 did-fail-load 与 loadURL 的 reject，
          // 用标记保证「加载失败」状态层只展示一次（否则两条日志 + 层被重建两次）
          let loadFailureShown = false;
          /**
           * 统一展示「加载失败 + 重试」状态层（幂等）。
           *
           * @param detail - 失败详情（错误消息或 Chromium 错误描述）
           */
          const reportLoadFailure = (detail: string): void => {
            if (disposed || loadFailureShown) return;
            loadFailureShown = true;
            clearBootTimer();
            showStatus(`${t('loadError')}：${detail}\n${t('overlayReturnHint')}`, loadRemote);
          };
          /**
           * 加载远端页面：主文档 load 后启动渲染看门狗（见上），
           * 失败则给出带「重试」的状态层。
           */
          const loadRemote = (): void => {
            clearBootTimer();
            loadFailureShown = false;
            log.info('webview 加载远端页面', target.url);
            void element.loadURL(target.url)
              .then(() => {
                if (disposed) return;
                log.info('主文档已加载，等待首屏渲染');
                startBootWatchdog();
              })
              .catch((error: unknown) => {
                const text = messageOf(error);
                // stop()（跨站导航拦截）或新导航取消在途加载时会以 ERR_ABORTED 拒绝，
                // 与下面 did-fail-load 的口径保持一致：不是真实失败，不能盖状态层，
                // 否则会把本来正常的远端界面盖成「加载失败」
                if (text.includes('ERR_ABORTED')) return;
                log.error('loadURL 失败', text);
                reportLoadFailure(text);
              });
          };
          // 4. 首次 dom-ready（about:blank#lease 就绪 = attach 通过）后 loadURL
          element.addEventListener('dom-ready', () => {
            if (element.dataset.loaded === '1') return;
            element.dataset.loaded = '1';
            loadRemote();
          });
          // 主框架加载失败（DNS/连接重置/首屏资源被重连打断等）时给出重试入口，
          // 而不是留下空白网页。ERR_ABORTED 是 stop()/新导航主动取消，忽略。
          element.addEventListener('did-fail-load', (event) => {
            const failure = event as WebViewFailLoadEvent;
            if (failure.isMainFrame === false) return;
            if (failure.errorCode === ERR_ABORTED) return;
            log.warn('webview did-fail-load', { code: failure.errorCode, desc: failure.errorDescription });
            reportLoadFailure(failure.errorDescription ?? String(failure.errorCode));
          });
          // 5. handoff「返回/关闭/停止」经 location.href 触发主框架导航，这里截获；
          //    其余跨 origin 导航会把整个浮层带走（远端界面消失），拦下改走系统浏览器，
          //    同 origin 放行以保留远端 dsh 的 SPA 路由。
          //    注意：Electron <webview> 的 will-navigate 是不可取消的通知事件
          //    （WebViewImpl.dispatchEvent 用 new Event(e) 派发），event.preventDefault()
          //    无效，必须显式调用 element.stop()，并配 did-navigate 兜底防竞态提交。
          element.addEventListener('will-navigate', (event) => {
            const url = (event as WebViewNavigateEvent).url ?? element.getURL();
            if (handleIntentUrl(url)) {
              stopNavigation();
              return;
            }
            if (!shouldOpenExternally(url, target.url)) return;
            interceptingExternal = true;
            stopNavigation();
            openExternal(url);
          });
          element.addEventListener('did-navigate', (event) => {
            const url = (event as WebViewNavigateEvent).url ?? element.getURL();
            if (url.startsWith(OVERLAY_INTENT_ORIGIN)) {
              interceptingExternal = false;
              return;
            }
            if (isSameSessionOrigin(url, target.url)) {
              interceptingExternal = false;
              lastSessionUrl = url;
              return;
            }
            if (!shouldOpenExternally(url, target.url)) {
              interceptingExternal = false;
              return;
            }
            // stop() 竞态未拦住，或服务端 302 跨站重定向已提交：补开一次系统浏览器，
            // 再把浮层拉回上一个远端会话地址。
            // 反复命中（服务端持续把会话地址重定向到外部域）时不能无限「外开 →
            // 回退 → 再外开」——那样每轮都多开一个标签页且永远回不去，超过上限
            // 就停手并把失败原因与重试入口交给用户。
            if (!interceptingExternal) openExternal(url);
            interceptingExternal = false;
            const now = Date.now();
            if (now - externalRecoverySince > EXTERNAL_RECOVERY_WINDOW_MS) {
              externalRecoverySince = now;
              externalRecoveries = 0;
            }
            externalRecoveries += 1;
            if (externalRecoveries > MAX_EXTERNAL_RECOVERIES) {
              log.warn('跨站导航反复提交，停止自动回退', { url, recoveries: externalRecoveries });
              reportLoadFailure(url);
              return;
            }
            // 直接用 loadURL 重载会话地址，不用 goBack：canGoBack 时 goBack 可能
            // 落到 webview 初始化时的 about:blank#<lease>（loadURL 是压入历史而非
            // 替换），那样浮层会永久空白——看门狗与重试入口都不会再启动。
            void element.loadURL(lastSessionUrl).catch(() => { /* 失败由 did-fail-load 兜底 */ });
          });
          element.addEventListener('did-navigate-in-page', (event) => {
            const nav = event as WebViewInPageNavigateEvent;
            if (nav.isMainFrame === false) return;
            const url = nav.url ?? element.getURL();
            if (isSameSessionOrigin(url, target.url)) lastSessionUrl = url;
          });
          // 加载结束复位标记：stop() 中止导航时 did-stop-loading 也会派发，可能先于
          // did-navigate 把标记清掉；即便因此走到 did-navigate 的「补开一次」分支，
          // openExternal 的 URL + 时间窗去重也会把它收敛掉，不会真的多开标签页
          element.addEventListener('did-stop-loading', () => {
            interceptingExternal = false;
          });
          container.appendChild(element);
        })
        .catch((error: unknown) => {
          log.error('acquire 失败', messageOf(error));
          if (!disposed) showStatus(`${t('overlayLeaseFailed')}：${messageOf(error)}\n${t('overlayReturnHint')}`);
        });
    }

    return () => {
      disposed = true;
      window.removeEventListener('keydown', onKeyDown);
      offOpenRequested?.();
      // 清理首屏渲染看门狗，避免卸载后仍轮询已销毁的 guest
      if (bootTimer !== undefined) {
        clearTimeout(bootTimer);
        bootTimer = undefined;
      }
      // lease 校验只认签发者，泄漏会占住 workspace partition——失败也只吞
      if (lease !== undefined && bridge !== undefined) {
        void bridge.release(lease).catch(() => { /* 窗口销毁竞态，主进程侧随窗口回收 */ });
      }
      container.remove();
    };
  }, [target, t]);

  return null;
}

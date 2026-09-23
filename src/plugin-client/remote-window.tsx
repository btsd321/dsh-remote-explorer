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
 * 已知取舍：应用重载后浮层不自动恢复（lease 是进程生命周期），从面板重开即可；
 * webview 夺焦后宿主收不到键盘事件，故 Esc 仅在加载阶段可靠，之后以 handoff pill 为准。
 */

import * as React from 'react';
import type { ReactNode } from 'react';
import { desktopBrowser } from './desktop-bridge.js';
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

/** Electron webview 元素的最小扩展面（loadURL/getURL 由 Electron 注入，DOM 标准类型没有） */
interface WebViewElement extends HTMLWebViewElement {
  /** 导航到指定 URL（返回 Promise，加载失败 reject） */
  loadURL(url: string): Promise<void>;
  /** 当前 URL */
  getURL(): string;
}

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

    // ---- body 级容器：最高 z-index 盖住主窗口一切网页内容 ----
    const container = document.createElement('div');
    container.style.cssText = 'position:fixed;inset:0;z-index:2147483647;'
      + 'background:var(--dsw-alias-bg-base,#101014);';
    // 状态层（加载/错误/断开中）：不透明、压在 webview 之上（z-index:1），
    // 居中文字；就绪后隐藏让位给 webview。webview 本身全程可见——Electron 的
    // guest view 在 display:none 下 attach 拿不到真实尺寸、之后显示也不重新
    // 布局（实测只渲染顶部一条、下面全白），所以绝不能用隐藏 webview 来做加载态
    const status = document.createElement('div');
    status.style.cssText = 'position:absolute;inset:0;z-index:1;display:flex;'
      + 'align-items:center;justify-content:center;color:#e5e5e5;font-size:13px;'
      + 'font-family:inherit;text-align:center;padding:24px;white-space:pre-wrap;'
      + 'background:var(--dsw-alias-bg-base,#101014);';
    status.textContent = t('overlayLoading');
    container.appendChild(status);
    document.body.appendChild(container);

    /** 显示状态文字（不透明层盖住 webview，避免意图导航失败页闪现） */
    const showStatus = (message: string): void => {
      status.textContent = message;
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
          // 2. handoff「返回」经 window.open 被桌面壳转发到这里
          offOpenRequested = bridge.onOpenRequested(result.lease, (url) => { handleIntentUrl(url); });
          // 3. 创建 webview（about:blank#<lease> + partition，主进程据此校验放行）
          const element = document.createElement('webview') as unknown as WebViewElement;
          element.setAttribute('src', `about:blank#${result.lease}`);
          element.setAttribute('partition', result.partition);
          // webview 全程可见（隐藏 attach 会丢尺寸，见状态层注释）；加载态由
          // 不透明状态层盖住，就绪后隐藏状态层即可
          element.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:none;';
          // 4. 首次 dom-ready（about:blank#lease 就绪 = attach 通过）后 loadURL
          element.addEventListener('dom-ready', () => {
            if (element.dataset.loaded === '1') return;
            element.dataset.loaded = '1';
            log.info('webview dom-ready，开始 loadURL', target.url);
            element.loadURL(target.url)
              .then(() => {
                log.info('loadURL 成功，显示 webview');
                if (!disposed) showWebview();
              })
              .catch((error: unknown) => {
                log.error('loadURL 失败', messageOf(error));
                if (!disposed) showStatus(`${t('overlayLeaseFailed')}：${messageOf(error)}\n${t('overlayReturnHint')}`);
              });
          });
          // 5. handoff「关闭/停止并返回」经 location.href 触发主框架导航，这里截获
          element.addEventListener('will-navigate', (event) => {
            const url = (event as unknown as { url?: string }).url ?? element.getURL();
            handleIntentUrl(url);
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
      // lease 校验只认签发者，泄漏会占住 workspace partition——失败也只吞
      if (lease !== undefined && bridge !== undefined) {
        void bridge.release(lease).catch(() => { /* 窗口销毁竞态，主进程侧随窗口回收 */ });
      }
      container.remove();
    };
  }, [target, t]);

  return null;
}

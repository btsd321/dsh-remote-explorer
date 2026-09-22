/**
 * @file 桌面壳（DeepSeek Harness Electron）能力探测与 browser lease 桥
 * @description 桌面壳的 preload 只在应用文档（dsh-app://app）暴露 window.dshDesktop，
 *              其中 browser 键是应用内 webview 的唯一合法通道：lease 由主进程签发并
 *              校验（will-attach-webview 只认 about:blank#<lease> 且 partition 匹配的
 *              元素），guest 被强制 sandbox/contextIsolation/无 Node。
 *
 * 环境判别约束（反编译 app.asar 实测事实）：
 * - 桌面壳是单 OS 窗口：所有 http/https 的 window.open 与跨 origin 导航都被主进程
 *   拦截并甩给系统浏览器（setWindowOpenHandler / will-navigate），插件拿不到
 *   「开新 OS 窗口」的任何通道
 * - 网页形态（浏览器直连 dsh web / dev-plugin 沙箱）没有 preload，window.dshDesktop
 *   恒为 undefined——isDesktopShell() 返回 false，面板走浏览器分支
 */

/** 桌面壳 preload 暴露的浏览器 lease 桥（形状与 preload-app.cjs 的 createDesktopBrowserBridge 一致） */
export interface DesktopBrowserBridge {
  /**
   * 预约一个 guest：workspace 是持久存储身份（≤4096 字符），同一 workspace 复用
   * 同一 partition（cookie 隔离边界）；返回的 lease 只在当前进程生命周期内有效
   *
   * @param workspace - workspace 存储身份
   * @returns lease（webview 创建凭证）与 partition（webview 属性必须原样带上）
   */
  acquire(workspace: string): Promise<{ lease: string; partition: string }>;
  /**
   * 释放 lease 并销毁 guest；workspace 的持久存储保留。
   *
   * @param lease - acquire 返回的凭证
   */
  release(lease: string): Promise<void>;
  /**
   * 订阅 webview 内的 window.open 请求（主进程已 deny 弹窗，只把 URL 转发出来）。
   *
   * @param lease - lease 凭证
   * @param listener - 请求回调
   * @returns 退订函数
   */
  onOpenRequested(lease: string, listener: (url: string) => void): () => void;
}

/** window.dshDesktop 的最小形状（网页形态下整个对象不存在） */
interface DshDesktopBridge {
  /** 桌面桥协议版本（恒 1） */
  protocolVersion: number;
  /** 浏览器 lease 桥；仅应用文档（dsh-app://app）存在 */
  browser?: DesktopBrowserBridge;
}

declare global {
  interface Window {
    /** 桌面壳注入的产品桥；网页形态下不存在 */
    dshDesktop?: DshDesktopBridge;
  }
}

/**
 * 是否运行在桌面壳里（dsh-app://app 文档）。
 *
 * @returns true = 桌面端（可用 webview lease 通道）；false = 浏览器端
 */
export function isDesktopShell(): boolean {
  return typeof window.dshDesktop === 'object'
    && typeof window.dshDesktop.browser?.acquire === 'function';
}

/**
 * 取浏览器 lease 桥（仅桌面端存在）。
 *
 * @returns 桥实例；浏览器端 undefined
 */
export function desktopBrowser(): DesktopBrowserBridge | undefined {
  return window.dshDesktop?.browser;
}

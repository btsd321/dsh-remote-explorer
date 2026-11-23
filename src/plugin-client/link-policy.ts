/**
 * @file 远程浮层的链接外开策略
 * @description 判断浮层 webview 里的 URL 应该留在浮层里，还是交给系统浏览器。
 *
 * 桌面壳的两个既定行为决定了必须有这层判断：
 * - guest 的 `window.open` 一律被壳 deny，只把 URL 作为 `browserOpenRequested`
 *   事件转发给宿主（插件半）；
 * - guest 的主框架 http(s) 导航壳不拦，跨站导航会把整个浮层带走、远端界面消失。
 *
 * 判据只有两条：
 * - 只处理 http/https——`mailto:`、`blob:`、`dsh-resource:` 等不归本策略管；
 * - 与远端会话页面同 origin 的留在浮层（远端 dsh 的 SPA 路由、设置页），
 *   其余 http(s) 视为外部链接，交给系统浏览器。
 *
 * 纯函数、不依赖 DOM，便于单测。
 */

/**
 * 判断 URL 是否应交给系统浏览器打开。
 *
 * @param url - 待判断的 URL（webview 事件均给绝对地址）
 * @param sessionUrl - 远端会话页面地址（浮层 `loadURL` 用的本地转发地址，含令牌）
 * @returns true = 交系统浏览器；false = 留在浮层，或不是 http(s)，或 URL 非法
 */
export function shouldOpenExternally(url: string, sessionUrl: string): boolean {
  let target: URL;
  let session: URL;
  try {
    target = new URL(url);
    session = new URL(sessionUrl);
  } catch {
    // 任一地址解析失败都不外开：浮层里报错好过把用户甩到系统浏览器
    return false;
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return false;
  return target.origin !== session.origin;
}

/**
 * 判断 URL 是否与远端会话页面同 origin（且为 http/https）。
 *
 * 用于记录最近一次停留在远端会话内的地址：当跨站主框架导航在 `stop()` 前
 * 竞态提交时，浮层可回退到最近一次远端页面地址，而不是被 `about:blank#<lease>`
 * 或非 http(s) 地址污染。
 *
 * @param url - 待判断的 URL
 * @param sessionUrl - 远端会话页面地址
 * @returns true = 同 origin 的 http(s) 地址；false = 跨站、非 http(s) 或非法
 */
export function isSameSessionOrigin(url: string, sessionUrl: string): boolean {
  let target: URL;
  let session: URL;
  try {
    target = new URL(url);
    session = new URL(sessionUrl);
  } catch {
    return false;
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return false;
  return target.origin === session.origin;
}

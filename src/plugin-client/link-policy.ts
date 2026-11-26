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

/** 是否为 http(s) 协议（本策略只处理这两种） */
function isHttpUrl(url: URL): boolean {
  return url.protocol === 'http:' || url.protocol === 'https:';
}

/**
 * 解析目标 URL 与会话 URL，并校验两侧都是 http(s)。
 *
 * 两个导出判据共用这一份解析：只差最后一行 origin 的比较（`!==` / `===`），
 * 分开写会因为协议白名单、origin 归一化规则改动而不同步，导致两个判据不再互补。
 *
 * @param url - 待判断的 URL
 * @param sessionUrl - 远端会话页面地址
 * @returns 两侧都合法时为解析结果，否则 undefined
 */
function parseHttpOrigins(
  url: string,
  sessionUrl: string,
): { target: URL; session: URL } | undefined {
  let target: URL;
  let session: URL;
  try {
    target = new URL(url);
    session = new URL(sessionUrl);
  } catch {
    return undefined;
  }
  // sessionUrl 也必须是 http(s)：非 http(s) 的 URL（例如 about:blank#<lease>）解析
  // 会成功但 origin 退化成字符串 "null"，于是任何 http(s) 目标都被判成跨站——
  // 与「解析失败一律不外开」的保守取向相反
  if (!isHttpUrl(target) || !isHttpUrl(session)) return undefined;
  return { target, session };
}

/**
 * 判断 URL 是否应交给系统浏览器打开。
 *
 * @param url - 待判断的 URL（webview 事件均给绝对地址）
 * @param sessionUrl - 远端会话页面地址（浮层 `loadURL` 用的本地转发地址，含令牌）
 * @returns true = 交系统浏览器；false = 留在浮层，或不是 http(s)，或 URL 非法
 */
export function shouldOpenExternally(url: string, sessionUrl: string): boolean {
  const parsed = parseHttpOrigins(url, sessionUrl);
  // 任一侧非法都不外开：浮层里报错好过把用户甩到系统浏览器
  if (parsed === undefined) return false;
  return parsed.target.origin !== parsed.session.origin;
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
  const parsed = parseHttpOrigins(url, sessionUrl);
  if (parsed === undefined) return false;
  return parsed.target.origin === parsed.session.origin;
}

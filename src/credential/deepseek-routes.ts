/**
 * @file DeepSeek 账号相关通道的代理路由表
 * @description 隧道代理的「平台」与「通知」两类路由定义，供
 *              [tunnel-proxy.ts](tunnel-proxy.ts) 在本机已登录 DeepSeek 账号时
 *              并入总路由表。两类请求都只带 `x-dsh-auth-token`（占位令牌），
 *              由代理替换为真实 account token，因此没有 keyEnv。
 *
 * 两个 origin 的职责（dsh 0.2.2-rc.2 起分离）：
 * - `platformOrigin`：登录/资料/余额/登出（`/auth-api/*` 与 `/api/v0/*`）
 * - `harnessOrigin`：账号通知（`/api/v0/users/notifications/*`）
 *
 * 不 patch harnessOrigin 时，远端会拿占位 grant 直连生产 harness；无效 token
 * 得到「HTTP 200 + 业务码 40003」，dsh 的账号插件把 40003 视为凭据失效并
 * **删除本地 grant**——界面表现为账号被登出。把通知也引回隧道后，替换成真实
 * token 的请求由本机发出，远端只看到正常结果。
 *
 * 路径换算契约见 [proxy-route-match.ts](proxy-route-match.ts)：远端请求路径含
 * 完整前缀，而换算会裁掉 prefix，所以 **upstreamPath 必须与 prefix 同值**。
 *
 * 分层约束：本文件属能力层，只依赖同层类型，零 IO。
 */

import type { ProxyRoute } from './provider-routes.js';

/** DeepSeek 平台 API 的 origin（登录/资料/余额/登出） */
const PLATFORM_ORIGIN = 'https://platform.deepseek.com';

/** 平台 API 的路径前缀（`platformOrigin` 是纯 origin，路径由前缀区分） */
const PLATFORM_PREFIXES = ['/auth-api', '/api/v0'];

/** DeepSeek Harness 通知 API 的 origin */
const HARNESS_ORIGIN = 'https://harness.deepseek.com';

/**
 * 通知接口的路径前缀。
 *
 * 比平台的 `/api/v0` 更具体——路由匹配取最长前缀，保证通知请求落在
 * harness 而不是 platform。
 */
const HARNESS_NOTIFICATION_PREFIX = '/api/v0/users/notifications';

/** 一条账号通道路由（构造即最终形状，upstreamPath 恒等于 prefix） */
type AccountRoute = Readonly<ProxyRoute>;

/**
 * 账号通道路由清单（顺序无关，匹配按最长前缀）。
 *
 * upstreamPath 与 prefix 同值——保留远端请求的完整路径前缀；漏写会静默丢掉
 * 前缀，上游回落到 SPA HTML。
 */
const ACCOUNT_ROUTES: readonly AccountRoute[] = [
  ...PLATFORM_PREFIXES.map(prefix => ({
    prefix,
    upstreamOrigin: PLATFORM_ORIGIN,
    upstreamPath: prefix,
    label: 'DeepSeek Platform',
  })),
  {
    prefix: HARNESS_NOTIFICATION_PREFIX,
    upstreamOrigin: HARNESS_ORIGIN,
    upstreamPath: HARNESS_NOTIFICATION_PREFIX,
    label: 'DeepSeek Harness 通知',
  },
];

/**
 * 构造账号通道的代理路由表。
 *
 * @returns 路由列表（平台 2 条 + 通知 1 条；每次返回独立副本，调用方可安全持有）
 */
export function deepseekAccountRoutes(): ProxyRoute[] {
  return ACCOUNT_ROUTES.map(route => ({ ...route }));
}

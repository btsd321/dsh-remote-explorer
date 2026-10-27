/**
 * @file 代理环境变量与 curl 代理参数的构造
 * @description 把「一个代理 URL → 一组代理环境变量」和「一个代理 URL → curl 的
 *              代理参数」这两件重复率极高的事收口到单一实现。
 *
 * 为什么放在基础层（util/）而不是 session/proxy-env.ts：同一份代理键清单
 * 有三个消费方，分属不同层——
 * - 编排层 session/proxy-env.ts 的 collectProxyEnv（注入远端 dsh 进程环境）
 * - 能力层 provision/ 的 dsh-installer / pnpm-installer（注入 npm install）
 * - 能力层 provision/ 的 node-installer / mirror-selector（curl 代理参数）
 *
 * provision/ 不能 import session/（下层不得 import 上层），此前只能各自复制
 * 这份 8 键清单，改一处必漏两处。下沉到基础层后三处共用同一实现。
 *
 * 键清单为何是八个：git 认小写、npm/curl 大小写皆可、Node 的 undici 认大写，
 * 全设是为了覆盖各自的读取习惯，不指望消费方统一。no_proxy 排除回环地址——
 * 经 SSH 反向隧道暴露的代理端口本身就在 127.0.0.1，走代理会形成循环。
 *
 * 分层约束：本文件属基础层，只依赖同层的 shell-quote；不感知连接状态。
 */

import { quote } from './shell-quote.js';

/**
 * 代理环境变量里的回环排除清单。
 *
 * 隧道代理的监听端永远在回环上，把它自己交给代理会形成循环。
 */
const LOOPBACK_NO_PROXY = '127.0.0.1,localhost,::1';

/**
 * 由一个代理 URL 展开出八个代理环境变量。
 *
 * 代理 URL 为空串或 undefined 时返回空对象（不注入任何变量——有网机器零影响）。
 *
 * @param proxyUrl - 代理 URL（如 `http://127.0.0.1:18890`）；空值表示不代理
 * @returns 可直接并入 exec env 的键值对
 */
export function buildProxyEnv(proxyUrl: string | undefined): Record<string, string> {
  if (proxyUrl === undefined || proxyUrl === '') return {};
  return {
    http_proxy: proxyUrl,
    HTTP_PROXY: proxyUrl,
    https_proxy: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    ALL_PROXY: proxyUrl,
    all_proxy: proxyUrl,
    no_proxy: LOOPBACK_NO_PROXY,
    NO_PROXY: LOOPBACK_NO_PROXY,
  };
}

/**
 * 构造 curl 的代理参数片段。
 *
 * curl 不读环境变量的场合（远端命令显式拼参数）用这个：返回形如
 * ` -x 'http://127.0.0.1:18890'` 的片段，调用方直接拼进 curl 命令行；
 * 无代理时返回空串，拼接结果与未加代理时逐字节一致。
 *
 * @param proxyUrl - 代理 URL；空值表示不代理
 * @returns 已转义的参数片段（含前导空格）或空串
 */
export function buildCurlProxyArg(proxyUrl: string | undefined): string {
  if (proxyUrl === undefined || proxyUrl === '') return '';
  return ` -x ${quote(proxyUrl)}`;
}

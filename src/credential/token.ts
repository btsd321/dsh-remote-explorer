/**
 * @file 代理令牌
 * @description 本机 LLM 代理与远端 dsh 之间的共享密钥：生成与常数时间比较。
 *
 * 这个令牌**不是** LLM key——它是「占位凭据」：远端 dsh 进程的环境变量里
 * 拿到的是这个随机值，请求经反向隧道回到本机代理后，代理校验它再换成真实 key。
 * 真实 key 全程不出本机。
 *
 * 令牌长度取 43 个 base64url 字符，与 dsh webserver 自己的访问令牌同规格。
 *
 * 分层约束：本文件属能力层，纯函数，不感知会话与传输。
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** 令牌熵（字节）；base64url 编码后为 43 字符 */
const TOKEN_BYTES = 32;

/**
 * 生成一个代理令牌。
 *
 * @returns 43 字符的 base64url 随机串
 */
export function generateProxyToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/**
 * 常数时间比较两个令牌是否相等。
 *
 * 先各自做 SHA-256 再 `timingSafeEqual`：哈希把长度归一到 32 字节，
 * 避开 timingSafeEqual 的等长要求，也不泄露长度信息。
 *
 * @param expected - 期望值（代理侧持有）
 * @param actual - 实际值（请求头里带来的）
 * @returns 是否相等
 */
export function tokenEquals(expected: string, actual: string): boolean {
  const expectedDigest = createHash('sha256').update(expected).digest();
  const actualDigest = createHash('sha256').update(actual).digest();
  return timingSafeEqual(expectedDigest, actualDigest);
}

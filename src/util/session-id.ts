/**
 * @file 会话标识计算
 * @description 由「主机别名 + 远端工作目录」算出确定性的会话 id。
 *
 * 为什么用确定性摘要而非随机值：重连时要能找回既有会话。同别名同目录得到
 * 同一个 id，于是探到既有会话且探活通过就直接复用、跳过引导；不同目录得到
 * 不同 id，各自拥有独立的 `DSH_HOME`，从而支持同主机多会话（决策 9）。
 *
 * 这对应 Zed 的 `proxy --identifier <标识>` 与 `--reconnect` 语义：
 * 客户端用稳定标识指认"我要的是哪个远端会话"。
 *
 * 分层约束：本文件属基础层，是纯函数，不感知传输与会话状态。
 */

import { createHash } from 'node:crypto';

/** 摘要保留的十六进制字符数：足够避免碰撞，又不会让远端路径过长 */
const DIGEST_LENGTH = 12;

/**
 * 计算会话 id。
 *
 * 结果形如 `orangepi-a1b2c3d4e5f6`——前缀取主机别名便于人工辨识远端目录，
 * 后缀是摘要保证唯一。
 *
 * @param hostAlias - SSH config 中的主机别名
 * @param remoteCwd - 远端工作目录绝对路径；未指定工作目录时传空串
 * @returns 会话 id，仅含小写字母、数字与连字符
 */
export function computeSessionId(hostAlias: string, remoteCwd: string): string {
  // 别名与目录之间用 \u0000 分隔：它不可能出现在两者中，
  // 因此不存在 ('a','bc') 与 ('ab','c') 撞成同一输入的问题
  const digest = createHash('sha256')
    .update(`${hostAlias}\u0000${remoteCwd}`)
    .digest('hex')
    .slice(0, DIGEST_LENGTH);

  return `${sanitizeAlias(hostAlias)}-${digest}`;
}

/**
 * 把主机别名净化成可安全用作路径片段的形式。
 *
 * 别名可能含点、冒号等字符（如 `gitee.com`、IPv6 写法），
 * 直接拼进路径会产生歧义或跨平台问题。
 *
 * @param alias - 原始别名
 * @returns 只含小写字母、数字与连字符的片段；过长时截断
 */
function sanitizeAlias(alias: string): string {
  const cleaned = alias
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '');
  // 全是特殊字符时给一个固定占位，保证 id 结构稳定
  return cleaned.length === 0 ? 'host' : cleaned.slice(0, 32);
}

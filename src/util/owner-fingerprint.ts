/**
 * @file 本机会话发起者指纹
 * @description 多用户经本工具连同一远端账号时，会话目录是共享根下的并列
 *              目录（VS Code 多用户模型：同 OS 账号 = 共享 server 状态）。
 *              指纹用于把**破坏性操作**（kill --all / clean）scope 到「我自己
 *              发起的会话」，避免误杀/误删他人的活会话——不参与会话 id 计算
 *              （同 (host,目录) 的共享语义保持不动）。
 *
 * 内容 = `hostname:os用户名`；env `DSH_OWNER_TAG` 可整体覆盖（单机型验证
 * 跨用户场景的测试钩子，文档注明）。非秘密信息，落远端 644 即可。
 */

import { hostname, userInfo } from 'node:os';

/**
 * 计算本机指纹。
 *
 * @returns 指纹串；userInfo 不可用时用户段退化为 unknown
 */
export function ownerFingerprint(): string {
  const override = (process.env.DSH_OWNER_TAG ?? '').trim();
  if (override !== '') return override;
  let user = 'unknown';
  try {
    user = userInfo().username;
  } catch { /* 个别平台 userInfo 抛错（如无 passwd 条目），用户段退化 */ }
  return `${hostname()}:${user}`;
}

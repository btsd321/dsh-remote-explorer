/**
 * @file agent 能力目录写临界区锁
 * @description `DSH_AGENTS_HOME` 已指向远端账号真实的 `~/.agents`（用户自己的
 *              数据），本工具唯一会往里写的动作是**旧版技能根的一次性迁移**
 *              （把 `<base>/.agents/skills` 与 `AGENTS.md` 并进去）。同一账号
 *              下多个会话可能同时连接并同时触发迁移，`mv` 竞态会让同一技能
 *              被两个会话搬、或迁移与用户自己的技能安装器交错——用 flock 把
 *              本工具的写入串起来。
 *
 * 复用 install-lock.ts 确立的形态：远端内核 flock（已实测可用）+ 超时给明确
 * 报错而非静默排队。锁文件放 `base/tmp/agents.lock`——共享根是用户自己的
 * `~/.agents`，不该往里塞本工具的内部锁文件；本工具的所有锁文件都在自己的
 * base 下。
 *
 * **能力边界（重要）：只锁本工具发起的写入。** 第三方技能安装器不会读我们的
 * 锁，它自己发起的并发安装仍有覆盖风险。本模块不做也不该做信号量式的全局
 * 串行化——那需要拦截任意进程的文件写入。该限制在 usage 文档中说明。
 */

import { quote } from '../util/shell-quote.js';
import type { RemotePaths } from './remote-paths.js';

/**
 * 等锁超时（秒）。
 *
 * 与引导安装锁（900s）分开取值：本锁保护的是秒级的目录操作（旧版技能迁移），
 * 不是分钟级的下载安装。等 90s 还没拿到，说明持锁方大概率已经卡死，
 * 与其让用户对着无输出的进度等 15 分钟，不如早点报出来。
 */
export const AGENTS_LOCK_WAIT_SECONDS = 90;

/**
 * 把一条写 agent 能力目录的命令（旧版技能迁移）包进远端 flock 临界区。
 *
 * @param paths - 远端路径集合（取锁文件位置）
 * @param command - 原始 shell 命令（整体作为 flock -c 的单一参数）
 * @returns 加锁后的命令字符串
 */
export function lockAgentsCommand(paths: RemotePaths, command: string): string {
  return `flock -w ${AGENTS_LOCK_WAIT_SECONDS} ${quote(paths.agentsLockFile)} -c ${quote(command)}`;
}

/**
 * 等锁超时的报错归一。
 *
 * flock 拿不到锁退出非零时，把「另一会话正在迁移旧版技能目录」这层语义补进
 * 错误消息，避免用户对着半截 shell 报错猜。与 install-lock 的同类函数保持
 * 一致的判据与措辞风格。
 *
 * @param stderr - 远端命令 stderr
 * @returns 补充说明；不像锁超时时 undefined
 */
export function agentsLockHint(stderr: string): string | undefined {
  return /flock/i.test(stderr)
    ? '（flock 等锁超时：同一远端账号下另一会话正在迁移旧版技能目录，稍后重试）'
    : undefined;
}

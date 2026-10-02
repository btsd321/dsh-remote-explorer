/**
 * @file 机器级 agent 能力目录写临界区锁
 * @description `.agents/` 从会话目录迁到 base 下之后新增的风险：技能安装器
 *              （含本工具自己发起的迁移、以及用户经会话操作的安装）会写**同
 *              一个**目录级状态。其中 `.skill-lock.json` 是单文件整写——两个
 *              会话并发装技能时后者覆盖前者的记录，表现为"装过的技能在锁文件
 *              里消失"，进而被下一次对账当成未安装项重装或误删。
 *
 * 复用 install-lock.ts 确立的形态：远端内核 flock（已实测可用）+ 超时给明确
 * 报错而非静默排队。锁文件在 `.agents/.lock`——放在它所保护的那棵树里，
 * 与技能同生共死（clean 清除 `.agents` 时锁一并消失，不留孤儿）。
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
 * 与引导安装锁（900s）分开取值：本锁保护的是秒级的目录操作（迁移、对账），
 * 不是分钟级的下载安装。等 90s 还没拿到，说明持锁方大概率已经卡死，
 * 与其让用户对着无输出的进度等 15 分钟，不如早点报出来。
 */
export const AGENTS_LOCK_WAIT_SECONDS = 90;

/**
 * 把一条写 `.agents/` 的命令包进远端 flock 临界区。
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
 * flock 拿不到锁退出非零时，把「另一会话正在写技能目录」这层语义补进错误
 * 消息，避免用户对着半截 shell 报错猜。与 install-lock 的同类函数保持一致的
 * 判据与措辞风格。
 *
 * @param stderr - 远端命令 stderr
 * @returns 补充说明；不像锁超时时 undefined
 */
export function agentsLockHint(stderr: string): string | undefined {
  return /flock/i.test(stderr)
    ? '（flock 等锁超时：同一远端账号下另一会话正在写技能目录，稍后重试）'
    : undefined;
}

/**
 * @file status 命令
 * @description 列出本机正在维持的所有远端会话，跨主机汇总。
 *
 * 纯本地操作——只读会话表，不连任何主机。这样即便某台主机已不可达，
 * `status` 仍能如实显示"本机认为存在哪些会话"，便于诊断。
 *
 * 读表时会顺带清理陈旧条目（维持会话的本机 CLI 已不在的记录）。
 */

import { listSessions, pruneSessions } from '../../session/session-registry.js';
import { cyan, dim, println, printTable, yellow } from '../output.js';

/**
 * 执行 status 命令。
 *
 * @returns 进程退出码
 */
export function runStatus(): number {
  const pruned = pruneSessions();
  const sessions = listSessions();

  if (sessions.length === 0) {
    println(yellow('当前没有活跃会话'));
    if (pruned > 0) println(dim(`已清理 ${pruned} 条陈旧记录`));
    println(dim('用 dsh-remote connect <别名> 开始一个会话'));
    return 0;
  }

  printTable(
    ['主机', '远端目录', '访问地址', '远端端口', '远端 pid', '启动时间'],
    sessions.map(record => [
      record.hostAlias,
      record.remoteCwd || dim('(默认)'),
      cyan(`http://127.0.0.1:${record.localPort}/`),
      String(record.remotePort),
      String(record.remotePid),
      formatTime(record.startedAt),
    ]),
  );

  println();
  println(dim(`共 ${sessions.length} 个会话${pruned > 0 ? `，已清理 ${pruned} 条陈旧记录` : ''}`));
  println(dim('访问地址需要令牌，请用 connect 时输出的完整地址（含 ?token=）'));
  return 0;
}

/**
 * 把 ISO 时间格式化为本地可读形式。
 *
 * @param iso - ISO 8601 时间串
 * @returns 形如 `09-20 10:27` 的文本；解析失败时返回原串
 */
function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * @file list 命令
 * @description 列出 ~/.ssh/config 中的所有主机别名。不连接任何主机，纯本地操作。
 *
 * 主机配置的唯一来源是 ssh config——本工具不维护自己的主机档案，
 * 用户通过编辑 ssh config 管理主机。
 */

import { listHosts } from '../../hosts/ssh-config-parser.js';
import { dim, println, printTable, yellow } from '../output.js';

/**
 * 执行 list 命令。
 *
 * @returns 进程退出码
 */
export function runList(): number {
  const hosts = listHosts();
  if (hosts.length === 0) {
    println(yellow('~/.ssh/config 中没有可用的 Host 条目'));
    println(dim('提示：本工具的主机列表直接来自 ssh config，请先在其中配置 Host'));
    return 0;
  }

  printTable(
    ['别名', '地址', '用户', '端口', '跳板机'],
    hosts.map(host => [
      host.alias,
      host.hostName,
      host.user || dim('(未配置)'),
      String(host.port),
      host.proxyJump ?? dim('直连'),
    ]),
  );
  println();
  println(dim(`共 ${hosts.length} 台主机。用 dsh-remote doctor <别名> 检查某台主机的引导条件`));
  return 0;
}

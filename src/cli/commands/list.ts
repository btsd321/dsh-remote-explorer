/**
 * @file list 命令
 * @description 列出 ~/.ssh/config 中的主机别名或本机 WSL 发行版。不连接任何主机，纯本地操作。
 *
 * 主机配置的唯一来源是 ssh config——本工具不维护自己的主机档案，
 * 用户通过编辑 ssh config 管理主机。WSL 发行版通过 wsl.exe 枚举。
 */

import { listHosts } from '../../hosts/ssh-config-parser.js';
import { listWslDistros } from '../../hosts/wsl-distro-parser.js';
import { dim, green, println, printTable, yellow } from '../output.js';

/** list 命令选项 */
export interface ListCommandOptions {
  /** 列出 WSL 发行版而非 SSH 主机 */
  listWsl: boolean;
}

/**
 * 执行 list 命令。
 *
 * @param options - 命令选项
 * @returns 进程退出码（异步，因为 WSL 枚举需要执行外部命令）
 */
export async function runList(options: ListCommandOptions): Promise<number> {
  if (options.listWsl) {
    return runListWsl();
  }
  return runListSsh();
}

/**
 * 列出 SSH 主机。
 *
 * @returns 进程退出码
 */
function runListSsh(): number {
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
  println(dim(`共 ${hosts.length} 台主机。用 dsh-remote-explorer doctor <别名> 检查某台主机的引导条件`));
  return 0;
}

/**
 * 列出 WSL 发行版。
 *
 * @returns 进程退出码
 */
async function runListWsl(): Promise<number> {
  const distros = await listWslDistros();
  if (distros.length === 0) {
    println(yellow('未检测到可用的 WSL 发行版'));
    println(dim('提示：请确认 WSL 已安装且至少有一个发行版（wsl --list --verbose）'));
    return 0;
  }

  printTable(
    ['名称', '状态', '版本', '默认'],
    distros.map(distro => [
      distro.name,
      distro.state === 'Running' ? green(distro.state) : distro.state,
      String(distro.version),
      distro.isDefault ? green('✓') : '',
    ]),
  );
  println();
  println(dim(`共 ${distros.length} 个发行版。用 dsh-remote-explorer connect --wsl <名称> 连接`));
  return 0;
}

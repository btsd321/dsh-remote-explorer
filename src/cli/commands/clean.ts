/**
 * @file clean 命令
 * @description 清理远端的陈旧资源：无运行进程的会话目录、旧版本 Node 与 dsh。
 *
 * 这是「版本入名 + 每会话目录」策略的必要配套——两者都会累积：
 * 每次客户端升级换版本，远端就多一份几百 MB 的安装；每次换工作目录，
 * 就多一个会话目录。
 *
 * 保护机制：**活会话的 runner 脚本（`.runtime/start.sh`）记录着它正在用的
 * dsh 与 Node 路径**。清理前先收集所有活会话（pid 文件指向的进程仍在）引用的
 * 路径，被引用的版本即使旧于保留线也不删——删掉正在运行的安装，
 * 进程下次重启就找不到了。
 *
 * 默认各保留最新 1 个版本；`--keep <N>` 调整。
 */

import { SshTransport } from '../../transport/ssh-transport.js';
import { probeRemote } from '../../provision/probe.js';
import { createRemotePaths, BASE_DIR_NAME } from '../../provision/remote-paths.js';
import { ownerFingerprint } from '../../util/owner-fingerprint.js';
import { quote } from '../../util/shell-quote.js';
import { prepareHostAuth } from '../host-auth.js';
import { bold, cyan, dim, green, println, ProgressReporter, yellow } from '../output.js';

/** 默认每个类别保留的版本数 */
const DEFAULT_KEEP = 1;

/** clean 命令选项 */
export interface CleanCommandOptions {
  /** 主机别名或 user@host[:port] 直连语法 */
  alias: string;
  /** 每个类别保留的最新版本数 */
  keep: number;
  /**
   * 连他人指纹的陈旧会话目录一起删（默认只删自己的 + 无 owner 的老目录）。
   * 多用户同远端账号时防误删他人数据，见 owner-fingerprint.ts
   */
  includeOthers?: boolean;
  /** 私钥文件路径覆盖（--private-key） */
  privateKey?: string;
  /** 固定密码（--password）：显式走密码认证 */
  password?: string;
}

/** 清理结果 */
interface CleanReport {
  /** 删除的会话目录 */
  sessions: string[];
  /** 删除的 dsh 版本 */
  dshVersions: string[];
  /** 删除的 Node 版本 */
  nodeVersions: string[];
  /** 释放的字节数 */
  freedBytes: number;
  /** 被保护跳过的版本 */
  protectedVersions: string[];
  /** 他人指纹的陈旧会话目录（默认跳过） */
  skippedOthers: string[];
}

/**
 * 执行 clean 命令。
 *
 * @param options - 命令选项
 * @returns 进程退出码
 */
export async function runClean(options: CleanCommandOptions): Promise<number> {
  const { resolved, passwords } = prepareHostAuth(options.alias, options);

  println(bold(`清理主机 ${cyan(options.alias)} 的远端资源`));
  println(dim(`保留最新 ${options.keep} 个版本；运行中会话使用的版本受保护`));
  println();

  const progress = new ProgressReporter();
  const transport = new SshTransport(options.alias, resolved, {
    getPassword: (hostKey, label, attempt) => passwords.get(hostKey, label, attempt),
  });

  try {
    progress.start('建立 SSH 连接');
    await transport.connect();
    progress.done();

    progress.start('探测远端环境');
    const probe = await probeRemote(transport);
    const paths = createRemotePaths(probe.homeDir);
    progress.done();

    progress.start('收集保护清单与陈旧资源');
    const report = await collectAndClean(transport, paths.base, options.keep, options.includeOthers === true);
    progress.done();

    println();
    if (report.freedBytes > 0) {
      println(green(`已释放 ${formatBytes(report.freedBytes)}`));
    } else {
      println(green('没有可清理的内容'));
    }
    if (report.sessions.length > 0) {
      println(dim(`陈旧会话目录：${report.sessions.join('、')}`));
    }
    if (report.dshVersions.length > 0) {
      println(dim(`旧版 dsh：${report.dshVersions.join('、')}`));
    }
    if (report.nodeVersions.length > 0) {
      println(dim(`旧版 Node：${report.nodeVersions.join('、')}`));
    }
    if (report.protectedVersions.length > 0) {
      println(yellow(`受运行中会话保护未删：${report.protectedVersions.join('、')}`));
    }
    if (report.skippedOthers.length > 0) {
      println(yellow(`跳过 ${report.skippedOthers.length} 个他人会话目录（--include-others 可一并删除）：`
        + `${report.skippedOthers.join('、')}`));
    }
    return 0;
  } finally {
    await transport.dispose();
    // 短命进程，清空是仪式性 hygiene，但与 session 路径保持一致
    passwords.clear();
  }
}

/**
 * 收集并执行清理。
 *
 * @param transport - 已连接的传输
 * @param baseDir - 远端根目录绝对路径
 * @param keep - 每个类别保留的版本数
 * @returns 清理报告
 */
async function collectAndClean(
  transport: SshTransport,
  baseDir: string,
  keep: number,
  includeOthers: boolean,
): Promise<CleanReport> {
  const base = quote(baseDir);
  // 会话目录里 pid 文件指向的进程仍在 → 是活会话；其 start.sh 记录着在用的
  // dsh 与 Node 路径，被引用的版本受保护。死会话输出「目录名\t owner 指纹」
  // （owner 供跨用户 scope 判定；功能上线前的老目录 owner 为空）
  const collect = [
    'for s in $(find "$HOME"' + `/${quote(BASE_DIR_NAME)}` + '/sessions -mindepth 1 -maxdepth 1 -type d 2>/dev/null); do',
    '  p=$(cat "$s/.runtime/pid" 2>/dev/null)',
    '  if [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then',
    '    cat "$s/.runtime/start.sh" 2>/dev/null',
    '  else',
    '    printf \'%s\\t%s\\n\' "$(basename "$s")" "$(head -1 "$s/.runtime/owner" 2>/dev/null)"',
    '  fi',
    'done',
  ].join('\n');

  const collected = await transport.exec(collect, { allowNonZeroExit: true });
  const mine = ownerFingerprint();
  const protectedVersions: string[] = [];
  const staleSessions: string[] = [];
  const skippedOthers: string[] = [];
  for (const line of collected.stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // runner 脚本的一行 exec 里 dsh 与 Node 路径**同时出现**，
    // 两个都要认——用 else if 会让第二个永远收不到（实测踩过）
    const dshMatch = /dsh-([0-9][^/]*)\//.exec(trimmed);
    const nodeMatch = /node\/(v[0-9][^/]*)\//.exec(trimmed);
    if (dshMatch) protectedVersions.push(`dsh-${dshMatch[1]}`);
    if (nodeMatch) protectedVersions.push(nodeMatch[1]!);
    // 死会话行：目录名(\t owner)?——不含路径分隔符
    if (!dshMatch && !nodeMatch && !trimmed.includes('/') && !trimmed.startsWith('#')) {
      const [name = '', owner = ''] = trimmed.split('\t');
      if (owner !== '' && owner !== mine && !includeOthers) {
        skippedOthers.push(name);
        continue;
      }
      staleSessions.push(name);
    }
  }

  // 删陈旧会话目录
  const report: CleanReport = {
    sessions: staleSessions,
    dshVersions: [],
    nodeVersions: [],
    freedBytes: 0,
    protectedVersions: [...new Set(protectedVersions)],
    skippedOthers,
  };
  if (staleSessions.length > 0) {
    const targets = staleSessions.map(name => `${base}/sessions/${quote(name)}`).join(' ');
    // du 先统计再删
    const size = await transport.exec(`du -sk ${targets} 2>/dev/null | awk '{s+=$1} END {print s+0}'`, {
      allowNonZeroExit: true,
    });
    report.freedBytes += (Number.parseInt(size.stdout.trim(), 10) || 0) * 1024;
    await transport.exec(`rm -rf ${targets}`, { allowNonZeroExit: true });
  }

  // 清旧版本：两类目录同规则——版本名按 sort -V 排序，保留最新 keep 个，
  // 其余删除（被活会话引用的除外）
  report.dshVersions = await pruneVersions(transport, `${base}/versions`, 'dsh-', keep, report.protectedVersions, (freed) => { report.freedBytes += freed; });
  report.nodeVersions = await pruneVersions(transport, `${base}/node`, '', keep, report.protectedVersions, (freed) => { report.freedBytes += freed; });

  return report;
}

/**
 * 清理单个类别目录下的旧版本。
 *
 * @param transport - 已连接的传输
 * @param dir - 类别目录（versions 或 node）
 * @param prefix - 版本目录名前缀（dsh- 或空）
 * @param keep - 保留的版本数
 * @param protectedNames - 受保护的版本目录名
 * @param onFreed - 释放字节数回调
 * @returns 被删除的版本列表
 */
async function pruneVersions(
  transport: SshTransport,
  dir: string,
  prefix: string,
  keep: number,
  protectedNames: string[],
  onFreed: (bytes: number) => void,
): Promise<string[]> {
  // 列出候选（版本名打头是数字或 v，排除非版本目录），按版本序排序
  const list = [
    `ls -1 ${dir} 2>/dev/null | grep '^${prefix}[v0-9]' | sort -rV || true`,
  ].join('\n');
  const listing = await transport.exec(list, { allowNonZeroExit: true });
  const names = listing.stdout.split('\n').map(line => line.trim()).filter(Boolean);

  const removable = names
    .slice(keep)
    .filter(name => !protectedNames.includes(name));
  if (removable.length === 0) return [];

  const targets = removable.map(name => `${dir}/${quote(name)}`).join(' ');
  const size = await transport.exec(`du -sk ${targets} 2>/dev/null | awk '{s+=$1} END {print s+0}'`, {
    allowNonZeroExit: true,
  });
  onFreed((Number.parseInt(size.stdout.trim(), 10) || 0) * 1024);
  await transport.exec(`rm -rf ${targets}`, { allowNonZeroExit: true });

  // 返回去掉前缀后的版本号，便于展示
  return removable.map(name => name.slice(prefix.length));
}

/**
 * 格式化字节数。
 *
 * @param bytes - 字节数
 * @returns 人类可读文本
 */
function formatBytes(bytes: number): string {
  const gb = bytes / 1_000_000_000;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.round(bytes / 1_000_000)} MB`;
}

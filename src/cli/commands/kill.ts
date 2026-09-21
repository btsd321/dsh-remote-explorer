/**
 * @file kill 命令
 * @description 停止远端 dsh 进程（对标 VS Code 的 "Kill VS Code Server on Host"）。
 *
 * 为什么这是一等命令而非内部细节：远端 dsh 是 detach 的，CLI 退出后仍在跑。
 * 当它状态异常（配置改了没生效、端口被占、进程卡死）时，用户需要一个明确的
 * "关掉重来" 手段。VS Code 的故障排查文档把 kill server 列为一大类连接错误的
 * 通用解法，这类工具都需要这个出口。
 *
 * 停进程只用 pid 文件或监听端口定位，**绝不用 `pkill -f`**——
 * 承载该命令的 shell 其命令行也含模式串，会把自己的 SSH 会话一起杀掉。
 */

import { SshTransport } from '../../transport/ssh-transport.js';
import { probeRemote } from '../../provision/probe.js';
import { createRemotePaths } from '../../provision/remote-paths.js';
import { stopRemoteDsh } from '../../session/remote-process.js';
import { listSessions, removeSession } from '../../session/session-registry.js';
import { computeSessionId } from '../../util/session-id.js';
import { quote } from '../../util/shell-quote.js';
import { prepareHostAuth } from '../host-auth.js';
import { bold, cyan, dim, green, println, yellow, ProgressReporter } from '../output.js';

/** kill 命令选项 */
export interface KillCommandOptions {
  /** 主机别名或 user@host[:port] 直连语法 */
  alias: string;
  /** 远端工作目录；与 --all 互斥 */
  cwd: string;
  /** 停止该主机上的全部会话 */
  all: boolean;
  /** 私钥文件路径覆盖（--private-key） */
  privateKey?: string;
  /** 固定密码（--password）：显式走密码认证 */
  password?: string;
}

/**
 * 执行 kill 命令。
 *
 * @param options - 命令选项
 * @returns 进程退出码
 */
export async function runKill(options: KillCommandOptions): Promise<number> {
  const { resolved, passwords } = prepareHostAuth(options.alias, options);

  println(bold(`停止主机 ${cyan(options.alias)} 上的远端 dsh`));
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

    // 确定要停哪些会话：--all 时扫远端会话目录，否则只停指定的那一个。
    // 扫远端而非只看本机会话表——远端 dsh 可能由已退出的 CLI 启动，
    // 那种"孤儿"恰恰是最需要 kill 的情形
    const sessionIds = options.all
      ? await listRemoteSessionIds(transport, paths.base)
      : [computeSessionId(options.alias, options.cwd)];

    if (sessionIds.length === 0) {
      println(yellow('远端没有会话目录，无需停止'));
      return 0;
    }

    let stopped = 0;
    for (const sessionId of sessionIds) {
      progress.start(`停止会话 ${sessionId}`);
      // 本机会话表里若有记录，用它的端口作为 pid 失效时的兜底定位手段
      const known = listSessions().find(record => record.sessionId === sessionId);
      const didStop = await stopRemoteDsh(transport, paths, {
        sessionId,
        ...(known ? { port: known.remotePort } : {}),
      });
      if (didStop) {
        stopped += 1;
        progress.done('已停止');
      } else {
        progress.skip('未在运行');
      }
      // 无论是否真的停掉都注销本机记录——它已不代表一个活跃会话
      removeSession(sessionId);
    }

    println();
    if (stopped > 0) {
      println(green(`已停止 ${stopped} 个远端 dsh 进程`));
    } else {
      println(yellow('没有正在运行的远端 dsh'));
    }
    println(dim('安装目录与会话 profile 均保留；用 dsh-remote-explorer connect 可再次启动'));
    return 0;
  } finally {
    await transport.dispose();
    // 短命进程，清空是仪式性 hygiene，但与 session 路径保持一致
    passwords.clear();
  }
}

/**
 * 列出远端已存在的会话 id。
 *
 * @param transport - 已连接的传输
 * @param baseDir - 远端根目录绝对路径
 * @returns 会话 id 列表
 */
async function listRemoteSessionIds(
  transport: SshTransport,
  baseDir: string,
): Promise<string[]> {
  const result = await transport.exec(
    `for d in ${quote(baseDir)}/sessions/*/; do [ -d "$d" ] && basename "$d"; done`,
    { allowNonZeroExit: true },
  );
  return result.stdout.split('\n').map(line => line.trim()).filter(Boolean);
}

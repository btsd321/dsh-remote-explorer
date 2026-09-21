/**
 * @file provision 命令
 * @description 只做引导：把远端环境装到「dsh --version 输出正确版本」为止，不起服务、不建隧道。
 *
 * 为什么单独成命令而不只作为 connect 的内部步骤：引导是最慢也最容易失败的一步
 * （装 Node 与 dsh，首次约 75 秒），把它独立出来便于单独重试与诊断。
 * 对标 VS Code 把「装 server」与「连接」在故障排查上分开对待的做法。
 *
 * 幂等：重复执行会命中已装版本并跳过，不重装。
 */

import { SshTransport } from '../../transport/ssh-transport.js';
import { provision, DEFAULT_DSH_VERSION } from '../../provision/provisioner.js';
import { DEFAULT_NODE_VERSION } from '../../provision/node-installer.js';
import { computeSessionId } from '../../util/session-id.js';
import { prepareHostAuth } from '../host-auth.js';
import { bold, cyan, dim, green, println, printTable, ProgressReporter } from '../output.js';

/** provision 命令选项 */
export interface ProvisionCommandOptions {
  /** 主机别名或 user@host[:port] 直连语法 */
  alias: string;
  /** 远端工作目录；参与会话 id 计算 */
  cwd: string;
  /** 目标 Node 版本 */
  nodeVersion?: string;
  /** 目标 dsh 版本或 dist-tag */
  dshVersion?: string;
  /** 强制重测镜像 */
  refreshMirrors: boolean;
  /** 私钥文件路径覆盖（--private-key） */
  privateKey?: string;
  /** 固定密码（--password）：显式走密码认证 */
  password?: string;
}

/**
 * 执行 provision 命令。
 *
 * @param options - 命令选项
 * @returns 进程退出码
 */
export async function runProvision(options: ProvisionCommandOptions): Promise<number> {
  const { resolved, passwords } = prepareHostAuth(options.alias, options);

  const sessionId = computeSessionId(options.alias, options.cwd);
  println(bold(`引导主机 ${cyan(options.alias)}`));
  println(dim(`会话 id：${sessionId}`));
  println();

  const progress = new ProgressReporter();
  const transport = new SshTransport(options.alias, resolved, {
    getPassword: (hostKey, label, attempt) => passwords.get(hostKey, label, attempt),
  });
  const startedAt = Date.now();

  try {
    progress.start('建立 SSH 连接');
    await transport.connect();
    progress.done(`${transport.platform.rawOs} ${transport.platform.rawArch}`);

    const result = await provision(transport, {
      sessionId,
      ...(options.nodeVersion ? { nodeVersion: options.nodeVersion } : {}),
      ...(options.dshVersion ? { dshVersion: options.dshVersion } : {}),
      refreshMirrors: options.refreshMirrors,
      onStageStart: (stage) => progress.start(stage),
      onStageDone: (detail) => progress.done(detail),
      onStageSkip: (reason) => progress.skip(reason),
    });

    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    println();
    printTable(
      ['项目', '值'],
      [
        ['远端根目录', result.paths.base],
        ['Node', `${result.node.version}${result.node.reused ? dim('（复用）') : ''}`],
        ['dsh', `${result.dsh.version}${result.dsh.reused ? dim('（复用）') : ''}`],
        ['dsh 入口', result.dsh.dshBin],
        ['会话 DSH_HOME', result.profile.dshHome],
        ['profile', `${result.profile.profileName}${result.profile.reused ? dim('（复用）') : ''}`],
      ],
    );
    println();
    println(green(`引导完成，用时 ${seconds}s`));
    println(dim('下一步：dsh-remote-explorer connect（P3 提供）'));
    return 0;
  } finally {
    await transport.dispose();
    // 短命进程，清空是仪式性 hygiene，但与 session 路径保持一致
    passwords.clear();
  }
}

/**
 * 供 help 文本引用的默认版本说明。
 *
 * @returns 默认 Node 与 dsh 版本
 */
export function defaultVersions(): { node: string; dsh: string } {
  return { node: DEFAULT_NODE_VERSION, dsh: DEFAULT_DSH_VERSION };
}

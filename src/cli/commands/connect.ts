/**
 * @file connect 命令
 * @description 主命令：引导 → 起远端 dsh → 建隧道 → 开浏览器 → 常驻守护。
 *
 * **本进程必须常驻。** 正向隧道的本机监听器活在本进程里，进程退出隧道即断。
 * P4 加入凭据代理后这一点会更关键——代理持有 LLM key，CLI 退出则远端
 * 模型调用全部失败。这是反向隧道代理方案的既定代价，不是缺陷。
 *
 * 远端 dsh 本身是 detach 的，CLI 退出后它仍在跑，下次 connect 会探到并复用。
 * 要真正停掉用 `dsh-remote-explorer kill`。
 */

import { spawn } from 'node:child_process';
import { openSession, type RemoteSession } from '../../session/session-manager.js';
import { describeState, type SessionState } from '../../session/lifecycle-state.js';
import { toErrorMessage } from '../../util/errors.js';
import {
  bold, cyan, dim, green, println, printTable, red, yellow, ProgressReporter,
} from '../output.js';

/** connect 命令选项 */
export interface ConnectCommandOptions {
  /** 主机别名或 user@host[:port] 直连语法 */
  alias: string;
  /** 远端工作目录 */
  cwd: string;
  /** 本机端口；0 表示 OS 分配 */
  localPort: number;
  /** 目标 Node 版本 */
  nodeVersion?: string;
  /** 目标 dsh 版本或 dist-tag */
  dshVersion?: string;
  /** 不自动打开浏览器 */
  noOpen: boolean;
  /** 强制重启远端 dsh */
  forceRestart: boolean;
  /** Ctrl-C 后保留远端 dsh（默认连它一起停止） */
  keepRemote: boolean;
  /** 强制重测镜像 */
  refreshMirrors: boolean;
  /** 私钥文件路径覆盖（--private-key）：优先于 config 的 IdentityFile */
  privateKey?: string;
  /** 固定密码（--password）：显式走密码认证；只存内存不落盘 */
  password?: string;
}

/**
 * 执行 connect 命令。
 *
 * @param options - 命令选项
 * @returns 进程退出码
 */
export async function runConnect(options: ConnectCommandOptions): Promise<number> {
  const progress = new ProgressReporter();

  println(bold(`连接主机 ${cyan(options.alias)}`));
  println();

  let session: RemoteSession | undefined;
  const onStateChange = (state: SessionState, description: string): void => {
    // 就绪态不必播报——它是常态，只报异常与恢复
    if (state.tag === 'connected') {
      if (state.reconnectAttempts > 0) println(green(`✓ 已重连：${description}`));
      return;
    }
    if (state.tag === 'heartbeat-missed') println(yellow(`! ${description}`));
    else if (state.tag === 'reconnecting') println(yellow(`↻ ${description}`));
    else if (state.tag === 'reconnect-failed') println(yellow(`! ${description}`));
    else if (state.tag === 'reconnect-exhausted') println(red(`✗ ${description}`));
  };

  try {
    session = await openSession({
      hostAlias: options.alias,
      remoteCwd: options.cwd,
      localPort: options.localPort,
      ...(options.nodeVersion ? { nodeVersion: options.nodeVersion } : {}),
      ...(options.dshVersion ? { dshVersion: options.dshVersion } : {}),
      ...(options.forceRestart ? { forceRestart: true } : {}),
      ...(options.refreshMirrors ? { refreshMirrors: true } : {}),
      ...(options.privateKey ? { privateKey: options.privateKey } : {}),
      ...(options.password !== undefined && options.privateKey === undefined
        ? { password: options.password }
        : {}),
      onStageStart: (stage) => progress.start(stage),
      onStageDone: (detail) => progress.done(detail),
      onStageSkip: (reason) => progress.skip(reason),
      onStateChange,
    });
  } catch (error) {
    progress.fail(toErrorMessage(error));
    throw error;
  }

  const result = session.provisionResult;
  println();
  printTable(
    ['项目', '值'],
    [
      ['访问地址', cyan(session.url)],
      ['本机端口', String(session.localPort)],
      ['远端端口', String(session.remotePort)],
      ['远端 pid', String(session.remotePid)],
      ['Node', result.node.version],
      ['dsh', result.dsh.version],
      ['会话 id', session.sessionId],
      ...(session.reversePort !== undefined
        ? [['密钥代理', session.missingKeyEnvs.length === 0
          ? `反向端口 ${session.reversePort} → 本机（${session.routeCount} 条路由，key 不出本机）`
          : `反向端口 ${session.reversePort} → 本机（${session.routeCount} 条路由${red(`，缺 key：${session.missingKeyEnvs.join('、')}`)}）`]]
        : []),
    ],
  );
  println();

  if (session.reversePort !== undefined && session.missingKeyEnvs.length > 0) {
    println(red(`! 本机未设置 ${session.missingKeyEnvs.join('、')}——对应供应商的模型调用会失败`));
    println(dim('  在启动 dsh-remote-explorer 的环境中导出该变量后重新 connect 即可'));
  }

  if (!options.noOpen) {
    openBrowser(session.url);
  }

  println(green('会话已就绪'));
  if (options.keepRemote) {
    println(dim('本进程需保持运行以维持隧道；按 Ctrl-C 断开（远端 dsh 保留复用）'));
  } else {
    println(dim('本进程需保持运行以维持隧道；按 Ctrl-C 断开并停止远端 dsh'));
    println(dim('要断开但保留远端 dsh：加 --keep-remote'));
  }
  println();

  // 常驻直到收到中断信号
  await waitForInterrupt(session, options.keepRemote, onStateChange);
  return 0;
}

/**
 * 等待中断信号或会话终结。
 *
 * @param session - 会话
 * @param keepRemote - Ctrl-C 后保留远端 dsh（--keep-remote；默认停止它）
 * @param onStateChange - 状态回调（用于终结态判定）
 */
async function waitForInterrupt(
  session: RemoteSession,
  keepRemote: boolean,
  onStateChange: (state: SessionState, description: string) => void,
): Promise<void> {
  /** 是否因用户中断而退出——决定远端 dsh 的去留 */
  let interruptedByUser = false;

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigint);
      clearInterval(watchdog);
      resolve();
    };

    const onSigint = (): void => {
      interruptedByUser = true;
      println();
      println(dim(keepRemote ? '正在断开…' : '正在断开并停止远端 dsh…'));
      finish();
    };
    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigint);

    // 会话进入终结态时自行退出，不必让用户手动 Ctrl-C。
    // 轮询而非事件：状态变化回调已被 session 占用，这里不改其契约
    const watchdog = setInterval(() => {
      const state = session.currentState;
      if (state.tag === 'reconnect-exhausted') {
        onStateChange(state, describeState(state));
        println(red('会话已终止。远端操作的结果无法确认——远端 dsh 可能仍在运行'));
        println(dim('用 dsh-remote-explorer connect 重新连接，或 dsh-remote-explorer kill 停止远端'));
        finish();
      }
    }, 1_000);
    watchdog.unref();
  });

  // Ctrl-C：默认连远端 dsh 一起停（用户要求的语义——断开即干净）。
  // 终结态退出则保留远端：那是故障出口不是用户意图，远端进程多半无恙，
  // 留着可复用。--keep-remote 恢复旧的 detach 语义
  const stopRemote = interruptedByUser && !keepRemote;
  await session.close({ stopRemote });
  if (stopRemote) {
    println(dim('已断开，远端 dsh 已停止'));
  } else if (interruptedByUser) {
    println(dim('已断开。远端 dsh 仍在运行，下次 connect 会自动复用'));
  } else {
    println(dim('已断开。远端 dsh 保留（可用 connect 复用或 kill 停止）'));
  }
}

/**
 * 在默认浏览器中打开地址。
 *
 * 失败不影响会话——地址已打印，用户可自行复制。
 *
 * @param url - 访问地址
 */
function openBrowser(url: string): void {
  // 按平台选择打开命令。Windows 用 cmd start，注意首个空参数是
  // start 的窗口标题占位符，省略会导致含空格的 URL 被当作标题
  const command = process.platform === 'win32'
    ? { file: 'cmd', args: ['/c', 'start', '', url] }
    : process.platform === 'darwin'
      ? { file: 'open', args: [url] }
      : { file: 'xdg-open', args: [url] };

  try {
    const child = spawn(command.file, command.args, {
      detached: true,
      stdio: 'ignore',
    });
    // 不让子进程把本进程的退出拖住
    child.unref();
    child.on('error', () => {
      println(dim('未能自动打开浏览器，请手动访问上面的地址'));
    });
  } catch {
    println(dim('未能自动打开浏览器，请手动访问上面的地址'));
  }
}

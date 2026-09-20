/**
 * @file CLI 入口与参数解析
 * @description `dsh-remote` 命令的入口：解析子命令与参数，分派到各命令实现，
 *              统一处理错误呈现与退出码。
 *
 * 为什么用 Node 内置的 `node:util` parseArgs 而非 commander：本仓库要保持
 * 依赖精简，而 CLI 的参数形态很简单（子命令 + 少量 flag）。内置方案够用，
 * 且少一个运行时依赖就少一处干净安装失败的风险。
 *
 * 分层约束：本文件属入口层，只做分派与错误呈现，不含业务逻辑。
 */

import { parseArgs } from 'node:util';
import { runList } from './commands/list.js';
import { runDoctor } from './commands/doctor.js';
import { RemoteError, toErrorMessage } from '../util/errors.js';
import { bold, cyan, dim, printErr, println, red, yellow } from './output.js';

/** 支持的子命令 */
const COMMANDS = ['list', 'doctor', 'help'] as const;

/** 子命令名 */
type CommandName = (typeof COMMANDS)[number];

/** 各错误码对应的退出码。用 Record 收口，新增错误码时编译器会提醒补齐 */
const EXIT_CODES: Record<RemoteError['code'], number> = {
  HOST_NOT_FOUND: 2,
  HOST_CONFIG_INVALID: 2,
  CONNECT_FAILED: 3,
  EXEC_FAILED: 4,
  PLATFORM_UNSUPPORTED: 5,
  NODE_UNSTABLE: 6,
  MIRROR_ALL_UNREACHABLE: 7,
  REMOTE_TOOL_MISSING: 8,
  ABORTED: 130,
};

/**
 * 打印总帮助。
 */
function printHelp(): void {
  println(bold('dsh-remote') + dim(' — 在远程主机上运行 dsh，本机只留浏览器'));
  println();
  println(bold('用法'));
  println('  dsh-remote <命令> [参数]');
  println();
  println(bold('命令'));
  println(`  ${cyan('list')}                      列出 ~/.ssh/config 中的主机`);
  println(`  ${cyan('doctor')} <别名>             诊断某台主机的引导条件`);
  println(`  ${cyan('help')}                      显示本帮助`);
  println();
  println(bold('doctor 参数'));
  println('  --refresh-mirrors         强制重测镜像延迟，忽略缓存');
  println();
  println(bold('说明'));
  println(dim('  主机列表直接来自 ssh config，本工具不维护自己的主机档案。'));
  println(dim('  认证只支持私钥（IdentityFile），不接受明文密码。'));
}

/**
 * 解析并执行命令行。
 *
 * @param argv - 参数列表（不含 node 与脚本路径）
 * @returns 进程退出码
 */
export async function main(argv: readonly string[]): Promise<number> {
  const [rawCommand, ...rest] = argv;

  if (rawCommand === undefined || rawCommand === '--help' || rawCommand === '-h') {
    printHelp();
    return 0;
  }
  if (rawCommand === '--version' || rawCommand === '-V') {
    // 版本号由 package.json 承载，这里避免读文件带来的路径耦合
    println('dsh-remote 0.4.0');
    return 0;
  }

  if (!COMMANDS.includes(rawCommand as CommandName)) {
    printErr(red(`未知命令：${rawCommand}`));
    printErr(dim(`可用命令：${COMMANDS.join('、')}。用 dsh-remote help 查看帮助`));
    return 64;
  }
  const command = rawCommand as CommandName;

  if (command === 'help') {
    printHelp();
    return 0;
  }
  if (command === 'list') {
    return runList();
  }

  // doctor：需要主机别名
  const { positionals, values } = parseArgs({
    args: [...rest],
    options: {
      'refresh-mirrors': { type: 'boolean', default: false },
    },
    allowPositionals: true,
    strict: true,
  });

  const alias = positionals[0];
  if (alias === undefined) {
    printErr(red('doctor 需要主机别名'));
    printErr(dim('用法：dsh-remote doctor <别名>。用 dsh-remote list 查看可用别名'));
    return 64;
  }

  return runDoctor({
    alias,
    refreshMirrors: values['refresh-mirrors'] === true,
  });
}

/**
 * 进程级入口：执行 main 并把错误翻译成退出码与可读消息。
 *
 * 错误呈现原则：RemoteError 已带定位信息，直接打印即可；
 * 其余异常打完整堆栈，因为那通常是本工具自身的缺陷而非用户环境问题。
 */
export async function run(): Promise<void> {
  // Ctrl-C 时让挂起的远端操作有机会走 finally 释放资源
  const controller = new AbortController();
  const onSigint = (): void => {
    printErr(yellow('\n已中断'));
    controller.abort();
    process.exitCode = EXIT_CODES.ABORTED;
  };
  process.once('SIGINT', onSigint);

  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    if (error instanceof RemoteError) {
      printErr(red(`✗ ${error.message}`));
      process.exitCode = EXIT_CODES[error.code];
    } else {
      printErr(red(`✗ ${toErrorMessage(error)}`));
      if (error instanceof Error && error.stack) printErr(dim(error.stack));
      process.exitCode = 1;
    }
  } finally {
    process.off('SIGINT', onSigint);
  }
}

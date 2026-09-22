/**
 * @file CLI 入口与参数解析
 * @description `dsh-remote-explorer` 命令的入口：解析子命令与参数，分派到各命令实现，
 *              统一处理错误呈现与退出码。
 *
 * 为什么用 Node 内置的 `node:util` parseArgs 而非 commander：本仓库要保持
 * 依赖精简，而 CLI 的参数形态很简单（子命令 + 少量 flag）。内置方案够用，
 * 且少一个运行时依赖就少一处干净安装失败的风险。
 *
 * 分层约束：本文件属入口层，只做分派与错误呈现，不含业务逻辑。
 */

import { parseArgs } from 'node:util';
import { setConfigPath } from '../hosts/ssh-config-parser.js';
import { runList } from './commands/list.js';
import { runDoctor } from './commands/doctor.js';
import { defaultVersions, runProvision } from './commands/provision.js';
import { runConnect } from './commands/connect.js';
import { runStatus } from './commands/status.js';
import { runKill } from './commands/kill.js';
import { runClean } from './commands/clean.js';
import { RemoteError, toErrorMessage } from '../util/errors.js';
import { normalizeRemoteCwd, validateRemoteCwd } from '../util/remote-cwd.js';
import { bold, cyan, dim, printErr, println, red, yellow } from './output.js';

/** 支持的子命令 */
const COMMANDS = ['list', 'doctor', 'provision', 'connect', 'status', 'kill', 'clean', 'help'] as const;

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
  println(bold('dsh-remote-explorer') + dim(' — 在远程主机上运行 dsh，本机只留浏览器'));
  println();
  println(bold('用法'));
  println('  dsh-remote-explorer <命令> [参数]');
  println();
  const versions = defaultVersions();

  println(bold('命令'));
  println(`  ${cyan('connect')} <别名>            主命令：引导 → 起远端 → 建隧道 → 开浏览器（常驻）`);
  println(`  ${cyan('status')}                    列出本机正在维持的所有会话`);
  println(`  ${cyan('kill')} <别名>               停止远端 dsh 进程`);
  println(`  ${cyan('clean')} <别名>              清理远端陈旧资源（旧版本、死会话目录）`);
  println(`  ${cyan('list')}                      列出 ~/.ssh/config 中的主机`);
  println(`  ${cyan('doctor')} <别名>             诊断某台主机的引导条件`);
  println(`  ${cyan('provision')} <别名>          只做引导，不起服务（幂等）`);
  println(`  ${cyan('help')}                      显示本帮助`);
  println();
  println(bold('connect 参数'));
  println('  --cwd <远端路径>          远端工作目录，参与会话标识计算');
  println('  --local-port <端口>       本机监听端口（默认由系统分配）');
  println('  --no-open                 不自动打开浏览器');
  println('  --force-restart           即便远端已有可用会话也重新启动');
  println('  --keep-remote             Ctrl-C 断开时保留远端 dsh（默认连它一起停止）');
  println(`  --node-version <版本>     Node 版本（默认 ${versions.node}）`);
  println(`  --dsh-version <版本>      dsh 版本或 dist-tag（默认 ${versions.dsh}）`);
  println('  --refresh-mirrors         强制重测镜像延迟，忽略缓存');
  println();
  println(bold('kill 参数'));
  println('  --cwd <远端路径>          指定要停止的会话');
  println('  --all                     停止该主机上的全部会话（含孤儿进程）');
  println('  --include-others          --all/clean 时连他人会话一起操作（默认只动自己的）');
  println();
  println(bold('clean 参数'));
  println('  --keep <数量>             每个类别保留的最新版本数（默认 1）');
  println();
  println(bold('doctor / provision 参数'));
  println('  --refresh-mirrors         强制重测镜像延迟，忽略缓存');
  println('  --cwd <远端路径>          （provision）远端工作目录');
  println(`  --node-version <版本>     （provision）Node 版本（默认 ${versions.node}）`);
  println(`  --dsh-version <版本>      （provision）dsh 版本或 dist-tag（默认 ${versions.dsh}）`);
  println();
  println(bold('通用参数'));
  println('  --ssh-config <路径>       改用指定的 ssh config 文件（默认 ~/.ssh/config）');
  println('  --private-key <路径>      私钥路径，优先于 config 中的 IdentityFile');
  println('  --password <密码>         明文密码认证（有泄露风险，慎用；见下方说明）');
  println();
  println(bold('说明'));
  println(dim('  主机列表直接来自 ssh config，本工具不维护自己的主机档案；'));
  println(dim('  不在 config 里的主机可用 user@host[:port] 直连（IPv6 需写进 config）。'));
  println(dim('  认证支持私钥（IdentityFile / --private-key）；未配置私钥且在交互式终端时'));
  println(dim('  会提示输入密码（不回显，只存内存不落盘）。--password 以明文暴露在命令行、'));
  println(dim('  进程列表与 shell 历史中，有泄露风险，建议仅作临时手段。'));
  println(dim(`  远端 Node 默认锁定 ${versions.node}：v22 在 aarch64 上起进程崩溃率高，会导致安装失败。`));
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
    println('dsh-remote-explorer 0.6.0');
    return 0;
  }

  if (!COMMANDS.includes(rawCommand as CommandName)) {
    printErr(red(`未知命令：${rawCommand}`));
    printErr(dim(`可用命令：${COMMANDS.join('、')}。用 dsh-remote-explorer help 查看帮助`));
    return 64;
  }
  const command = rawCommand as CommandName;

  if (command === 'help') {
    printHelp();
    return 0;
  }

  // 参数解析放在 list 分派之前：--ssh-config 对所有命令都有效，
  // 而它必须在任何主机解析发生前生效（解析结果带模块级缓存）
  const { positionals, values } = parseArgs({
    args: [...rest],
    options: {
      'ssh-config': { type: 'string' },
      'refresh-mirrors': { type: 'boolean', default: false },
      cwd: { type: 'string' },
      'node-version': { type: 'string' },
      'dsh-version': { type: 'string' },
      'local-port': { type: 'string' },
      'no-open': { type: 'boolean', default: false },
      'force-restart': { type: 'boolean', default: false },
      'keep-remote': { type: 'boolean', default: false },
      all: { type: 'boolean', default: false },
      'include-others': { type: 'boolean', default: false },
      keep: { type: 'string' },
      'private-key': { type: 'string' },
      password: { type: 'string' },
    },
    allowPositionals: true,
    strict: true,
  });

  if (values['ssh-config'] !== undefined) {
    setConfigPath(values['ssh-config']);
  }

  // 认证旗标：空值直接拒绝（空路径/空密码没有合法用例）
  const privateKey = values['private-key'];
  const password = values.password;
  if ((privateKey !== undefined && privateKey.length === 0)
    || (password !== undefined && password.length === 0)) {
    printErr(red('--private-key 与 --password 不接受空值'));
    return 64;
  }
  // 明文密码必须警告：命令行对进程列表可见、会进 shell 历史
  if (password !== undefined) {
    println(yellow('⚠ 警告：--password 会把密码以明文暴露在命令行、进程列表与 shell 历史中，有泄露风险'));
    println(dim('  建议改用私钥（IdentityFile / --private-key）或交互式输入'));
    if (privateKey !== undefined) {
      println(yellow('已忽略 --password（--private-key 优先）'));
    }
  }

  // 不需要主机别名的命令
  if (command === 'list') {
    return runList();
  }
  if (command === 'status') {
    return runStatus();
  }

  // 其余命令都需要主机别名（或 user@host[:port] 直连语法）
  const alias = positionals[0];
  if (alias === undefined) {
    printErr(red(`${command} 需要主机别名`));
    printErr(dim(`用法：dsh-remote-explorer ${command} <别名 | user@host[:port]>。用 dsh-remote-explorer list 查看可用别名`));
    return 64;
  }

  // --private-key 与 --password 同给时密钥优先（上面已提示忽略）
  const effectivePassword = privateKey === undefined ? password : undefined;

  const refreshMirrors = values['refresh-mirrors'] === true;

  // 未指定工作目录时用空串：它同样参与会话 id 计算，
  // 保证"不带 --cwd"这一情形有稳定且唯一的会话标识
  const rawCwd = values.cwd ?? '';
  const cwdError = validateRemoteCwd(rawCwd);
  if (cwdError !== undefined) {
    printErr(red(cwdError));
    return 64;
  }
  const cwd = normalizeRemoteCwd(rawCwd);

  if (command === 'doctor') {
    return runDoctor({
      alias,
      refreshMirrors,
      ...(privateKey ? { privateKey } : {}),
      ...(effectivePassword !== undefined ? { password: effectivePassword } : {}),
    });
  }

  if (command === 'kill') {
    return runKill({
      alias,
      cwd,
      all: values.all === true,
      ...(values['include-others'] === true ? { includeOthers: true } : {}),
      ...(privateKey ? { privateKey } : {}),
      ...(effectivePassword !== undefined ? { password: effectivePassword } : {}),
    });
  }

  if (command === 'clean') {
    // 未指定 --keep 时用默认值 1
    const keep = values.keep === undefined ? 1 : Number.parseInt(values.keep, 10);
    if (!Number.isInteger(keep) || keep < 0) {
      printErr(red(`--keep 需要 0 或正整数，实际为 ${values.keep}`));
      return 64;
    }
    return runClean({
      alias,
      keep,
      ...(values['include-others'] === true ? { includeOthers: true } : {}),
      ...(privateKey ? { privateKey } : {}),
      ...(effectivePassword !== undefined ? { password: effectivePassword } : {}),
    });
  }

  if (command === 'connect') {
    const localPort = parsePort(values['local-port']);
    if (localPort === undefined) {
      printErr(red(`--local-port 需要 0–65535 之间的整数，实际为 ${values['local-port']}`));
      return 64;
    }
    return runConnect({
      alias,
      cwd,
      localPort,
      ...(values['node-version'] ? { nodeVersion: values['node-version'] } : {}),
      ...(values['dsh-version'] ? { dshVersion: values['dsh-version'] } : {}),
      noOpen: values['no-open'] === true,
      forceRestart: values['force-restart'] === true,
      keepRemote: values['keep-remote'] === true,
      refreshMirrors,
      ...(privateKey ? { privateKey } : {}),
      ...(effectivePassword !== undefined ? { password: effectivePassword } : {}),
    });
  }

  return runProvision({
    alias,
    cwd,
    ...(values['node-version'] ? { nodeVersion: values['node-version'] } : {}),
    ...(values['dsh-version'] ? { dshVersion: values['dsh-version'] } : {}),
    refreshMirrors,
    ...(privateKey ? { privateKey } : {}),
    ...(effectivePassword !== undefined ? { password: effectivePassword } : {}),
  });
}

/**
 * 解析端口参数。
 *
 * @param raw - 原始字符串；undefined 表示未指定，按 0（由系统分配）处理
 * @returns 端口号；非法时 undefined
 */
function parsePort(raw: string | undefined): number | undefined {
  if (raw === undefined) return 0;
  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) return undefined;
  return port;
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

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
import { setConfigPath } from '../hosts/ssh-config-parser.js';
import { runList } from './commands/list.js';
import { runDoctor } from './commands/doctor.js';
import { defaultVersions, runProvision } from './commands/provision.js';
import { runConnect } from './commands/connect.js';
import { runStatus } from './commands/status.js';
import { runKill } from './commands/kill.js';
import { RemoteError, toErrorMessage } from '../util/errors.js';
import { bold, cyan, dim, printErr, println, red, yellow } from './output.js';

/** 支持的子命令 */
const COMMANDS = ['list', 'doctor', 'provision', 'connect', 'status', 'kill', 'help'] as const;

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
  const versions = defaultVersions();

  println(bold('命令'));
  println(`  ${cyan('connect')} <别名>            主命令：引导 → 起远端 → 建隧道 → 开浏览器（常驻）`);
  println(`  ${cyan('status')}                    列出本机正在维持的所有会话`);
  println(`  ${cyan('kill')} <别名>               停止远端 dsh 进程`);
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
  println(`  --node-version <版本>     Node 版本（默认 ${versions.node}）`);
  println(`  --dsh-version <版本>      dsh 版本或 dist-tag（默认 ${versions.dsh}）`);
  println('  --refresh-mirrors         强制重测镜像延迟，忽略缓存');
  println();
  println(bold('kill 参数'));
  println('  --cwd <远端路径>          指定要停止的会话');
  println('  --all                     停止该主机上的全部会话（含孤儿进程）');
  println();
  println(bold('doctor / provision 参数'));
  println('  --refresh-mirrors         强制重测镜像延迟，忽略缓存');
  println('  --cwd <远端路径>          （provision）远端工作目录');
  println(`  --node-version <版本>     （provision）Node 版本（默认 ${versions.node}）`);
  println(`  --dsh-version <版本>      （provision）dsh 版本或 dist-tag（默认 ${versions.dsh}）`);
  println();
  println(bold('通用参数'));
  println('  --ssh-config <路径>       改用指定的 ssh config 文件（默认 ~/.ssh/config）');
  println();
  println(bold('说明'));
  println(dim('  主机列表直接来自 ssh config，本工具不维护自己的主机档案。'));
  println(dim('  认证只支持私钥（IdentityFile），不接受明文密码。'));
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
      all: { type: 'boolean', default: false },
    },
    allowPositionals: true,
    strict: true,
  });

  if (values['ssh-config'] !== undefined) {
    setConfigPath(values['ssh-config']);
  }

  // 不需要主机别名的命令
  if (command === 'list') {
    return runList();
  }
  if (command === 'status') {
    return runStatus();
  }

  // 其余命令都需要主机别名
  const alias = positionals[0];
  if (alias === undefined) {
    printErr(red(`${command} 需要主机别名`));
    printErr(dim(`用法：dsh-remote ${command} <别名>。用 dsh-remote list 查看可用别名`));
    return 64;
  }

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
    return runDoctor({ alias, refreshMirrors });
  }

  if (command === 'kill') {
    return runKill({ alias, cwd, all: values.all === true });
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
      refreshMirrors,
    });
  }

  return runProvision({
    alias,
    cwd,
    ...(values['node-version'] ? { nodeVersion: values['node-version'] } : {}),
    ...(values['dsh-version'] ? { dshVersion: values['dsh-version'] } : {}),
    refreshMirrors,
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
 * 校验 `--cwd` 是合法的远端 POSIX 绝对路径。
 *
 * 必须校验而不能放过，是因为 **Git Bash（MSYS）会在参数到达本程序之前就改写它**：
 * 在 Git Bash 里写 `--cwd /home/user`，程序实际收到的是
 * `D:/SoftWare/Git/home/user`——MSYS 把看起来像 Unix 路径的参数当成
 * Windows 路径做了转换。这个改写发生在 shell 层，本程序无法阻止，只能识别并拒绝。
 *
 * 放过它的后果不只是路径错：远端工作目录参与会话 id 计算，
 * 同一个逻辑会话会因调用方式不同得到不同 id，于是复用与 kill 都会失灵。
 *
 * @param cwd - 原始参数值；空串表示未指定
 * @returns 错误消息；合法时 undefined
 */
function validateRemoteCwd(cwd: string): string | undefined {
  if (cwd.length === 0) return undefined;

  if (/^[A-Za-z]:/.test(cwd)) {
    return `--cwd 看起来被 shell 改写成了 Windows 路径：${cwd}\n`
      + '这是 Git Bash（MSYS）的路径转换所致，它在参数到达本程序前就已发生。\n'
      + '两种绕过方式：用双斜杠写 --cwd //home/xxx，'
      + '或设环境变量 MSYS_NO_PATHCONV=1 后再执行。';
  }
  if (cwd.includes('\\')) {
    return `--cwd 含反斜杠：${cwd}。远端一定是 POSIX，路径请用 / 分隔`;
  }
  if (!cwd.startsWith('/')) {
    return `--cwd 必须是绝对路径，实际为 ${cwd}`;
  }
  return undefined;
}

/**
 * 归一化远端工作目录。
 *
 * MSYS 对以 `//` 开头的参数不做转换，所以推荐写法 `--cwd //home/xxx`
 * 传进来就是 `//home/xxx`；远端 POSIX 语义下前导双斜杠是实现定义行为，
 * 这里折叠成单斜杠，保证会话 id 对两种写法一致。
 *
 * @param cwd - 已校验的路径
 * @returns 归一化后的路径
 */
function normalizeRemoteCwd(cwd: string): string {
  return cwd.startsWith('//') ? cwd.slice(1) : cwd;
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

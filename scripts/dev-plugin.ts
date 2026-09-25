/**
 * @file 插件开发沙箱脚本
 * @description 在隔离的 DSH_HOME（.dev-harness/home，绝不碰 ~/.dsh）里安装本仓库
 *              的插件形态并启动 dsh web，做启动冒烟与面板联调。移植自参考插件
 *              （flymysql/dsh-remote）dev-run.sh / boot-smoke.sh 的全部经验，
 *              重写为跨平台 tsx 脚本（Windows 开发机可跑）。
 *
 * 沙箱纪律（都是参考插件实测踩过的坑）：
 * - 安装用 `dsh plugin --profile <p> add <仓库绝对路径>`：pnpm 的 file: 安装是
 *   「打包拷贝」，尊重 files 字段——所以必须先构建出 lib/
 * - 禁用 link:/symlink：Node ESM 按 realpath 解析，peer 依赖会逃逸沙箱解析到
 *   仓库外，行为与真实安装不一致
 * - 冒烟判读：日志出现 token URL = 启动健康；`DSH entry failed` = 插件树加载
 *   失败；ping 路由 401 = 已注册且受鉴权保护，404 = 没挂上
 *
 * 前置条件：PATH 上有 pnpm（dsh plugin 命令是对 pnpm 的原样转发）。
 *
 * 用法：
 *   pnpm exec tsx scripts/dev-plugin.ts            # 构建 → 安装/同步 → 启动（前台，Ctrl-C 停）
 *   pnpm exec tsx scripts/dev-plugin.ts --smoke    # 构建 → 安装/同步 → 启动 → 探针 → 杀掉（CI 用）
 *   pnpm exec tsx scripts/dev-plugin.ts --sync     # 只把 lib/ 覆盖进沙箱 profile（不启动）
 *   --fresh 清空沙箱重装；--port 默认 50599；--profile 默认 web；
 *   --dsh-version 默认 0.1.7-rc.2；--dsh-bin <路径> 跳过 npx 用本地 dsh；
 *   --install-spec <pnpm spec> 换安装源（发布演练：npm pack 的 tgz 绝对路径）
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { bold, cyan, dim, green, println, printErr, red, yellow } from '../src/cli/output.js';
import { toErrorMessage } from '../src/util/errors.js';
import { buildPlugin } from './build-plugin.js';
import { runChecks } from './check-plugin.js';

/** 仓库根目录 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 沙箱 DSH_HOME（gitignored；--fresh 时整体重建） */
const SANDBOX_HOME = join(REPO_ROOT, '.dev-harness', 'home');

/** 默认沙箱端口（避开常用端口；与参考插件的沙箱端口策略一致） */
const DEFAULT_PORT = 50_599;

/** 默认 dsh 版本（与本仓库远端引导用的 rc 线一致） */
const DEFAULT_DSH_VERSION = '0.1.7-rc.2';

/** 安装步骤超时（首次 npx 要下载整个 dsh 发行包，留足余量） */
const INSTALL_TIMEOUT_MS = 600_000;

/** 启动步骤超时（看到 token URL 或失败特征即提前结束等待） */
const BOOT_TIMEOUT_MS = 300_000;

/** 探针重试次数与间隔（路由注册可能略晚于 webserver 监听） */
const PROBE_RETRIES = 10;
const PROBE_INTERVAL_MS = 1_000;

/** 面板路由前缀（与 src/plugin/routes.ts 的 ROUTE_PREFIX 一致） */
const ROUTE_PREFIX = '/api/dsh-remote-explorer';

/** dsh 启动健康的日志特征：带令牌的访问 URL */
const BOOT_URL_PATTERN = /https?:\/\/[^\s'"]+\?token=[A-Za-z0-9_-]+/;

/** 插件树加载失败的日志特征 */
const BOOT_FAILURE_PATTERN = /DSH entry failed|Cannot find module|ERR_MODULE_NOT_FOUND|EADDRINUSE/;

/** 沙箱脚本选项 */
interface DevOptions {
  /** 冒烟模式：探针跑完即杀掉子进程退出 */
  smoke: boolean;
  /** 只同步 lib/ 进沙箱，不安装不启动 */
  sync: boolean;
  /** 清空沙箱重装 */
  fresh: boolean;
  /** 沙箱 webserver 端口 */
  port: number;
  /** profile 名 */
  profile: string;
  /** dsh 版本（npx 安装源） */
  dshVersion: string;
  /** 本地 dsh 可执行路径（给了就不用 npx） */
  dshBin?: string;
  /** 安装源覆盖（pnpm spec）；缺省 file:<仓库根>，发布演练传 npm pack 的 tgz */
  installSpec?: string;
}

/**
 * 定位随 Node 发行的 npx-cli.js。
 *
 * 直接 spawn 'npx' 在 Windows 上不可行（CreateProcess 不认 .cmd），
 * 用当前 Node 跑 npx 的 JS 入口是免 shell、免引号地狱的跨平台做法。
 *
 * @returns npx-cli.js 绝对路径；找不到时 undefined（回落 shell npx）
 */
function resolveNpxCli(): string | undefined {
  const candidate = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js');
  return existsSync(candidate) ? candidate : undefined;
}

/**
 * 构造「运行 dsh CLI」的 spawn 参数。
 *
 * @param options - 沙箱选项
 * @param dshArgs - 传给 dsh 的参数
 * @returns spawn 的 command/args/shell 三元组
 */
function dshSpawnSpec(options: DevOptions, dshArgs: string[]): {
  command: string;
  args: string[];
  useShell: boolean;
} {
  if (options.dshBin !== undefined) {
    // 本地 dsh：Windows 上可能是 .cmd shim，只能走 shell
    return { command: options.dshBin, args: dshArgs, useShell: process.platform === 'win32' };
  }
  const npxCli = resolveNpxCli();
  const dshSpec = `@deepseek-ai/dsh@${options.dshVersion}`;
  if (npxCli !== undefined) {
    return { command: process.execPath, args: [npxCli, '-y', dshSpec, ...dshArgs], useShell: false };
  }
  // 兜底：PATH 里的 npx（POSIX 可直接 spawn；Windows 走 shell）
  return { command: 'npx', args: ['-y', dshSpec, ...dshArgs], useShell: process.platform === 'win32' };
}

/**
 * 杀掉子进程树（Windows 无进程组语义，用 taskkill /T）。
 *
 * @param child - 目标子进程
 */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try {
      // detached 启动的进程组整组回收
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      // 进程组已不存在时退回单进程 kill
      try { child.kill('SIGTERM'); } catch { /* 已退出，忽略 */ }
    }
  }
}

/**
 * 同步构建产物与清单进沙箱 profile 里已安装的包目录。
 *
 * pnpm 对 file: 依赖的落盘形态因平台而异（实测）：Windows 是**硬链接拷贝**
 * （沙箱文件与仓库文件同 inode——此时构建即生效，拷贝反而会被 cpSync 以
 * 「src 与 dest 是同一文件」拒绝）；其他平台/CI 可能是真拷贝，需要逐个
 * 同步。所以按「同 inode 跳过、异 inode 拷贝」处理，并清掉清单外的陈旧
 * 产物（如改扩展名前的 index.cjs——loader 加载旧入口会直接崩，实测踩过）。
 *
 * 除 lib/ 外必须同步 package.json 与 cordis.patch.yml：main/exports 指向
 * 哪个产物、bundle patch 插哪一行都由它们决定。真拷贝形态下宿主半改动
 * 同步后要重启 dsh 进程（dsh 契约：包替换需重启），浏览器半刷新页面即可。
 *
 * @param options - 沙箱选项
 * @param pkgName - 包名
 * @returns 是否同步成功（沙箱里还没装过包时为 false）
 */
function syncLibToSandbox(options: DevOptions, pkgName: string): boolean {
  const installedPkg = join(SANDBOX_HOME, 'profiles', options.profile, 'node_modules', pkgName);
  if (!existsSync(installedPkg)) return false;

  // 1. 产物与清单：同 inode（硬链接安装）跳过，否则拷贝
  const installedLib = join(installedPkg, 'lib');
  mkdirSync(installedLib, { recursive: true });
  const expected = ['index.js', 'client.js'];
  for (const file of expected) {
    copyIfNotSameFile(join(REPO_ROOT, 'lib', file), join(installedLib, file));
  }
  copyIfNotSameFile(join(REPO_ROOT, 'package.json'), join(installedPkg, 'package.json'));
  copyIfNotSameFile(join(REPO_ROOT, 'cordis.patch.yml'), join(installedPkg, 'cordis.patch.yml'));

  // 2. 清掉清单外的陈旧产物（只动 lib/ 里的文件，不碰目录本身）
  for (const entry of readdirSync(installedLib)) {
    if (!expected.includes(entry)) rmSync(join(installedLib, entry), { force: true });
  }
  return true;
}

/**
 * 拷贝文件；源与目标是同一物理文件（硬链接安装）时跳过。
 *
 * @param from - 仓库内源文件
 * @param to - 沙箱内目标文件
 */
function copyIfNotSameFile(from: string, to: string): void {
  if (!existsSync(from)) return;
  if (existsSync(to)) {
    const source = statSync(from);
    const target = statSync(to);
    // dev+ino 相同 = 同一物理文件（NTFS/APFS/ext4 都有 inode 语义）
    if (source.dev === target.dev && source.ino === target.ino) return;
  }
  cpSync(from, to);
}

/**
 * 批准 profile 里 pnpm 留下的待决策构建脚本（占位值 → false）。
 *
 * pnpm 11 对「带安装脚本的依赖未决策」报 ERR_PNPM_IGNORED_BUILDS（退出码 1），
 * 失败后 dsh 把待决策包写进 pnpm-workspace.yaml 的 allowBuilds，值是提示文字
 * 「set this to true or false」。逐行把占位值改成 false——不引入 YAML 依赖，
 * 只认这一种精确形态；改不到就返回空列表（外层不再重试）。
 *
 * 决策依据：本插件**产物**不依赖任何原生构建——宿主半 bundle 了 ssh2 且以
 * `.node: empty` loader 放弃原生件（纯 JS 回落是既定设计），esbuild 与
 * cpu-features 只在 CLI 形态的 tsx 直跑路径上有意义，profile 安装用不到。
 *
 * @param options - 沙箱选项
 * @returns 被批准（false）的包名列表
 */
function approvePendingBuilds(options: DevOptions): string[] {
  const policyPath = join(SANDBOX_HOME, 'profiles', options.profile, 'pnpm-workspace.yaml');
  let text: string;
  try {
    text = readFileSync(policyPath, 'utf8');
  } catch {
    return [];
  }
  const approved: string[] = [];
  const lines = text.split('\n').map((line) => {
    const match = /^(\s*)(.+?): set this to true or false\s*$/.exec(line);
    if (match === null) return line;
    approved.push(match[2]?.replaceAll('\'', '').replaceAll('"', '') ?? '');
    return `${match[1]}${match[2]}: false`;
  });
  if (approved.length === 0) return [];
  writeFileSync(policyPath, lines.join('\n'));
  return approved;
}

/**
 * 撤销 pnpm 失败路径留下的「半提交」安装（依赖已写入 manifest、未激活）。
 *
 * dsh CLI 的 add 失败路径不回滚 profile 的 package.json——pnpm 在退出 1 前
 * 已把依赖写进 manifest，而把包激活进 `dsh.profile.bundles` 的 reconcile
 * 只在成功路径运行。直接重试时 dsh 按「before 已有该依赖」判旧、跳过激活，
 * 插件永远进不了组合（实测：重试退出 0 但宿主半路由 404、浏览器半引导图
 * 缺行）。Web UI 的 installBundle 有 spec 名兜底，CLI 转发路径没有——这里
 * 撤掉依赖项，让重试成为一次「全新安装」走完整激活。
 *
 * @param options - 沙箱选项
 * @param pkgName - 本包名
 * @returns 是否撤销了依赖项（false = 本就没有或 manifest 不可读）
 */
function rollbackHalfCommittedInstall(options: DevOptions, pkgName: string): boolean {
  const manifestPath = join(SANDBOX_HOME, 'profiles', options.profile, 'package.json');
  let text: string;
  try {
    text = readFileSync(manifestPath, 'utf8');
  } catch {
    return false;
  }
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return false;
  }
  const deps = manifest['dependencies'];
  if (typeof deps !== 'object' || deps === null
    || !(pkgName in (deps as Record<string, unknown>))) {
    return false;
  }
  const next = { ...manifest, dependencies: { ...(deps as Record<string, unknown>) } };
  delete (next.dependencies as Record<string, unknown>)[pkgName];
  writeFileSync(manifestPath, `${JSON.stringify(next, undefined, 2)}\n`);
  return true;
}

/**
 * 安装插件进沙箱 profile（dsh plugin add 本地路径）。
 *
 * @param options - 沙箱选项
 * @param pkgName - 本包名（半提交回滚用）
 * @throws Error 安装失败（含 pnpm 缺失提示）
 */
async function installPlugin(options: DevOptions, pkgName: string): Promise<void> {
  // 显式 file: 前缀强制「打包拷贝」语义（尊重 files 字段，产物进 profile 的
  // node_modules）——裸目录路径会被 pnpm 解析成 link:（junction/symlink），
  // Node ESM 按 realpath 解析会让 peer 逃逸沙箱、与真实安装的解析路径不一致。
  // --install-spec 可换成 npm pack 的 tgz（发布演练，验证 files 清单完整性）
  const installSpec = options.installSpec ?? `file:${REPO_ROOT.replaceAll('\\', '/')}`;
  const spec = dshSpawnSpec(options, [
    'plugin', '--profile', options.profile, 'add', installSpec,
  ]);
  println(dim(`执行：${spec.command === process.execPath ? 'node npx-cli' : spec.command} ${spec.args.slice(-4).join(' ')}`));
  const runAdd = (): Promise<number> => new Promise<number>((resolveExit) => {
    const child = spawn(spec.command, spec.args, {
      cwd: REPO_ROOT,
      env: { ...process.env, DSH_HOME: SANDBOX_HOME },
      stdio: 'inherit',
      shell: spec.useShell,
    });
    const timer = setTimeout(() => {
      killTree(child);
      resolveExit(124);
    }, INSTALL_TIMEOUT_MS);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolveExit(code ?? 1);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      printErr(red(`安装进程启动失败：${toErrorMessage(error)}`));
      resolveExit(1);
    });
  });
  let exitCode = await runAdd();
  if (exitCode !== 0) {
    // pnpm 11 构建审批门重试：见 approvePendingBuilds 的决策依据。
    // dsh CLI 对非 git 源只报 diagnostics 不给指引，这里替开发者走完
    // 官方 Web UI 的 approve-and-retry 同款流程；半提交回滚见
    // rollbackHalfCommittedInstall 的注释——不回滚则重试退出 0 也不激活
    const approved = approvePendingBuilds(options);
    if (approved.length > 0) {
      rollbackHalfCommittedInstall(options, pkgName);
      println(yellow(`pnpm 构建审批门（${approved.join('、')}）：按无需构建批准，回滚半提交安装后重试`));
      exitCode = await runAdd();
    }
  }
  if (exitCode === 124) {
    throw new Error(`安装超时（${INSTALL_TIMEOUT_MS / 1000}s）——首次 npx 下载 dsh 发行包较慢，可重试或用 --dsh-bin 指定本地 dsh`);
  }
  if (exitCode !== 0) {
    throw new Error(`dsh plugin add 失败（退出码 ${exitCode}）。若报 127 或 pnpm 未找到：`
      + 'dsh plugin 是对 pnpm 的原样转发，需要 PATH 上有 pnpm（npm i -g pnpm）');
  }
}

/** 启动结果 */
interface BootResult {
  /** 带令牌的访问 URL（从启动日志捕获） */
  webUrl: string;
  /** dsh web 子进程 */
  child: ChildProcess;
}

/**
 * 启动沙箱 dsh web 并等待健康特征。
 *
 * @param options - 沙箱选项
 * @returns 启动结果（子进程仍在前台运行，由调用方决定去留）
 * @throws Error 启动失败或超时（附日志尾部）
 */
async function bootWeb(options: DevOptions): Promise<BootResult> {
  const spec = dshSpawnSpec(options, [
    '--profile', options.profile,
    '--host', '127.0.0.1',
    '--port', String(options.port),
    // 沙箱在终端里跑，弹浏览器交给脚本最后打印的 URL
    '--no-open',
  ]);
  const child = spawn(spec.command, spec.args, {
    cwd: REPO_ROOT,
    env: { ...process.env, DSH_HOME: SANDBOX_HOME },
    stdio: ['ignore', 'pipe', 'pipe'],
    // POSIX 下自成进程组，便于 killTree 整组回收
    detached: process.platform !== 'win32',
  });

  const logTail: string[] = [];
  let settled = false;
  const outcome = await new Promise<BootResult>((resolveBoot, rejectBoot) => {
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      rejectBoot(new Error(`启动超时（${BOOT_TIMEOUT_MS / 1000}s），日志尾部：\n${logTail.slice(-40).join('\n')}`));
    }, BOOT_TIMEOUT_MS);

    /** 消费输出流：滚动保留日志尾部，匹配健康/失败特征 */
    const consume = (chunk: Buffer): void => {
      const text = chunk.toString('utf8');
      for (const line of text.split(/\r?\n/)) {
        if (line.trim() === '') continue;
        logTail.push(line);
        if (logTail.length > 200) logTail.shift();
      }
      if (settled) return;
      const urlMatch = BOOT_URL_PATTERN.exec(text);
      if (urlMatch !== null) {
        settled = true;
        clearTimeout(timer);
        resolveBoot({ webUrl: urlMatch[0], child });
        return;
      }
      if (BOOT_FAILURE_PATTERN.test(text)) {
        settled = true;
        clearTimeout(timer);
        rejectBoot(new Error(`dsh 启动失败，日志尾部：\n${logTail.slice(-40).join('\n')}`));
      }
    };
    child.stdout?.on('data', consume);
    child.stderr?.on('data', consume);
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectBoot(new Error(`dsh 进程启动失败：${toErrorMessage(error)}`));
    });
    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectBoot(new Error(`dsh 进程提前退出（码 ${code}），日志尾部：\n${logTail.slice(-40).join('\n')}`));
    });
  }).catch((error: unknown) => {
    killTree(child);
    throw error;
  });

  // 启动成功后把后续日志透传到终端（联调时看得到宿主半的 logger 输出）
  const passthrough = (chunk: Buffer): void => { process.stdout.write(chunk); };
  child.stdout?.on('data', passthrough);
  child.stderr?.on('data', passthrough);
  return outcome;
}

/**
 * 冒烟探针：ping 路由鉴权、首页引导图、client bundle 下发。
 *
 * @param options - 沙箱选项
 * @param webUrl - 带令牌的访问 URL
 * @param pkgName - 包名
 * @throws Error 任一探针失败（消息里带判读指引）
 */
async function runProbes(options: DevOptions, webUrl: string, pkgName: string): Promise<void> {
  const base = `http://127.0.0.1:${options.port}`;

  // 0. 令牌换 Cookie：带令牌首访是 3xx + set-cookie（令牌换 Cookie 后重定向到
  //    干净 /，见 dsh connection 的 authorizeIndex；实测状态码是 303）——node
  //    fetch 默认跟随重定向且不保存 cookie，必须手动接管：先拿 cookie，后续
  //    探针全部带它
  const exchange = await fetch(webUrl, { redirect: 'manual' });
  const setCookie = exchange.headers.getSetCookie()[0];
  const isRedirect = exchange.status >= 300 && exchange.status < 400;
  if (!isRedirect || setCookie === undefined) {
    throw new Error(`令牌换 Cookie 失败：期望 3xx + set-cookie，实际 ${exchange.status}`
      + (setCookie === undefined ? '（无 set-cookie 头）' : '')
      + '——令牌 URL 无效或 connection 服务异常');
  }
  const cookiePair = setCookie.split(';')[0] ?? '';

  // 1. ping 路由双探针。实测教训：无凭据请求对**未注册**的 /api 路径同样被
  //    鉴权门拦成 401——无凭据 401 只证明鉴权门在工作，不是注册证据；带
  //    Cookie 的 200 才是路由真实注册的证明
  //    a. 无凭据：期望 401/403（鉴权门生效）；200 = 路由绕过鉴权（安全回归）
  let anonStatus = 0;
  for (let attempt = 0; attempt < PROBE_RETRIES; attempt += 1) {
    try {
      anonStatus = (await fetch(`${base}${ROUTE_PREFIX}/ping`)).status;
      break;
    } catch {
      // webserver 还没就绪，重试
    }
    await new Promise<void>((r) => { setTimeout(r, PROBE_INTERVAL_MS); });
  }
  if (anonStatus === 200) {
    throw new Error('ping 路由（无凭据）返回 200——路由绕过了 /api 鉴权通道（安全回归）');
  }
  if (anonStatus !== 401 && anonStatus !== 403) {
    throw new Error(`ping 路由（无凭据）返回 ${anonStatus}——期望 401/403（webserver 或鉴权门异常）`);
  }
  println(green(`✓ ping 无凭据 ${anonStatus}（/api 鉴权门生效）`));

  //    b. 带 Cookie：期望 200（路由注册且会话被认可）。路由注册可能略晚于
  //       webserver 监听，404 时重试；穷尽仍是 404 = 插件没挂上
  let authedStatus = 0;
  for (let attempt = 0; attempt < PROBE_RETRIES; attempt += 1) {
    try {
      authedStatus = (await fetch(`${base}${ROUTE_PREFIX}/ping`, { headers: { cookie: cookiePair } })).status;
      if (authedStatus !== 404) break;
    } catch {
      // 瞬时网络错误，按未就绪重试
    }
    await new Promise<void>((r) => { setTimeout(r, PROBE_INTERVAL_MS); });
  }
  if (authedStatus !== 200) {
    throw new Error(`ping 路由（带 Cookie）返回 ${authedStatus}——期望 200。404 = 插件没挂上：`
      + '检查 profile 的 dsh.profile.bundles 是否含本包（add 失败后重试会跳过激活，'
      + '见 installPlugin 的半提交回滚）、宿主半 bundle 是否加载失败（看上方日志）；'
      + '401/403 = 会话 Cookie 未被认可');
  }
  println(green('✓ ping 带 Cookie 200（路由已注册且受鉴权保护）'));

  // 2. 首页（带 Cookie）：引导图必须含本包
  const indexResponse = await fetch(`${base}/`, { headers: { cookie: cookiePair } });
  if (!indexResponse.ok) {
    throw new Error(`首页（带 Cookie）返回 ${indexResponse.status}——会话 Cookie 未被认可`);
  }
  const indexHtml = await indexResponse.text();
  if (!indexHtml.includes(pkgName)) {
    throw new Error('首页引导图里没有本包——检查 package.json 的 dsh.client 声明与 exports["./client"]');
  }
  println(green('✓ 首页 200，引导图含本包'));

  // 3. client bundle：组合脚本 200 且含本包的 __ModuleLoader__ 注册壳。
  //    首页有多个组合批次（大应用批 + 含本包的小批），取**含本包**的那条
  //    URL 验证。HTML 属性里的 & 被转义成 &amp;，取出的 URL 必须还原，否则
  //    rev 参数名会变成 "amp;rev"，服务器按无效组合返回 404（实测踩过）；
  //    URL 是文档相对形式（无前导斜杠，引导图/preload 里都是 `plugins/??…`，
  //    浏览器按文档基准解析）——正则同时容忍两种形态，拼绝对地址时统一补 /
  const bundleUrls = [...indexHtml.matchAll(/\/?plugins\/\?\?[^"'\s]+/g)]
    .map(match => match[0].replaceAll('&amp;', '&'));
  const ownBundleUrl = bundleUrls.find(url => url.includes(`${pkgName}/client.js`));
  if (ownBundleUrl !== undefined) {
    const bundleResponse = await fetch(`${base}/${ownBundleUrl.replace(/^\//, '')}`);
    const bundleText = await bundleResponse.text();
    if (!bundleResponse.ok) {
      throw new Error(`client bundle 返回 ${bundleResponse.status}（${ownBundleUrl}）`);
    }
    if (!bundleText.includes(pkgName)) {
      throw new Error('client bundle 里没有本包内容——exports["./client"] 指向的文件缺失或为空');
    }
    println(green('✓ client bundle 200，含本包注册壳'));
  } else {
    println(yellow('! 首页里没找到含本包的 /plugins/?? 组合脚本 URL，跳过 bundle 探针'));
  }
}

/**
 * 脚本入口。
 *
 * @returns 进程退出码
 */
async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      smoke: { type: 'boolean', default: false },
      sync: { type: 'boolean', default: false },
      fresh: { type: 'boolean', default: false },
      port: { type: 'string', default: String(DEFAULT_PORT) },
      profile: { type: 'string', default: 'web' },
      'dsh-version': { type: 'string', default: DEFAULT_DSH_VERSION },
      'dsh-bin': { type: 'string' },
      'install-spec': { type: 'string' },
    },
    strict: true,
  });
  const options: DevOptions = {
    smoke: values.smoke === true,
    sync: values.sync === true,
    fresh: values.fresh === true,
    port: Number.parseInt(values.port ?? String(DEFAULT_PORT), 10),
    profile: values.profile ?? 'web',
    dshVersion: values['dsh-version'] ?? DEFAULT_DSH_VERSION,
    ...(values['dsh-bin'] !== undefined ? { dshBin: values['dsh-bin'] } : {}),
    ...(values['install-spec'] !== undefined ? { installSpec: values['install-spec'] } : {}),
  };
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as { name: string };

  // 1. 构建 + 护栏（--sync 也要重新构建，同步的才是最新产物）
  println(bold('构建插件产物'));
  await buildPlugin();
  const violations = runChecks();
  if (violations.length > 0) {
    for (const violation of violations) {
      printErr(red(`✗ ${violation.file}：${violation.message}`));
    }
    return 1;
  }
  println(green('✓ 护栏检查通过'));

  // 2. --sync：只覆盖沙箱里的 lib/，到此为止
  if (options.sync) {
    if (syncLibToSandbox(options, pkg.name)) {
      println(green(`✓ 已同步 lib/ 进沙箱（profiles/${options.profile}）`));
      println(dim('宿主半改动需重启 dsh 进程生效；浏览器半改动刷新页面即可'));
      return 0;
    }
    printErr(red('沙箱里还没安装过本包——先跑一次不带 --sync 的完整流程'));
    return 1;
  }

  // 3. 沙箱准备与安装
  if (options.fresh) {
    println(dim('清空沙箱'));
    rmSync(SANDBOX_HOME, { recursive: true, force: true });
  }
  mkdirSync(SANDBOX_HOME, { recursive: true });
  const installed = existsSync(join(SANDBOX_HOME, 'profiles', options.profile, 'node_modules', pkg.name));
  try {
    if (installed && !options.fresh) {
      // 已装过：pnpm file: 安装是拷贝语义，日常迭代用同步代替重装（快一个数量级）
      if (!syncLibToSandbox(options, pkg.name)) {
        await installPlugin(options, pkg.name);
      } else {
        println(green('✓ 沙箱已装过本包，同步 lib/ 代替重装（--fresh 可强制重装）'));
      }
    } else {
      println(bold('安装插件进沙箱 profile'));
      await installPlugin(options, pkg.name);
      println(green('✓ 安装完成'));
    }
  } catch (error) {
    printErr(red(toErrorMessage(error)));
    return 1;
  }

  // 4. 启动 dsh web 并等待健康
  println(bold(`启动沙箱 dsh（profile=${options.profile}，端口 ${options.port}）`));
  let boot: BootResult;
  try {
    boot = await bootWeb(options);
  } catch (error) {
    printErr(red(toErrorMessage(error)));
    return 1;
  }
  println(green(`✓ 启动健康：${cyan(boot.webUrl)}`));

  // Ctrl-C：回收整个子进程树后退出（Windows 收不到合成 SIGINT 的问题不影响
  // 真实键盘中断；taskkill /T 兜住 npx → node 的进程链）
  let stopping = false;
  process.once('SIGINT', () => {
    if (stopping) return;
    stopping = true;
    println(dim('\n停止沙箱…'));
    killTree(boot.child);
    process.exit(130);
  });

  // 5. 冒烟探针
  try {
    await runProbes(options, boot.webUrl, pkg.name);
  } catch (error) {
    printErr(red(`冒烟失败：${toErrorMessage(error)}`));
    killTree(boot.child);
    return 1;
  }

  if (options.smoke) {
    killTree(boot.child);
    println(green('冒烟全绿'));
    return 0;
  }

  // 6. 前台常驻：联调模式，打印访问 URL 等 Ctrl-C
  println();
  println(bold('沙箱就绪，浏览器打开：'));
  println(cyan(boot.webUrl));
  println(dim('Settings → 远程会话面板；宿主半日志实时透传在上方'));
  println(dim('Ctrl-C 停止（会回收整个 dsh 进程树）'));
  await new Promise<void>(() => {
    // 常驻直到 SIGINT 处理器 exit；子进程意外退出时也要收尾
    boot.child.on('exit', (code) => {
      println(yellow(`dsh 进程退出（码 ${code}）`));
      process.exit(code ?? 0);
    });
  });
  return 0;
}

process.exitCode = await main();

/**
 * @file 内网运行时部署（复用远端现有 Node + 内网 npm 源）
 * @description 能力层的「existing」部署分支：远端已经有 Node 与 npm，但不让用户
 *              重装 Node、也不让引导访问公网 Node 发行站或公共 npm registry。
 *
 * 与另外两种部署方式的分工：
 * - `auto`：沿用原流程，远端没有 Node 时从 Node 发行站下载，npm 走公共镜像
 * - `existing`：只探测并复用远端现成 Node/npm；npm 包（dsh、pnpm）只从用户
 *   指定的内网源安装；不测速 Node 镜像、不查询公网 registry
 * - `offline`：严格离线，只校验已导入的完整运行时，不安装任何东西
 *
 * 隔离约束：
 * - **绝不修改系统 Node 的安装目录。** `npm install -g` 默认会写系统 prefix，
 *   所以 existing 模式在管理根下建私有 bin 目录（node/npm 符号链接）与私有
 *   npm prefix（pnpm 落在这里），所有写操作都留在 `~/.dsh-remote-explorer/btsd321/`
 * - 内网源地址拒绝 userinfo/query/hash：registry 会进入日志、远端 `.npmrc`
 *   与进程环境，带凭据的 URL 会造成材料泄露
 * - `DSH_REMOTE_OFFLINE=1` 是宿主级硬开关，不能与 existing 模式同时成立——
 *   严格离线语义下连内网 registry 也不允许访问
 */

import { RemoteError } from '../util/errors.js';
import { createLogger } from '../util/logger.js';
import { quote } from '../util/shell-quote.js';
import { writeRemoteTextFile } from '../transport/write-text.js';
import { parseSemver } from './dsh-installer.js';
import { assertNodeStable, checkNodeStability } from './probe.js';
import { SESSION_PROFILE_NAME } from './profile-writer.js';
import type { NodeInstallResult } from './node-installer.js';
import type { RemoteContext } from './remote-context.js';

const log = createLogger('intranet-runtime');

/** 部署方式（面板/CLI/环境配置共用） */
export type DeploymentMode = 'auto' | 'existing' | 'offline';

/** 合法的部署方式集合（类型收窄与路由校验共用） */
export const DEPLOYMENT_MODES: readonly DeploymentMode[] = ['auto', 'existing', 'offline'];

/** 远端现有 Node 的探测结果 */
export interface ExistingNodeInspection {
  /** 实际执行的 node 绝对路径 */
  nodePath: string;
  /** node 版本（带 v 前缀） */
  nodeVersion: string;
  /** npm 可执行文件绝对路径 */
  npmPath: string;
  /** npm 版本（原始输出，不保证 semver） */
  npmVersion: string;
  /** node/npm 所在目录 */
  nodeBinDir: string;
}

/** existing 模式最终返回的运行时 */
export interface ExistingRuntimeResult {
  /** 供后续安装器/启动器使用的 Node 结果（binDir 为私有 shim 目录） */
  node: NodeInstallResult;
  /** 探测到的现成 Node 信息 */
  inspection: ExistingNodeInspection;
}

/** 探测现有 Node 的选项 */
export interface InspectExistingNodeOptions {
  /** 显式 node 路径；空/缺省时从远端非交互 PATH 探测 */
  nodePath?: string;
  /** 取消信号 */
  signal?: AbortSignal;
}

/**
 * 判断值是否为合法部署方式。
 *
 * @param value - 外部输入（路由 body、配置文件）
 * @returns 是否合法
 */
export function isValidDeploymentMode(value: unknown): value is DeploymentMode {
  return typeof value === 'string' && (DEPLOYMENT_MODES as readonly string[]).includes(value);
}

/**
 * 归一部署方式并处理三个来源的优先级。
 *
 * 优先级：`DSH_REMOTE_OFFLINE=1`（进程级硬开关）> 显式 deploymentMode >
 * 旧版 offline 布尔。旧布尔保留是为了兼容既有配置与 CLI `--offline`，但
 * 面板显式选择 existing/auto 时应能覆盖「配置里默认 offline」的旧默认值。
 *
 * @param explicit - 显式部署方式
 * @param legacyOffline - 旧版严格离线开关
 * @returns 最终部署方式
 * @throws Error 宿主级严格离线与 existing 冲突
 */
export function resolveDeploymentMode(
  explicit: DeploymentMode | undefined,
  legacyOffline: boolean | undefined,
): DeploymentMode {
  const strictOffline = process.env.DSH_REMOTE_OFFLINE === '1';
  if (strictOffline) {
    if (explicit === 'existing') {
      throw new Error(
        'DSH_REMOTE_OFFLINE=1 已开启严格离线模式，不能使用「现有 Node + 内网 npm 源」部署；'
          + '请先取消该环境变量并重启宿主进程',
      );
    }
    return 'offline';
  }
  if (explicit !== undefined) return explicit;
  return legacyOffline === true ? 'offline' : 'auto';
}

/**
 * 校验内网 npm 源 URL。
 *
 * 允许路径（企业仓库常见 `https://nexus.example.com/repository/npm/`），
 * 但禁止 userinfo、query、hash 与控制字符——这些内容会进入远端 `.npmrc`、
 * 日志与错误消息。凭据应由远端 npm 自己的认证配置提供，而不是写在 URL 里。
 *
 * @param raw - 原始地址
 * @returns 错误消息；合法时 undefined
 */
export function validateNpmRegistry(raw: string): string | undefined {
  if (typeof raw !== 'string' || raw.trim() === '') return 'npm 源地址不能为空';
  if (/[\x00-\x1f\x7f]/.test(raw)) return 'npm 源地址含控制字符';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return `npm 源地址 '${raw}' 不是合法 URL`;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return `npm 源地址 '${raw}' 必须是 http 或 https 协议`;
  }
  if (url.username !== '' || url.password !== '') {
    return 'npm 源地址不允许携带用户名或密码（凭据请在远端 npm 配置中提供）';
  }
  if (url.search !== '') return 'npm 源地址不允许携带查询串';
  if (url.hash !== '') return 'npm 源地址不允许携带片段';
  return undefined;
}

/**
 * 归一内网 npm 源地址（去掉尾部斜杠；仅在已通过校验后调用）。
 *
 * @param raw - 原始地址
 * @returns 归一后的地址
 */
export function normalizeNpmRegistry(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
}

/**
 * 校验显式 node 路径。
 *
 * @param raw - 原始路径
 * @returns 错误消息；合法时 undefined
 */
export function validateNodePath(raw: string): string | undefined {
  if (typeof raw !== 'string' || raw.trim() === '') return 'Node 路径不能为空';
  if (/[\x00-\x1f\x7f]/.test(raw)) return 'Node 路径含控制字符';
  if (raw.includes('\\')) return `Node 路径必须是 POSIX 绝对路径，实际为 ${raw}`;
  // MSYS/Git Bash 会把 /home/x 改写成 C:/...；这里同时拒绝盘符形态
  if (!raw.startsWith('/')) return `Node 路径必须是绝对路径（以 / 开头），实际为 ${raw}`;
  return undefined;
}

/**
 * 判断 Node 版本是否满足 dsh 引擎要求。
 *
 * dsh 的 engines 为 `^22.19.0 || >=24.0.0`；v22 在部分 aarch64 机器上有已知
 * 不稳定问题（见 lessons 第 9 条），但 x64 上的 v22.19+ 仍是官方支持范围，
 * 因此这里按引擎要求接受，稳定性由后续自检兜底。
 *
 * @param version - 带或不带 v 前缀的版本
 * @returns 是否满足
 */
export function nodeVersionAccepted(version: string): boolean {
  const parsed = parseSemver(version.replace(/^v/, '').trim());
  if (parsed === undefined) return false;
  if (parsed.major === 22) {
    return parsed.minor >= 19;
  }
  return parsed.major >= 24;
}

/**
 * 探测远端现有 Node 与配套 npm（只读，不创建任何文件）。
 *
 * 非交互 SSH 的 PATH 与用户登录 shell 可能不同：显式给出 nodePath 最可靠；
 * 缺省时用 `command -v node`，找不到就明确报错，而不是猜路径。
 *
 * @param ctx - 远端执行上下文
 * @param options - 探测选项
 * @returns 探测结果
 * @throws RemoteError('EXEC_FAILED') 找不到 node/npm 或版本不可用
 */
export async function inspectExistingNode(
  ctx: RemoteContext,
  options: InspectExistingNodeOptions = {},
): Promise<ExistingNodeInspection> {
  const { transport } = ctx;
  const { signal } = options;
  const nodePath = options.nodePath?.trim();
  if (nodePath !== undefined && nodePath !== '') {
    const error = validateNodePath(nodePath);
    if (error !== undefined) throw new Error(error);
  }
  const nodePathArg = nodePath !== undefined && nodePath !== '' ? quote(nodePath) : '';

  // 一条命令拿齐：node 路径、版本、npm 路径、npm 版本。用绝对路径执行，
  // 避免 PATH 里存在多个 Node 时误判；npm 优先取与 node 同目录的副本。
  const script = [
    `np=${nodePathArg === '' ? '$(command -v node 2>/dev/null || true)' : nodePathArg}`,
    'if [ -z "$np" ]; then printf "NODE_MISSING=1\\n"; exit 0; fi',
    'printf "NODE_PATH=%s\\n" "$np"',
    'printf "NODE_VERSION=%s\\n" "$($np -v 2>/dev/null)"',
    'nd=$(dirname "$np")',
    'PATH="$nd:$PATH"',
    'if [ -x "$nd/npm" ]; then npm="$nd/npm"; else npm=$(command -v npm 2>/dev/null || true); fi',
    'if [ -z "$npm" ]; then printf "NPM_MISSING=1\\n"; exit 0; fi',
    'printf "NPM_PATH=%s\\n" "$npm"',
    'printf "NPM_VERSION=%s\\n" "$($npm -v 2>/dev/null)"',
  ].join('\n');

  const result = await transport.exec(script, {
    allowNonZeroExit: true,
    ...(signal ? { signal } : {}),
  });
  if (result.stdout.includes('NODE_MISSING=1')) {
    throw new RemoteError(
      'EXEC_FAILED',
      `主机 ${transport.hostAlias} 的远端非交互 PATH 中找不到 node。`
        + '请在面板填写「远端 Node 路径」（例如 /opt/node/bin/node），或确认该用户在 SSH 环境下能执行 node -v',
      { hostAlias: transport.hostAlias },
    );
  }
  if (result.stdout.includes('NPM_MISSING=1')) {
    throw new RemoteError(
      'EXEC_FAILED',
      `主机 ${transport.hostAlias} 的现有 Node 找不到配套 npm；`
        + '请安装 npm（或填写带 npm 的 Node 发行版路径）后重试',
      { hostAlias: transport.hostAlias },
    );
  }

  const nodePathValue = parseLine(result.stdout, 'NODE_PATH');
  const nodeVersion = parseLine(result.stdout, 'NODE_VERSION');
  const npmPath = parseLine(result.stdout, 'NPM_PATH');
  const npmVersion = parseLine(result.stdout, 'NPM_VERSION');
  if (nodePathValue === undefined || nodeVersion === undefined || npmPath === undefined) {
    throw new RemoteError(
      'EXEC_FAILED',
      `主机 ${transport.hostAlias} 的现有 Node 探测输出无法解析：${result.stdout.trim().slice(0, 200)}`,
      { hostAlias: transport.hostAlias },
    );
  }
  if (!nodeVersionAccepted(nodeVersion)) {
    throw new RemoteError(
      'EXEC_FAILED',
      `主机 ${transport.hostAlias} 的现有 Node ${nodeVersion || '(无输出)'} 不满足 dsh 要求`
        + '（需要 ^22.19.0 或 >=24.0.0）；请升级 Node 或换用其他版本',
      { hostAlias: transport.hostAlias },
    );
  }
  if (npmVersion === undefined || npmVersion === '') {
    throw new RemoteError(
      'EXEC_FAILED',
      `主机 ${transport.hostAlias} 的 npm 无法执行（${npmPath}），请检查该路径与权限`,
      { hostAlias: transport.hostAlias },
    );
  }

  const nodeBinDir = dirnameOf(nodePathValue);
  return { nodePath: nodePathValue, nodeVersion, npmPath, npmVersion, nodeBinDir };
}

/**
 * 准备 existing 模式的私有运行时布局。
 *
 * 创建 `<base>/existing/bin/{node,npm}` 符号链接与私有 prefix。这样：
 * - `npm install -g` 只会写 `<base>/existing/lib/node_modules`，不碰系统目录
 * - dsh/pnpm 启动时 PATH 首位就是私有 bin，`#!/usr/bin/env node` 能命中
 *   用户指定的 Node
 *
 * @param ctx - 远端执行上下文
 * @param options - 探测与稳定性选项
 * @returns 运行时结果
 * @throws RemoteError('EXEC_FAILED' | 'NODE_UNSTABLE') 探测或自检失败
 */
export async function prepareExistingRuntime(
  ctx: RemoteContext,
  options: InspectExistingNodeOptions & {
    /** 跳过稳定性自检（仅只读诊断场景使用） */
    skipStabilityCheck?: boolean;
  } = {},
): Promise<ExistingRuntimeResult> {
  const { transport, paths } = ctx;
  const inspection = await inspectExistingNode(ctx, options);

  // 1. 稳定性自检：npm install 会起几十次 node 子进程，不稳定的运行时
  //    必须在这里拦下（与 auto 模式同一阈值，见 probe.ts 文件头）
  if (options.skipStabilityCheck !== true) {
    const stability = await checkNodeStability(
      transport, inspection.nodePath, undefined, options.signal,
    );
    assertNodeStable(stability, transport.hostAlias, inspection.nodeVersion);
  }

  // 2. 私有 bin 与 prefix：符号链接而不是复制二进制，升级系统 Node 后
  //    下次连接自动跟随（用户显式路径不变时）
  const shimBin = paths.existingRuntimeBinDir;
  const shimRoot = paths.existingRuntimeRoot;
  const commands = [
    `mkdir -p ${quote(shimBin)}`,
    `ln -sfn ${quote(inspection.nodePath)} ${quote(`${shimBin}/node`)}`,
    `ln -sfn ${quote(inspection.npmPath)} ${quote(`${shimBin}/npm`)}`,
    // npx 不是安装必需，但 dsh 插件管理/用户命令可能用到；存在才链
    `if [ -x ${quote(`${inspection.nodeBinDir}/npx`)} ]; then ln -sfn ${quote(`${inspection.nodeBinDir}/npx`)} ${quote(`${shimBin}/npx`)}; fi`,
  ];
  await transport.exec(commands.join('\n'), {
    ...(options.signal ? { signal: options.signal } : {}),
  });

  log.info(
    `existing 运行时：Node ${inspection.nodeVersion}（${inspection.nodePath}），`
      + `npm ${inspection.npmVersion}，私有 prefix ${shimRoot}`,
    { hostAlias: transport.hostAlias },
  );

  return {
    node: {
      version: inspection.nodeVersion,
      nodeBin: inspection.nodePath,
      binDir: shimBin,
      reused: true,
    },
    inspection,
  };
}

/**
 * 把内网 registry 写入主机级 profile 的 `.npmrc`（幂等、保留其它配置）。
 *
 * 远端 dsh 的插件管理在 `base/profiles/web/` 里跑 pnpm；pnpm 会读该目录的
 * `.npmrc`。只替换 `registry=` 这一行，注释、scope、认证等其它配置原样保留。
 *
 * @param ctx - 远端执行上下文
 * @param registryUrl - 已校验的内网源
 * @returns 是否实际写入了文件
 * @throws Error 读取或写入失败
 */
export async function ensureProfileNpmRegistry(
  ctx: RemoteContext,
  registryUrl: string | undefined,
): Promise<boolean> {
  if (registryUrl === undefined || registryUrl === '') return false;
  const error = validateNpmRegistry(registryUrl);
  if (error !== undefined) throw new Error(error);
  const { transport, paths } = ctx;
  const profileDir = paths.hostProfileDir(SESSION_PROFILE_NAME);
  const npmrcPath = `${profileDir}/.npmrc`;
  const existing = await transport.exec(
    `cat ${quote(npmrcPath)} 2>/dev/null || true`,
    { allowNonZeroExit: true },
  );
  const lines = existing.stdout.split('\n');
  const kept = lines.filter(line => !/^\s*registry\s*=/.test(line));
  while (kept.length > 0 && kept[kept.length - 1] === '') kept.pop();
  const next = `${kept.join('\n')}${kept.length > 0 ? '\n' : ''}registry=${normalizeNpmRegistry(registryUrl)}\n`;
  if (next === existing.stdout) return false;
  await writeRemoteTextFile(transport, npmrcPath, next);
  log.info('已写入内网 npm 源到 host profile .npmrc', {
    hostAlias: transport.hostAlias,
    path: npmrcPath,
  });
  return true;
}

/**
 * 从探测输出中取一行 `KEY=value`。
 *
 * @param output - 命令输出
 * @param key - 键名
 * @returns 值；缺失时 undefined
 */
function parseLine(output: string, key: string): string | undefined {
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith(`${key}=`)) return trimmed.slice(key.length + 1);
  }
  return undefined;
}

/**
 * 取 POSIX 路径的目录部分（避免使用 node:path——本机可能是 Windows）。
 *
 * @param path - 绝对路径
 * @returns 目录路径
 */
function dirnameOf(path: string): string {
  const index = path.lastIndexOf('/');
  if (index <= 0) return '/';
  return path.slice(0, index);
}

/**
 * 只读探测 existing 模式所需信息（doctor 用，不创建 shim、不做稳定性自检）。
 *
 * @param transport - 已连接的传输
 * @param ctx - 远端上下文
 * @param options - 探测选项
 * @returns 探测结果
 */
export async function inspectExistingRuntimeForDoctor(
  ctx: RemoteContext,
  options: InspectExistingNodeOptions = {},
): Promise<ExistingNodeInspection> {
  return inspectExistingNode(ctx, options);
}

/**
 * 校验 npm registry 是否可访问并包含 dsh（doctor 用）。
 *
 * @param ctx - 远端执行上下文
 * @param options - 检查选项
 * @returns 检查结果
 */
export async function checkNpmRegistry(
  ctx: RemoteContext,
  options: { registryUrl: string; nodeBinDir: string; signal?: AbortSignal },
): Promise<{ ok: boolean; version?: string; error?: string }> {
  const { transport, paths } = ctx;
  const result = await transport.exec(
    `npm view ${quote('@deepseek-ai/dsh')} version --registry=${quote(normalizeNpmRegistry(options.registryUrl))} 2>&1`,
    {
      allowNonZeroExit: true,
      pathPrefix: options.nodeBinDir,
      env: { npm_config_cache: paths.npmCache },
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );
  const version = result.stdout.trim().split('\n').filter(Boolean).at(-1);
  if (result.exitCode !== 0) {
    return { ok: false, error: result.stdout.trim().slice(0, 300) || `退出码 ${result.exitCode}` };
  }
  return { ok: true, ...(version ? { version } : {}) };
}

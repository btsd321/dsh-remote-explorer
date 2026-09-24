/**
 * @file 远端环境探测
 * @description 在引导前查清远端状况：平台、基础命令、已装 Node 与 dsh、磁盘余量，
 *              并对候选 Node 运行时做**稳定性自检**。
 *
 * 为什么需要稳定性自检（P0 实测得出）：实测的 aarch64 验证机上 Node v22.23.2 起进程
 * 的崩溃率高达 35%（7/20），表现为 V8 初始化 isolate 时 `MemoryChunk allocation failed`
 * + SIGTRAP，但机器有 13G 空闲内存、cgroup 无限制——不是真 OOM，而是 VA 空间与
 * ASLR 交互导致的随机失败。`npm install` 要起几十次 node 子进程，35% 的单次崩溃率
 * 意味着整装几乎必败，且报错会误导到最后一个失败的包（当时是 koffi）。
 * v24.11.1 在同一台机器上 0/60 失败，故决策锁定 v24 系。
 *
 * 结论：装完 Node 必须自检，不合格就换版本，别等 npm install 跑一半再回溯。
 */

import { RemoteError } from '../util/errors.js';
import { formatBytes } from '../util/format.js';
import { quote } from '../util/shell-quote.js';
import { BASE_DIR_NAME } from './remote-paths.js';
import type { RemotePlatform, RemoteTransport } from '../transport/types.js';

/** 远端基础命令的可用情况 */
export interface RemoteTools {
  /** 是否有 curl */
  hasCurl: boolean;
  /** 是否有 wget */
  hasWget: boolean;
  /** 是否有 tar */
  hasTar: boolean;
  /** 是否有 xz（解 .tar.xz 需要） */
  hasXz: boolean;
}

/** 已安装的远端运行时信息 */
export interface InstalledRuntime {
  /** 绝对路径 */
  path: string;
  /** 版本号（如 v24.11.1 或 0.1.7-rc.1） */
  version: string;
}

/** 远端探测结果 */
export interface ProbeResult {
  /** 平台信息 */
  platform: RemotePlatform;
  /** 远端家目录绝对路径 */
  homeDir: string;
  /** 基础命令可用情况 */
  tools: RemoteTools;
  /** 已由本工具安装的 Node 列表（`~/.dsh-remote-explorer/btsd321/node/` 下） */
  managedNodes: InstalledRuntime[];
  /** 已由本工具安装的 dsh 列表（`~/.dsh-remote-explorer/btsd321/versions/` 下） */
  managedDsh: InstalledRuntime[];
  /** 家目录所在文件系统的可用空间（字节）；取不到为 undefined */
  availableBytes?: number;
}

/** Node 运行时稳定性自检结果 */
export interface StabilityResult {
  /** 被检查的 node 可执行文件路径 */
  nodePath: string;
  /** 总尝试次数 */
  attempts: number;
  /** 失败次数 */
  failures: number;
  /** 是否判定为稳定 */
  isStable: boolean;
}

/** 自检的默认尝试次数：P0 用 20 次即可清晰区分 v22(7/20) 与 v24(0/20) */
const DEFAULT_STABILITY_ATTEMPTS = 20;

/**
 * 允许的失败次数上限。
 *
 * 取 0：P0 实测稳定版本是 0/60，不稳定版本 35%。任何一次失败都说明
 * 这个组合在这台机器上不可靠，`npm install` 放大后必然失败。
 */
const MAX_TOLERATED_FAILURES = 0;

/** 引导所需的最小可用空间：Node 约 200M + dsh 约 500M，留一倍余量 */
const REQUIRED_BYTES = 1_500_000_000;

/**
 * 探测远端环境。
 *
 * 根目录由远端 shell 展开 `"$HOME"` 得出，不由调用方传入——探测本身就是
 * 为了拿到家目录，此时本机还不知道它的绝对路径。
 *
 * @param transport - 已连接的传输
 * @param signal - 取消信号
 * @returns 探测结果
 * @throws RemoteError('REMOTE_TOOL_MISSING') 缺少下载或解包所需的基础命令
 */
export async function probeRemote(
  transport: RemoteTransport,
  signal?: AbortSignal,
): Promise<ProbeResult> {
  const platform = transport.platform;

  // 根目录名单独转义后拼在 "$HOME" 之后——不能把 $HOME 一起塞进 quote()，
  // 单引号会阻止 shell 展开，glob 就永远匹配不到已装的运行时
  const base = `"$HOME"/${quote(BASE_DIR_NAME)}`;

  // 一次 exec 拿齐所有信息，减少往返
  const script = [
    'printf "HOME=%s\\n" "$HOME"',
    'for c in curl wget tar xz; do command -v $c >/dev/null 2>&1 && printf "TOOL=%s\\n" "$c"; done',
    `for d in ${base}/node/*/bin/node; do [ -x "$d" ] && printf "NODE=%s %s\\n" "$d" "$($d -v 2>/dev/null)"; done`,
    `for d in ${base}/versions/*/node_modules/.bin/dsh; do [ -e "$d" ] && printf "DSHBIN=%s\\n" "$d"; done`,
    `df -Pk "$HOME" 2>/dev/null | awk 'NR==2 {printf "AVAIL=%s\\n", $4}'`,
  ].join('; ');

  const result = await transport.exec(script, {
    allowNonZeroExit: true,
    ...(signal ? { signal } : {}),
  });

  const homeDir = parseFirst(result.stdout, 'HOME=') ?? '';
  const tools: RemoteTools = {
    hasCurl: hasTool(result.stdout, 'curl'),
    hasWget: hasTool(result.stdout, 'wget'),
    hasTar: hasTool(result.stdout, 'tar'),
    hasXz: hasTool(result.stdout, 'xz'),
  };

  if (!tools.hasCurl && !tools.hasWget) {
    throw new RemoteError(
      'REMOTE_TOOL_MISSING',
      `主机 ${transport.hostAlias} 上没有 curl 也没有 wget，无法下载 Node；`
        + '请先在远端安装其中之一',
      { hostAlias: transport.hostAlias },
    );
  }
  if (!tools.hasTar) {
    throw new RemoteError(
      'REMOTE_TOOL_MISSING',
      `主机 ${transport.hostAlias} 上没有 tar，无法解包 Node 发行版`,
      { hostAlias: transport.hostAlias },
    );
  }

  const managedNodes: InstalledRuntime[] = [];
  for (const line of collect(result.stdout, 'NODE=')) {
    const [path = '', version = ''] = line.split(' ');
    if (path && version) managedNodes.push({ path, version });
  }

  // dsh 版本从目录名解析（`versions/dsh-<版本>/`），不额外起进程去问
  const managedDsh: InstalledRuntime[] = [];
  for (const path of collect(result.stdout, 'DSHBIN=')) {
    const match = /\/versions\/dsh-([^/]+)\//.exec(path);
    if (match?.[1]) managedDsh.push({ path, version: match[1] });
  }

  const availRaw = parseFirst(result.stdout, 'AVAIL=');
  // df -Pk 输出的是 1K 块数
  const availableBytes = availRaw ? Number.parseInt(availRaw, 10) * 1024 : undefined;

  return {
    platform,
    homeDir,
    tools,
    managedNodes,
    managedDsh,
    ...(availableBytes !== undefined && Number.isFinite(availableBytes) ? { availableBytes } : {}),
  };
}

/**
 * 校验磁盘空间足够引导。
 *
 * @param probe - 探测结果
 * @param hostAlias - 主机别名（错误消息用）
 * @throws RemoteError('EXEC_FAILED') 可用空间不足
 */
export function assertDiskSpace(probe: ProbeResult, hostAlias: string): void {
  if (probe.availableBytes === undefined) return;
  if (probe.availableBytes >= REQUIRED_BYTES) return;
  throw new RemoteError(
    'EXEC_FAILED',
    `主机 ${hostAlias} 的家目录可用空间不足：`
      + `需要约 ${formatBytes(REQUIRED_BYTES)}，实际 ${formatBytes(probe.availableBytes)}`,
    { hostAlias },
  );
}

/**
 * 对指定 Node 可执行文件做稳定性自检。
 *
 * 连续起进程若干次，统计失败率。这一步不可省——见文件头说明。
 *
 * @param transport - 已连接的传输
 * @param nodePath - 远端 node 可执行文件绝对路径
 * @param attempts - 尝试次数
 * @param signal - 取消信号
 * @returns 自检结果
 */
export async function checkNodeStability(
  transport: RemoteTransport,
  nodePath: string,
  attempts: number = DEFAULT_STABILITY_ATTEMPTS,
  signal?: AbortSignal,
): Promise<StabilityResult> {
  // 在远端一条命令里循环，避免 N 次 SSH 往返
  const script = `f=0; for i in $(seq ${attempts}); do ${quote(nodePath)} -e 0 >/dev/null 2>&1 || f=$((f+1)); done; printf "FAIL=%s\\n" "$f"`;
  const result = await transport.exec(script, {
    allowNonZeroExit: true,
    // 自检要起 attempts 次进程，给足时间
    timeoutMs: Math.max(60_000, attempts * 3_000),
    ...(signal ? { signal } : {}),
  });

  const failures = Number.parseInt(parseFirst(result.stdout, 'FAIL=') ?? 'NaN', 10);
  if (!Number.isFinite(failures)) {
    throw new RemoteError(
      'NODE_UNSTABLE',
      `主机 ${transport.hostAlias} 上的 Node 稳定性自检无法解析结果：${result.stdout.trim().slice(0, 200)}`,
      { hostAlias: transport.hostAlias },
    );
  }

  return {
    nodePath,
    attempts,
    failures,
    isStable: failures <= MAX_TOLERATED_FAILURES,
  };
}

/**
 * 断言 Node 稳定性自检通过。
 *
 * @param stability - 自检结果
 * @param hostAlias - 主机别名
 * @param version - 被检查的 Node 版本（错误消息用）
 * @throws RemoteError('NODE_UNSTABLE') 自检不合格
 */
export function assertNodeStable(
  stability: StabilityResult,
  hostAlias: string,
  version: string,
): void {
  if (stability.isStable) return;
  const rate = Math.round((stability.failures / stability.attempts) * 100);
  throw new RemoteError(
    'NODE_UNSTABLE',
    `主机 ${hostAlias} 上的 Node ${version} 运行不稳定：`
      + `起进程 ${stability.attempts} 次失败 ${stability.failures} 次（${rate}%）。`
      + '这在 aarch64 上是已知问题（V8 初始化 isolate 随机失败，表现为 OOM 但实际内存充足），'
      + '继续引导会导致 npm install 失败。请改用其他 Node 版本（已知 v24 系稳定）',
    { hostAlias },
  );
}

/**
 * 取输出中某前缀的首个值。
 *
 * @param output - 命令输出
 * @param prefix - 行前缀
 * @returns 去掉前缀的值；没有匹配行则 undefined
 */
function parseFirst(output: string, prefix: string): string | undefined {
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith(prefix)) return trimmed.slice(prefix.length).trim();
  }
  return undefined;
}

/**
 * 取输出中某前缀的所有值。
 *
 * @param output - 命令输出
 * @param prefix - 行前缀
 * @returns 去掉前缀的值列表
 */
function collect(output: string, prefix: string): string[] {
  const values: string[] = [];
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith(prefix)) values.push(trimmed.slice(prefix.length).trim());
  }
  return values;
}

/**
 * 判断某基础命令是否存在。
 *
 * @param output - 命令输出
 * @param name - 命令名
 * @returns 是否存在
 */
function hasTool(output: string, name: string): boolean {
  return collect(output, 'TOOL=').includes(name);
}



/**
 * @file 远端 dsh 进程生命周期
 * @description 以 detach 方式启动远端 dsh、从启动输出捕获访问令牌、探活、安全停止。
 *
 * 四条 P0 实测得出的硬约束：
 *
 * 1. **必须 detach。** 用 `setsid nohup ... < /dev/null &`，否则 SSH 通道关闭会带走进程。
 *
 * 2. **必须捕获首行输出。** dsh 启动时把访问地址连令牌打在首行
 *    （`dsh web: http://127.0.0.1:<端口>/?token=<43 字符>`）。dsh 已内置令牌认证——
 *    无令牌访问返回 401，令牌换 `HttpOnly` + `SameSite=Strict` cookie。
 *    **令牌不落盘到别处**，只在这行输出里，所以日志文件既是诊断来源也是令牌唯一来源。
 *
 * 3. **停进程绝不能用 `pkill -f <模式>`。** 承载该命令的 shell 其命令行也含这个模式串，
 *    会把自己的 SSH 会话一起杀掉（P0 清理时实测踩过）。只能用 pid 文件或监听端口定位。
 *
 * 4. **没有免认证探活端点。** `/healthz`、`/version`、`/health` 全部 404，
 *    `/` 与 `/api` 无令牌时 401。所以探活靠「pid 存活 + 端口在监听」的组合判据，
 *    真正的 HTTP 探活要等 `dsh-remote-guard`（P5）。
 */

import { RemoteError } from '../util/errors.js';
import { quote } from '../util/shell-quote.js';
import { isRemotePortListening } from '../tunnel/port-allocator.js';
import { buildStartCommand } from '../provision/profile-writer.js';
import type { RemotePaths } from '../provision/remote-paths.js';
import type { RemoteTransport } from '../transport/types.js';

/** 等待启动输出出现令牌的超时（毫秒） */
const STARTUP_TIMEOUT_MS = 120_000;

/** 轮询启动日志的间隔（毫秒） */
const POLL_INTERVAL_MS = 500;

/** 停止进程后等待其退出的最长时间（毫秒） */
const STOP_TIMEOUT_MS = 15_000;

/**
 * 从 dsh 启动输出里提取令牌的模式。
 *
 * 只认 43 个 base64url 字符——P0 实测令牌长度恒为 43。
 * 收窄模式而非宽松匹配，是为了在 dsh 改变输出格式时立刻失败，
 * 而不是悄悄抓到一段无关字符串导致后续 401 难以定位。
 */
const TOKEN_PATTERN = /[?&]token=([A-Za-z0-9_-]{43})\b/;

/** 运行中的远端 dsh 会话信息 */
export interface RemoteProcessInfo {
  /** 远端进程 pid */
  pid: number;
  /** 远端监听端口 */
  port: number;
  /** 访问令牌 */
  token: string;
}

/**
 * 启动远端 dsh 并等待其就绪。
 *
 * @param transport - 已连接的传输
 * @param paths - 远端路径集合
 * @param options - 启动参数
 * @returns 进程信息（含令牌）
 * @throws RemoteError('EXEC_FAILED') 启动失败或超时未就绪
 */
export async function startRemoteDsh(
  transport: RemoteTransport,
  paths: RemotePaths,
  options: {
    /** 会话 id */
    sessionId: string;
    /** dsh 可执行入口绝对路径 */
    dshBin: string;
    /** 会话的 DSH_HOME */
    dshHome: string;
    /** profile 名 */
    profileName: string;
    /** node bin 目录 */
    nodeBinDir: string;
    /** 远端监听端口 */
    port: number;
    /** patch 文件绝对路径（可选） */
    patchFile?: string;
    /**
     * 注入 dsh 进程的额外环境变量。
     *
     * 凭据闭环用它传占位 `DEEPSEEK_API_KEY`（值是代理令牌，不是真实 key）——
     * dsh 的凭据解析优先读继承环境，缺这个变量请求会在发出前就失败
     * （`MISSING_CREDENTIAL`），代理根本收不到。
     */
    extraEnv?: Record<string, string>;
    /** 取消信号 */
    signal?: AbortSignal;
  },
): Promise<RemoteProcessInfo> {
  const { sessionId, port, signal } = options;
  const logFile = paths.sessionLogFile(sessionId);
  const pidFile = paths.sessionPidFile(sessionId);
  const runnerFile = `${paths.sessionRuntime(sessionId)}/start.sh`;

  const startCommand = buildStartCommand({
    dshBin: options.dshBin,
    profileName: options.profileName,
    port,
    ...(options.patchFile ? { patchFile: options.patchFile } : {}),
  });

  // 用 runner 脚本而非直接拼一条长命令，为了拿到**准确的 pid**：
  // 脚本先把自身 pid 写进 pid 文件，再用 exec 替换自身为 dsh——
  // exec 保留原进程号，所以文件里记的就是 dsh 的 pid。
  // 若改成 `cmd & echo $!`，拿到的是包装 shell 的 pid，dsh 退出后
  // 那个 pid 可能已被系统复用给别的进程，据此 kill 极其危险。
  const envAssignments = [
    `DSH_HOME=${quote(options.dshHome)}`,
    // skill 目录随会话隔离：dsh 的 skill-filesystem 默认读机器全局 ~/.agents
    // （DSH_AGENTS_HOME 可覆盖）。不设的话本会话会加载远端其他使用者的
    // skills——不破坏别人，但读到了别人的东西，违反隔离契约。
    // 指向会话内的目录：不存在即空源，bundled skills 照常
    `DSH_AGENTS_HOME=${quote(`${paths.sessionHome(sessionId)}/agents`)}`,
    ...Object.entries(options.extraEnv ?? {}).map(([key, value]) => `${key}=${quote(value)}`),
    // PATH 特殊处理："$PATH" 必须留在引号外由 shell 展开，见 shell-quote 的说明
    `PATH=${quote(options.nodeBinDir)}:"$PATH"`,
  ];
  const runner = [
    '#!/bin/sh',
    `echo $$ > ${quote(pidFile)}`,
    `exec env ${envAssignments.join(' ')} ${startCommand}`,
    '',
  ].join('\n');

  const launch = [
    `printf '%s' ${quote(runner)} > ${quote(runnerFile)}`,
    `rm -f ${quote(logFile)} ${quote(pidFile)}`,
    // detach：脱离 SSH 通道的进程组与终端，否则通道关闭即被杀
    `setsid nohup sh ${quote(runnerFile)} > ${quote(logFile)} 2>&1 < /dev/null &`,
  ].join('\n');

  await transport.exec(launch, { ...(signal ? { signal } : {}) });

  // 轮询日志等令牌出现
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let lastLog = '';
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    await delay(POLL_INTERVAL_MS, signal);

    const read = await transport.exec(`cat ${quote(logFile)} 2>/dev/null || true`, {
      allowNonZeroExit: true,
      ...(signal ? { signal } : {}),
    });
    lastLog = read.stdout;

    const token = TOKEN_PATTERN.exec(lastLog)?.[1];
    if (token) {
      const pid = await readPid(transport, pidFile, signal);
      if (pid === undefined) {
        throw new RemoteError(
          'EXEC_FAILED',
          `主机 ${transport.hostAlias} 上的 dsh 已输出访问地址但未写入 pid 文件（${pidFile}）`,
          { hostAlias: transport.hostAlias },
        );
      }
      return { pid, port, token };
    }

    // 进程已退出而日志里没有令牌 ⇒ 启动失败，立刻带上日志尾部报错，
    // 不必等到超时——用户最想看到的是 dsh 自己的错误输出
    const pid = await readPid(transport, pidFile, signal);
    if (pid !== undefined && !(await isProcessAlive(transport, pid, signal))) {
      throw new RemoteError(
        'EXEC_FAILED',
        `主机 ${transport.hostAlias} 上的 dsh 启动后立即退出。日志尾部：\n${tail(lastLog)}`,
        { hostAlias: transport.hostAlias },
      );
    }
  }

  throw new RemoteError(
    'EXEC_FAILED',
    `等待主机 ${transport.hostAlias} 上的 dsh 就绪超时（${STARTUP_TIMEOUT_MS / 1000}s）。`
      + `日志尾部：\n${tail(lastLog)}`,
    { hostAlias: transport.hostAlias },
  );
}

/**
 * 探测既有会话是否仍然可用。
 *
 * 判据是「pid 存活 + 端口在监听 + 日志里有令牌」三者齐全。缺少免认证 HTTP
 * 探活端点，这是目前能做到的最强判断（见文件头第 4 点）。
 *
 * @param transport - 已连接的传输
 * @param paths - 远端路径集合
 * @param sessionId - 会话 id
 * @param signal - 取消信号
 * @returns 可用则返回进程信息，否则 undefined
 */
export async function probeExistingSession(
  transport: RemoteTransport,
  paths: RemotePaths,
  sessionId: string,
  signal?: AbortSignal,
): Promise<RemoteProcessInfo | undefined> {
  const pidFile = paths.sessionPidFile(sessionId);
  const logFile = paths.sessionLogFile(sessionId);

  const pid = await readPid(transport, pidFile, signal);
  if (pid === undefined) return undefined;
  if (!(await isProcessAlive(transport, pid, signal))) return undefined;

  const read = await transport.exec(`cat ${quote(logFile)} 2>/dev/null || true`, {
    allowNonZeroExit: true,
    ...(signal ? { signal } : {}),
  });
  const match = /http:\/\/127\.0\.0\.1:(\d+)\/\?token=([A-Za-z0-9_-]{43})\b/.exec(read.stdout);
  if (!match) return undefined;

  const port = Number.parseInt(match[1]!, 10);
  if (!(await isRemotePortListening(transport, port, signal))) return undefined;

  return { pid, port, token: match[2]! };
}

/**
 * 停止远端 dsh。
 *
 * 优先用 pid 文件；pid 文件缺失或已失效时按监听端口定位。
 * **绝不使用 `pkill -f`**——见文件头第 3 点。
 *
 * @param transport - 已连接的传输
 * @param paths - 远端路径集合
 * @param options - 选项
 * @returns 是否确实停止了一个进程
 */
export async function stopRemoteDsh(
  transport: RemoteTransport,
  paths: RemotePaths,
  options: {
    /** 会话 id */
    sessionId: string;
    /** 已知的监听端口，用于 pid 定位失败时兜底 */
    port?: number;
    /** 取消信号 */
    signal?: AbortSignal;
  },
): Promise<boolean> {
  const { sessionId, signal } = options;
  const pidFile = paths.sessionPidFile(sessionId);

  let pid = await readPid(transport, pidFile, signal);
  if (pid !== undefined && !(await isProcessAlive(transport, pid, signal))) {
    pid = undefined;
  }

  // pid 不可用时按端口找——比 pkill -f 安全，因为端口唯一指向监听者
  if (pid === undefined && options.port !== undefined) {
    pid = await findPidByPort(transport, options.port, signal);
  }

  if (pid === undefined) {
    // 清掉陈旧的 pid 文件，避免下次探测误判
    await transport.exec(`rm -f ${quote(pidFile)}`, {
      allowNonZeroExit: true,
      ...(signal ? { signal } : {}),
    });
    return false;
  }

  // 先 TERM 给 dsh 机会走自己的清理流程
  await transport.exec(`kill ${pid} 2>/dev/null || true`, {
    allowNonZeroExit: true,
    ...(signal ? { signal } : {}),
  });

  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await delay(POLL_INTERVAL_MS, signal);
    if (!(await isProcessAlive(transport, pid, signal))) {
      await transport.exec(`rm -f ${quote(pidFile)}`, {
        allowNonZeroExit: true,
        ...(signal ? { signal } : {}),
      });
      return true;
    }
  }

  // 优雅停止超时，升级为 KILL
  await transport.exec(`kill -9 ${pid} 2>/dev/null || true`, {
    allowNonZeroExit: true,
    ...(signal ? { signal } : {}),
  });
  await transport.exec(`rm -f ${quote(pidFile)}`, {
    allowNonZeroExit: true,
    ...(signal ? { signal } : {}),
  });
  return true;
}

/**
 * 读取 pid 文件。
 *
 * @param transport - 已连接的传输
 * @param pidFile - pid 文件绝对路径
 * @param signal - 取消信号
 * @returns pid；文件缺失或内容非法时 undefined
 */
async function readPid(
  transport: RemoteTransport,
  pidFile: string,
  signal?: AbortSignal,
): Promise<number | undefined> {
  const result = await transport.exec(`cat ${quote(pidFile)} 2>/dev/null || true`, {
    allowNonZeroExit: true,
    ...(signal ? { signal } : {}),
  });
  const pid = Number.parseInt(result.stdout.trim(), 10);
  return Number.isFinite(pid) && pid > 0 ? pid : undefined;
}

/**
 * 判断远端某 pid 是否存活。
 *
 * 用 `kill -0`：不发送真实信号，只做权限与存在性检查。
 *
 * @param transport - 已连接的传输
 * @param pid - 进程号
 * @param signal - 取消信号
 * @returns 是否存活
 */
async function isProcessAlive(
  transport: RemoteTransport,
  pid: number,
  signal?: AbortSignal,
): Promise<boolean> {
  const result = await transport.exec(`kill -0 ${pid} 2>/dev/null && echo ALIVE || true`, {
    allowNonZeroExit: true,
    ...(signal ? { signal } : {}),
  });
  return result.stdout.includes('ALIVE');
}

/**
 * 按监听端口查进程号。
 *
 * @param transport - 已连接的传输
 * @param port - 监听端口
 * @param signal - 取消信号
 * @returns pid；查不到时 undefined
 */
async function findPidByPort(
  transport: RemoteTransport,
  port: number,
  signal?: AbortSignal,
): Promise<number | undefined> {
  const script = [
    'if command -v ss >/dev/null 2>&1; then',
    `  ss -ltnpH 2>/dev/null | grep ":${port} " | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2`,
    'elif command -v lsof >/dev/null 2>&1; then',
    `  lsof -tiTCP:${port} -sTCP:LISTEN 2>/dev/null | head -1`,
    'fi',
  ].join('\n');

  const result = await transport.exec(script, {
    allowNonZeroExit: true,
    ...(signal ? { signal } : {}),
  });
  const pid = Number.parseInt(result.stdout.trim(), 10);
  return Number.isFinite(pid) && pid > 0 ? pid : undefined;
}

/**
 * 可取消的延时。
 *
 * @param ms - 毫秒
 * @param signal - 取消信号
 */
async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    timer.unref();
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new RemoteError('ABORTED', '等待被取消'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 取文本尾部若干行，用于错误消息。
 *
 * @param text - 完整文本
 * @param lines - 保留行数
 * @returns 尾部文本
 */
function tail(text: string, lines = 12): string {
  const all = text.trimEnd().split('\n');
  return all.slice(-lines).join('\n') || '(日志为空)';
}

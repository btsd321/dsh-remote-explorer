/**
 * @file 远端平台探测与命令构造共享工具
 * @description SSH 与 WSL 传输共用的平台映射表、uname 输出解析、
 *              环境变量/PATH 前缀拼接，以及错误消息截断常量。
 *              从 ssh-transport.ts 和 wsl-transport.ts 中提取，消除逐字重复。
 */

import { RemoteError } from '../util/errors.js';
import { quote } from '../util/shell-quote.js';
import type { RemoteArch, RemoteOs, RemotePlatform } from './types.js';

/**
 * `uname -m` 输出到 Node 架构命名的映射。
 *
 * 用 Record 收口，新增架构时编译器会提示补齐分支。
 */
export const ARCH_MAP: Record<string, RemoteArch> = {
  aarch64: 'arm64',
  arm64: 'arm64',
  x86_64: 'x64',
  amd64: 'x64',
  armv7l: 'armv7l',
  armv7: 'armv7l',
};

/** `uname -s` 输出到远端 OS 的映射 */
export const OS_MAP: Record<string, RemoteOs> = {
  Linux: 'linux',
  Darwin: 'darwin',
};

/** 错误消息中命令预览的最大字符数 */
export const COMMAND_PREVIEW_LEN = 120;

/** 错误消息中 stderr 预览的最大字符数 */
export const STDERR_PREVIEW_LEN = 400;

/**
 * 解析 `uname -s && uname -m` 的输出，返回归一化的平台信息。
 *
 * @param stdout - uname 命令的标准输出（两行：OS 与架构）
 * @param label - 定位标签（如「主机 myhost」或「WSL Ubuntu-22.04」），用于错误消息
 * @returns 归一化的平台信息
 * @throws RemoteError('PLATFORM_UNSUPPORTED') 系统或架构不受支持
 */
export function parsePlatformOutput(stdout: string, label: string): RemotePlatform {
  const [rawOs = '', rawArch = ''] = stdout.trim().split('\n').map(line => line.trim());
  const os = OS_MAP[rawOs];
  const arch = ARCH_MAP[rawArch];
  if (!os) {
    throw new RemoteError(
      'PLATFORM_UNSUPPORTED',
      `${label} 的系统 ${rawOs || '(空)'} 不受支持；远端只支持 Linux 与 macOS`,
    );
  }
  if (!arch) {
    throw new RemoteError(
      'PLATFORM_UNSUPPORTED',
      `${label} 的架构 ${rawArch || '(空)'} 不受支持；`
        + `支持 ${Object.keys(ARCH_MAP).join('、')}`,
    );
  }
  return { os, arch, rawOs, rawArch };
}

/**
 * 给命令加上 `env K=V` 前缀，处理 PATH 前缀和环境变量注入。
 *
 * 不用 ssh2 的 `env` 选项：那要求服务端 `AcceptEnv` 放行，
 * 而多数 sshd 默认只允许 `LANG`/`LC_*`，静默丢弃其余变量。
 *
 * @param command - 原始命令
 * @param env - 环境变量；值会被完整转义，不做变量展开
 * @param pathPrefix - 前置到 PATH 的目录
 * @returns 带前缀的命令
 */
export function buildCommandWithEnv(
  command: string,
  env?: Record<string, string>,
  pathPrefix?: string,
): string {
  const assignments: string[] = [];

  if (pathPrefix !== undefined && pathPrefix.length > 0) {
    // `"$PATH"` 必须留在引号外由外层 shell 展开——把它塞进 quote() 会
    // 变成字面量，远端 PATH 就只剩这一个目录，连 rm/mkdir 都找不到。
    // 目录本身仍然转义，防注入。
    assignments.push(`PATH=${quote(pathPrefix)}:"$PATH"`);
  }
  for (const [key, value] of Object.entries(env ?? {})) {
    assignments.push(`${key}=${quote(value)}`);
  }

  if (assignments.length === 0) return command;
  return `env ${assignments.join(' ')} ${command}`;
}

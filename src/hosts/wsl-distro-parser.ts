/**
 * @file WSL 发行版发现与解析
 * @description 通过 `wsl.exe --list --verbose` 枚举本机已安装的 WSL 发行版，
 *              解析固定宽度表格输出并过滤非用户发行版（Docker/Rancher 等）。
 *              为 {@link WslTransport} 提供发行版列表与可用性检测。
 *
 * 设计参考：Windows Terminal 的 WslDistroGenerator.cpp 用注册表枚举发行版，
 * 但注册表路径不稳定且需要额外权限；`wsl --list --verbose` 是官方 CLI，
 * 输出格式稳定且无需提权，更适合本工具的使用场景。
 *
 * 编码注意：wsl.exe 在某些 Windows 版本上输出 UTF-16LE 而非 UTF-8，
 * 必须用 Buffer 解码而非直接指定 encoding。
 *
 * 分层约束：本文件属基础层，不感知传输实现与会话状态。
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';

/** WSL 发行版运行状态 */
export type WslDistroState = 'Running' | 'Stopped' | 'Installing' | 'Converting';

/** WSL 发行版信息 */
export interface WslDistroInfo {
  /** 发行版名称（如 Ubuntu-22.04） */
  name: string;
  /** 运行状态 */
  state: WslDistroState;
  /** WSL 版本（1 或 2） */
  version: 1 | 2;
  /** 是否为默认发行版 */
  isDefault: boolean;
}

/** wsl.exe 完整路径（防 PATH 劫持，与 Windows Terminal 做法一致） */
const WSL_EXE_PATH = 'C:\\Windows\\System32\\wsl.exe';

/** 需要过滤的非用户发行版前缀（Docker/Rancher 的工具发行版） */
const FILTERED_DISTRO_PREFIXES = ['docker-desktop', 'rancher-desktop'] as const;

/** wsl --list --verbose 输出的行解析正则 */
const DISTRO_LINE_RE = /^\s*(\*?)\s+(\S+)\s+(\S+)\s+(\d+)\s*$/;

/** 合法的运行状态集合 */
const VALID_STATES: ReadonlySet<string> = new Set([
  'Running',
  'Stopped',
  'Installing',
  'Converting',
]);

/** 模块级缓存 */
let cachedDistros: WslDistroInfo[] | undefined;

/**
 * 获取 wsl.exe 的完整路径。
 *
 * 使用绝对路径防止 PATH 劫持攻击——恶意程序可能在 PATH 前面放一个同名可执行文件。
 * Windows Terminal 采用相同策略（WslDistroGenerator.cpp 的 GetSystemDirectoryW）。
 *
 * @returns wsl.exe 的完整路径
 */
export function getWslExePath(): string {
  return WSL_EXE_PATH;
}

/**
 * 检查 WSL 是否可用（wsl.exe 存在且能正常响应）。
 *
 * @returns WSL 可用时为 true
 */
export async function isWslAvailable(): Promise<boolean> {
  if (!existsSync(WSL_EXE_PATH)) return false;
  try {
    await runWslExe(['--status']);
    return true;
  } catch {
    return false;
  }
}

/**
 * 列出所有已安装的 WSL 发行版（过滤非用户发行版）。
 *
 * 结果带模块级缓存；发行版安装/卸载后需调 {@link refreshWslCache} 失效。
 * WSL 未安装或不可用时返回空数组（graceful fallback），不抛错。
 *
 * @returns 发行版信息列表
 */
export async function listWslDistros(): Promise<WslDistroInfo[]> {
  if (cachedDistros !== undefined) return cachedDistros;

  // WSL 不可用时静默返回空列表——调用方据此判断是否展示 WSL 选项
  if (!existsSync(WSL_EXE_PATH)) {
    cachedDistros = [];
    return cachedDistros;
  }

  try {
    const output = await runWslExe(['--list', '--verbose']);
    cachedDistros = parseDistroList(output);
    return cachedDistros;
  } catch {
    // wsl.exe 报错（WSL 未启用、服务未启动等）视为无发行版
    cachedDistros = [];
    return cachedDistros;
  }
}

/** 刷新 WSL 发行版缓存（安装/卸载发行版后调用） */
export function refreshWslCache(): void {
  cachedDistros = undefined;
}

/**
 * 执行 wsl.exe 并返回 stdout 文本。
 *
 * wsl.exe 在某些 Windows 版本上输出 UTF-16LE 而非 UTF-8。
 * 这里用 `{ encoding: 'buffer' }` 拿到原始 Buffer，再尝试两种编码解码。
 *
 * @param args - wsl.exe 参数
 * @returns 解码后的 stdout 文本
 */
async function runWslExe(args: readonly string[]): Promise<string> {
  const result = await new Promise<{ stdout: Buffer; stderr: Buffer }>((resolve, reject) => {
    execFile(WSL_EXE_PATH, [...args], { encoding: 'buffer', timeout: 10_000 }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout: stdout as unknown as Buffer, stderr: stderr as unknown as Buffer });
    });
  });
  return decodeWslOutput(result.stdout);
}

/**
 * 解码 wsl.exe 的输出 Buffer。
 *
 * 优先尝试 UTF-16LE（wsl.exe 在多数 Windows 版本上的实际编码），
 * 若解码结果含大量替换字符则回退到 UTF-8。
 *
 * @param buffer - 原始输出 Buffer
 * @returns 解码后的字符串
 */
function decodeWslOutput(buffer: Buffer): string {
  if (buffer.length === 0) return '';

  // 检查是否有 UTF-16LE BOM
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.toString('utf16le').replace(/^\uFEFF/, '');
  }

  // 尝试 UTF-16LE 解码：如果输出包含大量 NUL 字节交替出现，大概率是 UTF-16LE
  const hasNullBytes = countNullBytes(buffer);
  if (hasNullBytes > buffer.length / 4) {
    return buffer.toString('utf16le');
  }

  // 回退到 UTF-8
  return buffer.toString('utf8');
}

/**
 * 统计 Buffer 中 NUL 字节的数量。
 *
 * UTF-16LE 编码的 ASCII 文本会在每个字符后跟一个 NUL 字节，
 * 利用这个特征区分 UTF-16LE 和 UTF-8。
 *
 * @param buffer - 待检查的 Buffer
 * @returns NUL 字节数
 */
function countNullBytes(buffer: Buffer): number {
  let count = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    if (buffer[i] === 0) count += 1;
  }
  return count;
}

/**
 * 解析 `wsl --list --verbose` 的输出为发行版列表。
 *
 * 输出格式示例（固定宽度表格）：
 * ```
 *   NAME            STATE           VERSION
 * * Ubuntu-22.04    Running         2
 *   Debian          Stopped         2
 * ```
 *
 * @param output - wsl.exe 的 stdout 文本
 * @returns 过滤后的发行版列表
 */
function parseDistroList(output: string): WslDistroInfo[] {
  const lines = output.split(/\r?\n/);
  const distros: WslDistroInfo[] = [];

  for (const line of lines) {
    const match = DISTRO_LINE_RE.exec(line);
    if (match === null) continue;

    const defaultMarker = match[1];
    const name = match[2];
    const stateText = match[3];
    const versionText = match[4];

    // 跳过表头行（NAME/STATE/VERSION 不匹配数字版本）
    if (name === undefined || versionText === undefined) continue;

    const version = Number.parseInt(versionText, 10);
    if (version !== 1 && version !== 2) continue;

    // 校验状态合法性
    if (!VALID_STATES.has(stateText ?? '')) continue;

    // 过滤 Docker/Rancher 等非用户发行版
    const lowerName = name.toLowerCase();
    if (FILTERED_DISTRO_PREFIXES.some(prefix => lowerName.startsWith(prefix))) continue;

    distros.push({
      name,
      state: stateText as WslDistroState,
      version: version as 1 | 2,
      isDefault: defaultMarker === '*',
    });
  }

  return distros;
}

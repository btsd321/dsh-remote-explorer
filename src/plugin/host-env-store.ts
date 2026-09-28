/**
 * @file 主机环境变量持久化（per-host 齿轮配置）
 * @description 面板「每个主机配置环境变量」的本机存储：按 hostAlias 索引的
 *              键值对，连接时由 supervisor 读出并经 openSession 的 extraEnv
 *              注入远端 dsh 进程环境（典型用途：无公网主机的 https_proxy
 *              指向 SSH 反向隧道端口）。
 *
 * 落盘位置 `~/.dsh/remote-host-env.json`（与 remote-sessions.json 同目录），
 * 结构 `{ "version": 1, "hosts": { "<hostAlias>": { "env": { ... } } } }`。
 *
 * 安全约束：
 * - **值可能敏感**（代理认证信息、token）：文件权限 0o600（Windows 上
 *   mode 位无效，靠用户目录 ACL 兜底）；日志与错误消息只打键名不打值
 * - **键名是命令注入面**：键名最终会经 remote-process.ts 的 envAssignments
 *   直接插值进远端启动命令，读写两侧都过校验（写入整组拒绝、读取逐键过滤
 *   ——后者防手工编辑文件绕过写入校验）
 * - 保留键黑名单（DSH_HOME/DSH_AGENTS_HOME/PATH）与 session 层同一集合
 *   （单一来源在 session/proxy-env.ts，本文件 import 而不自建）
 *
 * 与 session-registry 一样不引入锁：读写频率低（面板保存时写一次、连接时
 * 读一次），写失败只影响面板保存而不影响运行中的会话，锁的复杂度不值得。
 * 原子性仍保留——写临时文件再 rename，并发读者不会看到半个文件。
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { toErrorMessage } from '../util/errors.js';
import { createLogger } from '../util/logger.js';
import { RESERVED_REMOTE_ENV_KEYS, isSafeEnvKey } from '../session/proxy-env.js';

const log = createLogger('host-env-store');

/** 落盘文件名（目录默认 `~/.dsh`，与 remote-sessions.json 同目录） */
const HOST_ENV_FILE_NAME = 'remote-host-env.json';

/** 默认落盘目录 */
const DEFAULT_BASE_DIR = join(homedir(), '.dsh');

/** 值中不允许出现的控制字符（C0 控制码与 DEL）——防终端污染与注入 */
const CONTROL_CHARS_PATTERN = /[\x00-\x1f\x7f]/;

/** 单个主机的配置条目 */
interface HostEnvEntry {
  /** 环境变量键值对 */
  env: Record<string, string>;
}

/** 落盘文件结构 */
interface HostEnvFile {
  /** 格式版本，便于日后迁移 */
  version: 1;
  /** 按主机别名索引的条目 */
  hosts: Record<string, HostEnvEntry>;
}

/**
 * 读出某主机配置的环境变量。
 *
 * 容错读取：文件缺失、JSON 损坏或形状不对时回落空对象（读不到配置不阻断
 * 连接）。读出的键逐个过校验，坏键跳过并告警（键名可打、值不打）——文件
 * 可能被手工编辑，读取侧过滤是注入面的第二道防线。
 *
 * @param hostAlias - 主机别名（ssh config 别名或 user@host 语法；WSL 形如
 *   `wsl:<distro>`。本身是索引键，非空即可，不做格式校验）
 * @param baseDir - 落盘目录（默认 `~/.dsh`；测试传临时目录）
 * @returns 该主机的环境变量；无配置或读取失败时空对象
 */
export function readHostEnv(hostAlias: string, baseDir?: string): Record<string, string> {
  const file = readHostEnvFile(baseDir ?? DEFAULT_BASE_DIR);
  const entry = file.hosts[hostAlias];
  if (entry === undefined) return {};
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(entry.env)) {
    // 值来自落盘 JSON，运行时可能是任意 JSON 值（类型注解拦不住手工编辑）
    if (envEntryError(key, value) !== undefined) {
      // 键名不是秘密可以打；值可能敏感，不打
      log.warn(`主机环境变量文件中 ${hostAlias} 的键 '${key}' 非法，已跳过`);
      continue;
    }
    env[key] = value;
  }
  return env;
}

/**
 * 保存某主机配置的环境变量（整组替换该主机的条目，其他主机不动）。
 *
 * 写入前整组校验——调用方（路由层）通常已先校验过，这里再拦一次是给
 * 未来绕过路由直接调用的调用方兜底。env 为空对象时删除该主机的条目
 * （面板把所有行删光再保存 = 清除配置，不留空壳条目）。
 *
 * 原子写：先写同目录临时文件再 rename（与 session-registry 的
 * writeRegistryAtomically 同款），文件权限 0o600。
 *
 * @param hostAlias - 主机别名（非空即可）
 * @param env - 环境变量键值对；空对象表示清除该主机配置
 * @param baseDir - 落盘目录（默认 `~/.dsh`；测试传临时目录）
 * @throws Error 校验失败（中文消息含具体键名）或写入失败
 */
export function writeHostEnv(hostAlias: string, env: Record<string, string>, baseDir?: string): void {
  const error = validateHostEnv(env);
  if (error !== undefined) {
    // 双保险：路由层已先行校验并返回 400；直接调用方绕过时在此拦截
    throw new Error(error);
  }
  const dir = baseDir ?? DEFAULT_BASE_DIR;
  const file = readHostEnvFile(dir);
  const hosts: Record<string, HostEnvEntry> = { ...file.hosts };
  if (Object.keys(env).length === 0) {
    delete hosts[hostAlias];
  } else {
    hosts[hostAlias] = { env };
  }
  writeHostEnvFile({ version: 1, hosts }, dir);
}

/**
 * 校验一组主机环境变量（纯函数，路由层 400 判定用）。
 *
 * 规则：键名匹配 `/^[A-Za-z_][A-Za-z0-9_]*$/` 且不在保留键黑名单
 * （DSH_HOME/DSH_AGENTS_HOME/PATH）；值必须是 string 且不含控制字符。
 *
 * @param env - 待校验的键值对（值可能来自外部 JSON，类型注解不代表运行时形状）
 * @returns 第一条错误的中文消息（含具体键名）；全部合法返回 undefined
 */
export function validateHostEnv(env: Record<string, string>): string | undefined {
  for (const [key, value] of Object.entries(env)) {
    const error = envEntryError(key, value);
    if (error !== undefined) return error;
  }
  return undefined;
}

/**
 * 校验单个键值对。
 *
 * @param key - 环境变量键名
 * @param value - 环境变量值（unknown：手工编辑过的 JSON 里可能是任意类型）
 * @returns 错误消息；合法返回 undefined
 */
function envEntryError(key: string, value: unknown): string | undefined {
  if (!isSafeEnvKey(key)) {
    return `环境变量名 '${key}' 非法（只允许字母、数字、下划线，且不以数字开头；`
      + `DSH_HOME/DSH_AGENTS_HOME/PATH 是保留键，不允许配置）`;
  }
  if (typeof value !== 'string') {
    return `环境变量 '${key}' 的值必须是字符串`;
  }
  if (CONTROL_CHARS_PATTERN.test(value)) {
    return `环境变量 '${key}' 的值含控制字符`;
  }
  return undefined;
}

/**
 * 读取整个落盘文件（原始形状，不做键过滤）。
 *
 * @param dir - 落盘目录
 * @returns 文件内容；缺失、损坏或形状不对时空结构
 */
function readHostEnvFile(dir: string): HostEnvFile {
  const filePath = join(dir, HOST_ENV_FILE_NAME);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
  } catch (error) {
    // 文件缺失（ENOENT）与 JSON 损坏都回落空配置：读不到配置只影响注入面，
    // 不应阻断连接；损坏时告警留诊断线索
    log.warn(`读取主机环境变量文件失败（回落空配置）：${toErrorMessage(error)}`);
    return { version: 1, hosts: {} };
  }
  const hosts = extractHosts(parsed);
  if (hosts === undefined) {
    log.warn('主机环境变量文件形状不符（hosts 结构缺失），回落空配置');
    return { version: 1, hosts: {} };
  }
  return { version: 1, hosts };
}

/**
 * 从解析结果中提取合法形状的 hosts 映射。
 *
 * 只做结构收窄（对象/条目/env 三层都是 plain object），键值语义校验
 * 留给读取/写入路径——这里坏了就整组丢弃（手工编辑产物，无从修复）。
 *
 * @param parsed - JSON.parse 的结果
 * @returns 合法形状的 hosts；形状不对时 undefined
 */
function extractHosts(parsed: unknown): Record<string, HostEnvEntry> | undefined {
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const rawHosts = (parsed as { hosts?: unknown }).hosts;
  if (typeof rawHosts !== 'object' || rawHosts === null || Array.isArray(rawHosts)) {
    return undefined;
  }
  const hosts: Record<string, HostEnvEntry> = {};
  for (const [alias, entry] of Object.entries(rawHosts)) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const rawEnv = (entry as { env?: unknown }).env;
    if (typeof rawEnv !== 'object' || rawEnv === null || Array.isArray(rawEnv)) continue;
    hosts[alias] = { env: rawEnv as Record<string, string> };
  }
  return hosts;
}

/**
 * 原子写入整个文件。
 *
 * 先写同目录临时文件再 rename（rename 在同一文件系统内原子），并发读者
 * 不会看到半个文件。临时文件名带本机 pid，避免并发写互相覆盖。权限
 * 0o600：值可能含代理认证信息（Windows 上 mode 位无效，靠用户目录 ACL）。
 *
 * @param file - 待写入内容
 * @param dir - 落盘目录
 * @throws Error 写入失败（中文消息含路径）
 */
function writeHostEnvFile(file: HostEnvFile, dir: string): void {
  mkdirSync(dir, { recursive: true });
  const finalPath = join(dir, HOST_ENV_FILE_NAME);
  const tmpPath = `${finalPath}.${process.pid}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(file, undefined, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    renameSync(tmpPath, finalPath);
  } catch (error) {
    // rename 失败要清掉临时文件，否则会在目录里累积
    try { rmSync(tmpPath, { force: true }); } catch { /* 清理失败无妨 */ }
    throw new Error(`写入主机环境变量文件失败（${finalPath}）：${toErrorMessage(error)}`);
  }
}

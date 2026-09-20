/**
 * @file SSH config 解析器
 * @description 主机配置的**唯一**来源：读取并解析 ~/.ssh/config，用 ssh-config 库的
 *              compute() 合并 `Host *` 通配默认值，并递归解析 ProxyJump 跳板机链。
 *              本插件不持久化主机档案——用户通过编辑 ssh config 管理主机。
 *
 * compute() 自动处理：
 * - `Host *` 通配符的全局默认值合并
 * - `Match exec` 条件匹配
 * - 大小写不敏感（`{ ignoreCase: true }` 后键名全小写）
 * - 多值字段（IdentityFile 可出现多次）
 *
 * 分层约束：本文件属基础层，不感知连接状态与传输实现。
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import SSHConfig from 'ssh-config';
import { RemoteError } from '../util/errors.js';

/**
 * compute() 返回的合并结果。
 *
 * ssh-config 的类型声明把它写成宽松索引签名，这里收窄到我们实际读取的字段，
 * 避免 `any` 顺着调用链扩散（规范点名的技术债，新代码不照抄旧模式）。
 */
interface ComputedHostOptions {
  /** HostName */
  hostname?: string;
  /** Host（别名本身，compute 在无 HostName 时可能给出） */
  host?: string;
  /** User */
  user?: string;
  /** Port（config 里是字符串） */
  port?: string;
  /** IdentityFile，可能是单值或多值 */
  identityfile?: string | string[];
  /** ProxyJump，逗号分隔的别名列表 */
  proxyjump?: string;
  /** 其余选项一律不解释，仅透传供诊断 */
  [key: string]: string | string[] | undefined;
}

/** SSH config 条目（解析后的段） */
interface ConfigSection {
  /** 条目类型：1 表示指令（Host/Match 等） */
  type?: number;
  /** 指令名，如 'Host' */
  param?: string;
  /** 指令值，如别名 */
  value?: string;
}

/** 解析后的 config 文档，附带 compute 方法 */
interface ParsedConfig extends Array<ConfigSection> {
  /**
   * 计算某别名的合并配置。
   * @param alias - Host 别名
   * @param options - 解析选项
   */
  compute(alias: string, options: { ignoreCase: boolean }): ComputedHostOptions;
}

/** SSH config 中一个 Host 的基本信息（列表展示用） */
export interface SshHostSummary {
  /** Host 别名（如 "OrangePI"） */
  alias: string;
  /** 主机地址（HostName 值，没有则用别名） */
  hostName: string;
  /** 用户名，未配置时为空串 */
  user: string;
  /** 端口，未配置时为 22 */
  port: number;
  /** 是否含跳板机 */
  hasProxyJump: boolean;
  /** 跳板机别名列表原文（如有） */
  proxyJump?: string;
}

/** 解析后的完整主机配置（单台主机） */
export interface ResolvedHost {
  /** 主机地址（HostName） */
  host: string;
  /** SSH 端口 */
  port: number;
  /** 登录用户名 */
  username: string;
  /** 私钥文件路径（已展开 `~`，取第一个 IdentityFile） */
  identityFile?: string;
  /** ProxyJump 原始值（逗号分隔的别名列表） */
  proxyJump?: string;
}

/** 解析结果（含递归解析的跳板机链） */
export interface ResolvedHostWithJump {
  /** 目标主机配置 */
  target: ResolvedHost;
  /** 跳板机链（按连接顺序，空数组表示直连） */
  jumpHosts: ResolvedHost[];
}

/** 默认 SSH config 文件路径 */
const DEFAULT_CONFIG_PATH = join(homedir(), '.ssh', 'config');

/** ssh-config 里表示「指令」的 type 值 */
const SECTION_TYPE_DIRECTIVE = 1;

/** 默认 SSH 端口 */
const DEFAULT_SSH_PORT = 22;

/** 缓存的解析结果 */
let cachedConfig: ParsedConfig | undefined;
/** 当前使用的 config 文件路径 */
let cachedPath = DEFAULT_CONFIG_PATH;

/**
 * 设置 SSH config 文件路径并失效缓存。
 *
 * @param path - SSH config 文件路径
 */
export function setConfigPath(path: string): void {
  cachedPath = path;
  cachedConfig = undefined;
}

/** 刷新缓存（config 文件变更后必须调用） */
export function refreshConfig(): void {
  cachedConfig = undefined;
}

/**
 * 读取并解析 SSH config。
 *
 * @returns 解析后的配置文档；文件不存在时返回空文档
 */
function loadConfig(): ParsedConfig {
  if (cachedConfig) return cachedConfig;
  const text = existsSync(cachedPath) ? readFileSync(cachedPath, 'utf8') : '';
  cachedConfig = SSHConfig.parse(text) as unknown as ParsedConfig;
  return cachedConfig;
}

/**
 * 展开 `~/` 为绝对路径。
 *
 * @param path - 可能含 `~` 的路径
 * @returns 绝对路径
 */
function expandTilde(path: string): string {
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  if (path === '~') return homedir();
  return path;
}

/**
 * 从 compute() 结果提取 ResolvedHost。
 *
 * @param computed - compute() 返回的合并配置
 * @returns 解析后的主机配置
 */
function toResolvedHost(computed: ComputedHostOptions): ResolvedHost {
  const identityFile = computed.identityfile;
  const firstIdentity = Array.isArray(identityFile) ? identityFile[0] : identityFile;
  return {
    host: computed.hostname ?? '',
    port: computed.port ? Number.parseInt(computed.port, 10) : DEFAULT_SSH_PORT,
    username: computed.user ?? '',
    ...(firstIdentity ? { identityFile: expandTilde(firstIdentity) } : {}),
    ...(computed.proxyjump ? { proxyJump: computed.proxyjump } : {}),
  };
}

/**
 * 列出 SSH config 中的所有 Host（排除 `*` 通配符与 Match 块）。
 *
 * @returns Host 摘要列表，按 config 中出现顺序
 */
export function listHosts(): SshHostSummary[] {
  const config = loadConfig();
  const result: SshHostSummary[] = [];
  for (const section of config) {
    if (section.type !== SECTION_TYPE_DIRECTIVE || section.param !== 'Host') continue;
    const alias = section.value;
    if (!alias || alias === '*') continue;
    const computed = config.compute(alias, { ignoreCase: true });
    result.push({
      alias,
      hostName: computed.hostname ?? alias,
      user: computed.user ?? '',
      port: computed.port ? Number.parseInt(computed.port, 10) : DEFAULT_SSH_PORT,
      hasProxyJump: computed.proxyjump !== undefined,
      ...(computed.proxyjump ? { proxyJump: computed.proxyjump } : {}),
    });
  }
  return result;
}

/**
 * 解析 Host 别名获取完整连接配置（含递归解析 ProxyJump 跳板机链）。
 *
 * ProxyJump 格式："jump1" 或 "jump1,jump2"（多级跳板机，逗号分隔）。
 * 每个跳板机别名也会被递归解析（若其自身也配了 ProxyJump）。
 *
 * @param alias - SSH config 中的 Host 别名
 * @returns 含跳板机链的完整配置
 * @throws RemoteError('HOST_NOT_FOUND') config 中没有该别名的可用配置
 */
export function resolveHost(alias: string): ResolvedHostWithJump {
  const config = loadConfig();

  // 必须先确认别名真的被某个具体 Host 条目覆盖。
  // 不能只看 compute() 有没有返回 hostname——config 里通常有 `Host *` 块，
  // 它会让任意别名都得到一份（只含通配默认值的）结果，于是"别名不存在"
  // 会被误报成"缺少 User、IdentityFile"，把用户引向错误的排查方向。
  if (!hasMatchingHostEntry(config, alias)) {
    throw new RemoteError(
      'HOST_NOT_FOUND',
      `在 ${cachedPath} 中找不到主机别名 ${alias}；用 dsh-remote list 查看可用别名`,
      { hostAlias: alias },
    );
  }

  const computed = config.compute(alias, { ignoreCase: true });

  const target = toResolvedHost(computed);
  // HostName 未配置时用别名本身作为地址（与 ssh 行为一致）
  if (!target.host) target.host = alias;

  const jumpHosts: ResolvedHost[] = [];
  if (target.proxyJump) {
    const visited = new Set<string>([alias]);
    for (const jumpAlias of splitAliases(target.proxyJump)) {
      collectJumpHosts(jumpAlias, config, jumpHosts, visited);
    }
  }

  return { target, jumpHosts };
}

/**
 * 校验主机配置含连接所必需的字段。
 *
 * 认证只支持私钥文件路径引用，不接受明文密钥；这与仓库的凭据约束一致。
 *
 * @param resolved - 解析结果
 * @param alias - 主机别名（错误消息用）
 * @throws RemoteError('HOST_CONFIG_INVALID') 缺少 User 或 IdentityFile
 */
export function assertConnectable(resolved: ResolvedHostWithJump, alias: string): void {
  const missing: string[] = [];
  if (!resolved.target.username) missing.push('User');
  if (!resolved.target.identityFile) missing.push('IdentityFile');
  if (missing.length > 0) {
    throw new RemoteError(
      'HOST_CONFIG_INVALID',
      `主机 ${alias} 的 ssh config 缺少必要字段：${missing.join('、')}`
        + `（${cachedPath}）。本工具只支持私钥认证，请补上 IdentityFile`,
      { hostAlias: alias },
    );
  }
  for (const [index, jump] of resolved.jumpHosts.entries()) {
    if (!jump.identityFile) {
      throw new RemoteError(
        'HOST_CONFIG_INVALID',
        `主机 ${alias} 的跳板机 ${index + 1}（${jump.host}:${jump.port}）缺少 IdentityFile`,
        { hostAlias: alias },
      );
    }
  }
}

/**
 * 判断 config 中是否有具体的 Host 条目覆盖该别名。
 *
 * 排除 `*`——它是通配默认值块，对任意别名都匹配，不能作为"别名存在"的依据。
 * 其余条目本身也可能带通配（如 `Host dev-*`），所以按 ssh 的模式语义比对：
 * `*` 匹配任意多个字符，`?` 匹配单个字符。
 *
 * @param config - 已解析的 config 文档
 * @param alias - 待查别名
 * @returns 是否有条目匹配
 */
function hasMatchingHostEntry(config: ParsedConfig, alias: string): boolean {
  for (const section of config) {
    if (section.type !== SECTION_TYPE_DIRECTIVE || section.param !== 'Host') continue;
    const pattern = section.value;
    if (!pattern || pattern === '*') continue;
    // 一个 Host 行可以列多个模式，空格分隔
    for (const single of pattern.split(/\s+/).filter(Boolean)) {
      if (matchesHostPattern(single, alias)) return true;
    }
  }
  return false;
}

/**
 * 按 ssh 的 Host 模式语义比对别名。
 *
 * @param pattern - Host 模式，可含 `*` 与 `?`
 * @param alias - 待比对别名
 * @returns 是否匹配（大小写不敏感，与 ssh 一致）
 */
function matchesHostPattern(pattern: string, alias: string): boolean {
  if (!pattern.includes('*') && !pattern.includes('?')) {
    return pattern.toLowerCase() === alias.toLowerCase();
  }
  // 先转义正则元字符，再把 ssh 的通配符换成对应的正则片段
  const escaped = pattern.replaceAll(/[.+^${}()|[\]\\]/g, String.raw`\$&`);
  const regexSource = `^${escaped.replaceAll('*', '.*').replaceAll('?', '.')}$`;
  return new RegExp(regexSource, 'i').test(alias);
}

/**
 * 拆分逗号分隔的别名列表。
 *
 * @param value - ProxyJump 原始值
 * @returns 去空后的别名数组
 */
function splitAliases(value: string): string[] {
  return value.split(',').map(part => part.trim()).filter(Boolean);
}

/**
 * 递归收集跳板机：先收集其自身的上游跳板机，再追加自身。
 *
 * 结果顺序即连接顺序——最外层跳板机在最前。
 *
 * @param alias - 跳板机别名
 * @param config - 已解析的 config 文档
 * @param result - 收集结果（原地追加）
 * @param visited - 已访问别名，防止循环引用
 */
function collectJumpHosts(
  alias: string,
  config: ParsedConfig,
  result: ResolvedHost[],
  visited: Set<string>,
): void {
  if (visited.has(alias)) return;
  visited.add(alias);

  const computed = config.compute(alias, { ignoreCase: true });
  if (!computed.hostname && !computed.host) return;

  const host = toResolvedHost(computed);
  if (!host.host) host.host = alias;

  if (host.proxyJump) {
    for (const subAlias of splitAliases(host.proxyJump)) {
      collectJumpHosts(subAlias, config, result, visited);
    }
  }

  result.push(host);
}

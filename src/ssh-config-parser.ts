/**
 * @file SSH config 解析器
 * @description 读取并解析 ~/.ssh/config 文件，使用 ssh-config 库的 compute() 方法
 *              合并全局默认值和具体 Host 配置，递归解析 ProxyJump 跳板机链。
 *
 * 核心函数：
 * 1. listHosts() — 列出 SSH config 中的所有 Host 别名及其基本信息
 * 2. resolveHost(alias) — 用 compute() 解析 Host 别名获取完整配置（含递归解析 ProxyJump）
 *
 * ssh-config 库的 compute() 方法自动处理：
 * - Host * 通配符的全局默认值合并
 * - Match exec 条件匹配
 * - 大小写不敏感（{ ignoreCase: true }）
 * - 多值字段（IdentityFile 可以出现多次）
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import SSHConfig from 'ssh-config';

/** SSH config 中一个 Host 的基本信息（列表展示用） */
export interface SshHostSummary {
  /** Host 别名（如 "OrangePI"） */
  alias: string;
  /** 主机地址（HostName 值，没有则用别名） */
  hostName: string;
  /** 用户名 */
  user: string;
  /** 端口（默认 22） */
  port: number;
  /** 是否含跳板机 */
  hasProxyJump: boolean;
  /** 跳板机别名（如有） */
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
  /** 私钥文件路径（展开 ~，取第一个 IdentityFile） */
  identityFile?: string;
  /** ProxyJump 原始值（逗号分隔的别名列表） */
  proxyJump?: string;
  /** 所有 SSH 选项（compute() 的完整结果） */
  options: Record<string, any>;
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

/** 缓存的 SSH config 解析结果 */
let cachedConfig: any[] | undefined;
let cachedPath = DEFAULT_CONFIG_PATH;
/** 直接设置的 config 文本内容（优先于文件路径） */
let cachedContent: string | undefined;

/**
 * 设置 SSH config 文件路径（允许用户配置）
 * @param path - SSH config 文件路径
 */
export function setConfigPath(path: string): void {
  cachedPath = path;
  cachedContent = undefined;
  cachedConfig = undefined;
}

/**
 * 直接设置 SSH config 文本内容（浏览器上传文件时使用）
 * 优先于文件路径——设置后不再从文件读取
 * @param content - SSH config 文本内容
 */
export function setConfigContent(content: string): void {
  cachedContent = content;
  cachedConfig = undefined;
}

/**
 * 读取并解析 SSH config（优先使用直接设置的内容，其次从文件路径读取）
 * @returns SSHConfig 条目数组
 */
function loadConfig(): any[] {
  if (cachedConfig) return cachedConfig;
  let text: string;
  if (cachedContent !== undefined) {
    text = cachedContent;
  } else {
    if (!existsSync(cachedPath)) {
      cachedConfig = [];
      return cachedConfig;
    }
    text = readFileSync(cachedPath, 'utf8');
  }
  cachedConfig = SSHConfig.parse(text);
  return cachedConfig;
}

/** 刷新缓存（文件变更后调用） */
export function refreshConfig(): void {
  cachedConfig = undefined;
}

/**
 * 展开 ~/ 路径为绝对路径
 * @param path - 可能含 ~ 的路径
 * @returns 绝对路径
 */
function expandTilde(path: string): string {
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  if (path === '~') return homedir();
  return path;
}

/**
 * 从 compute() 结果提取 ResolvedHost
 * @param computed - ssh-config 的 compute() 返回值
 * @returns 解析后的主机配置
 */
function toResolvedHost(computed: Record<string, any>): ResolvedHost {
  // compute() 用 ignoreCase: true 后键名全小写
  const identityFile = computed.identityfile;
  const firstIdentity = Array.isArray(identityFile)
    ? identityFile[0]
    : identityFile;
  return {
    host: computed.hostname || '',
    port: computed.port ? parseInt(String(computed.port), 10) : 22,
    username: computed.user || '',
    identityFile: firstIdentity ? expandTilde(String(firstIdentity)) : undefined,
    proxyJump: computed.proxyjump ? String(computed.proxyjump) : undefined,
    options: computed,
  };
}

/**
 * 列出 SSH config 中的所有 Host（排除 * 通配符和 Match 块）
 * @returns Host 摘要列表
 */
export function listHosts(): SshHostSummary[] {
  const config = loadConfig();
  const result: SshHostSummary[] = [];
  for (const section of config) {
    if (section.type !== 1 || section.param !== 'Host') continue;
    if (section.value === '*') continue;
    // 用 compute() 获取合并后的配置（含全局默认值）
    const computed = (config as any).compute(section.value, { ignoreCase: true });
    result.push({
      alias: section.value,
      hostName: computed.hostname || section.value,
      user: computed.user || '',
      port: computed.port ? parseInt(String(computed.port), 10) : 22,
      hasProxyJump: !!computed.proxyjump,
      proxyJump: computed.proxyjump ? String(computed.proxyjump) : undefined,
    });
  }
  return result;
}

/**
 * 解析 Host 别名获取完整连接配置（含递归解析 ProxyJump 跳板机链）
 *
 * ProxyJump 格式："jump1" 或 "jump1,jump2"（多级跳板机，逗号分隔）
 * 每个跳板机别名也会被递归解析（如果它自身也有 ProxyJump）。
 *
 * @param alias - SSH config 中的 Host 别名
 * @returns 含跳板机链的完整配置
 */
export function resolveHost(alias: string): ResolvedHostWithJump | undefined {
  const config = loadConfig();
  // 用 compute() 获取合并后的配置（自动处理 Host * 默认值和 Match exec）
  const computed = (config as any).compute(alias, { ignoreCase: true });
  if (!computed.hostname && !computed.host) return undefined;

  const target = toResolvedHost(computed);
  // 如果 hostname 为空，用 alias 作为 host
  if (!target.host) target.host = alias;

  const jumpHosts: ResolvedHost[] = [];

  // 递归解析 ProxyJump
  if (target.proxyJump) {
    const jumpAliases = target.proxyJump.split(',').map((s: string) => s.trim()).filter(Boolean);
    for (const jumpAlias of jumpAliases) {
      collectJumpHosts(jumpAlias, config, jumpHosts, new Set());
    }
  }

  return { target, jumpHosts };
}

/**
 * 递归收集跳板机（先收集子跳板机，再添加自身）
 * 跳板机链顺序：最外层跳板机在最前面
 *
 * @param alias - 跳板机别名
 * @param config - SSH config 条目数组
 * @param result - 收集结果列表
 * @param visited - 已访问的别名（防止循环引用）
 */
function collectJumpHosts(
  alias: string,
  config: any[],
  result: ResolvedHost[],
  visited: Set<string>,
): void {
  if (visited.has(alias)) return;
  visited.add(alias);

  // 用 compute() 解析跳板机配置
  const computed = (config as any).compute(alias, { ignoreCase: true });
  if (!computed.hostname && !computed.host) return;

  const host = toResolvedHost(computed);
  if (!host.host) host.host = alias;

  // 如果跳板机自身也有 ProxyJump，先递归收集子跳板机
  if (host.proxyJump) {
    const subAliases = host.proxyJump.split(',').map((s: string) => s.trim()).filter(Boolean);
    for (const subAlias of subAliases) {
      collectJumpHosts(subAlias, config, result, visited);
    }
  }

  // 添加自身到跳板机链
  result.push(host);
}

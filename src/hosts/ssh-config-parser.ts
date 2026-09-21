/**
 * @file SSH config 解析器
 * @description 主机配置的**唯一**来源：读取并解析 ~/.ssh/config，用 ssh-config 库的
 *              compute() 合并 `Host *` 通配默认值，并递归解析 ProxyJump 跳板机链。
 *              本插件不持久化主机档案——用户通过编辑 ssh config 管理主机。
 *              不在 config 里的主机可用 user@host[:port] 直连语法（ad-hoc）。
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
import { isInteractiveTerminal } from '../util/password-prompt.js';

/** ssh-config 指令值的对象形态：多 token 指令（如 `Host a b`）的每个 token */
interface DirectiveValue {
  /** 值本体 */
  val: string;
  /** token 间的分隔符 */
  separator: string;
  /** 是否带引号 */
  quoted: boolean;
}

/** 指令值的运行时形态：字符串、字符串数组、DirectiveValue 或其数组 */
type DirectiveValueLike = string | string[] | DirectiveValue | DirectiveValue[];

/**
 * 把指令值归一成字符串数组。
 *
 * ssh-config 对单 token 指令给字符串，多 token（`Host a b`）给 DirectiveValue
 * 数组——同一语义有多种运行时形态，消费方统一从这里取规范化结果，不做
 * `value.split()` 这类只认字符串的调用（实测在多模式 Host 行上会炸）。
 *
 * @param value - ssh-config 解析出的指令值
 * @returns 去空后的字符串列表
 */
function directiveValues(value: DirectiveValueLike | undefined): string[] {
  if (value === undefined) return [];
  const list = Array.isArray(value) ? value : [value];
  const strings: string[] = [];
  for (const item of list) {
    const text = typeof item === 'string' ? item : item.val;
    if (typeof text === 'string' && text.length > 0) strings.push(text);
  }
  return strings;
}

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
  /** IdentityFile，可能是单值、多值或 DirectiveValue 形态 */
  identityfile?: DirectiveValueLike;
  /** ProxyJump，逗号分隔的别名列表 */
  proxyjump?: DirectiveValueLike;
  /** 其余选项一律不解释，仅透传供诊断 */
  [key: string]: DirectiveValueLike | undefined;
}

/** SSH config 条目（解析后的段） */
interface ConfigSection {
  /** 条目类型：1 表示指令（Host/Match 等） */
  type?: number;
  /** 指令名，如 'Host' */
  param?: string;
  /** 指令值；单 token 是字符串，多模式行（`Host a b`）是 DirectiveValue 数组 */
  value?: DirectiveValueLike;
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
  /** Host 别名（如 "myhost"） */
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
  const firstIdentity = directiveValues(computed.identityfile)[0];
  // ProxyJump 用逗号分隔多级跳板；DirectiveValue 形态还原成逗号串
  const proxyJump = directiveValues(computed.proxyjump).join(',');
  return {
    host: computed.hostname ?? '',
    port: computed.port ? Number.parseInt(computed.port, 10) : DEFAULT_SSH_PORT,
    username: computed.user ?? '',
    ...(firstIdentity ? { identityFile: expandTilde(firstIdentity) } : {}),
    ...(proxyJump ? { proxyJump } : {}),
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
    // 多模式行（`Host a b`）的每个模式都是独立条目
    for (const alias of directiveValues(section.value)) {
      if (alias === '*') continue;
      const computed = config.compute(alias, { ignoreCase: true });
      const proxyJump = directiveValues(computed.proxyjump).join(',');
      result.push({
        alias,
        hostName: computed.hostname ?? alias,
        user: computed.user ?? '',
        port: computed.port ? Number.parseInt(computed.port, 10) : DEFAULT_SSH_PORT,
        hasProxyJump: proxyJump.length > 0,
        ...(proxyJump ? { proxyJump } : {}),
      });
    }
  }
  return result;
}

/** user@host[:port] 直连语法（ad-hoc 主机，不经 config） */
const AD_HOC_HOST_RE = /^([^@\s]+)@([^@\s]+?)(?::(\d+))?$/;

/**
 * 解析 user@host[:port] 形式的直连主机。
 *
 * IPv6 字面量不支持内联（冒号与端口后缀冲突），需写进 ssh config。
 * 直连主机无 IdentityFile、无 ProxyJump——认证走交互式密码或 --password。
 *
 * @param alias - 命令行给出的主机参数
 * @returns 解析出的主机配置；不匹配直连语法时 undefined
 * @throws RemoteError('HOST_CONFIG_INVALID') 直连语法带无效端口
 */
function parseAdHocHost(alias: string): ResolvedHost | undefined {
  const match = AD_HOC_HOST_RE.exec(alias);
  if (match === null) return undefined;
  const username = match[1];
  const host = match[2];
  const portText = match[3];
  if (username === undefined || host === undefined) return undefined;

  let port = DEFAULT_SSH_PORT;
  if (portText !== undefined) {
    port = Number.parseInt(portText, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new RemoteError(
        'HOST_CONFIG_INVALID',
        `直连语法 ${alias} 的端口无效：${portText}（需 1–65535）`,
        { hostAlias: alias },
      );
    }
  }

  return { host, port, username };
}

/**
 * 解析 Host 别名获取完整连接配置（含递归解析 ProxyJump 跳板机链）。
 *
 * 别名优先按 config 解析（config 条目可能本身就含 @）；config 中不存在时
 * 尝试 user@host[:port] 直连语法。
 *
 * ProxyJump 格式："jump1" 或 "jump1,jump2"（多级跳板机，逗号分隔）。
 * 每个跳板机别名也会被递归解析（若其自身也配了 ProxyJump）。
 *
 * @param alias - SSH config 中的 Host 别名，或 user@host[:port] 直连语法
 * @returns 含跳板机链的完整配置
 * @throws RemoteError('HOST_NOT_FOUND') 既不在 config 也不匹配直连语法
 * @throws RemoteError('HOST_CONFIG_INVALID') 直连语法带无效端口
 */
export function resolveHost(alias: string): ResolvedHostWithJump {
  const config = loadConfig();

  // 必须先确认别名真的被某个具体 Host 条目覆盖。
  // 不能只看 compute() 有没有返回 hostname——config 里通常有 `Host *` 块，
  // 它会让任意别名都得到一份（只含通配默认值的）结果，于是"别名不存在"
  // 会被误报成"缺少 User、IdentityFile"，把用户引向错误的排查方向。
  if (!hasMatchingHostEntry(config, alias)) {
    const adHoc = parseAdHocHost(alias);
    if (adHoc !== undefined) return { target: adHoc, jumpHosts: [] };
    throw new RemoteError(
      'HOST_NOT_FOUND',
      `在 ${cachedPath} 中找不到主机别名 ${alias}；用 dsh-remote-explorer list 查看可用别名，`
        + '或用 user@host[:port] 直连',
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

/** 命令行认证覆盖（--private-key / --password），只作用于目标主机 */
export interface AuthOverrides {
  /** 私钥文件路径（--private-key）：优先于 config 的 IdentityFile */
  privateKey?: string;
  /** 固定密码（--password）：显式走密码认证，优先于 config 的 IdentityFile */
  password?: string;
}

/**
 * 解析主机并应用命令行认证覆盖。
 *
 * 优先级：--private-key > --password > config IdentityFile（两者同给时
 * --password 被忽略——密钥更安全）。跳板机不受覆盖影响，仍来自 config。
 *
 * @param alias - 主机别名或 user@host[:port] 直连语法
 * @param auth - 认证覆盖
 * @returns 应用覆盖后的完整配置
 * @throws RemoteError 同 {@link resolveHost}
 */
export function resolveHostWithAuth(alias: string, auth: AuthOverrides): ResolvedHostWithJump {
  const resolved = resolveHost(alias);
  if (auth.privateKey !== undefined) {
    return {
      ...resolved,
      target: { ...resolved.target, identityFile: expandTilde(auth.privateKey) },
    };
  }
  if (auth.password !== undefined) {
    // 显式密码意图：去掉 config 私钥，让传输层走密码认证。
    // 用 delete 而不是写 undefined，保持可选属性不含显式 undefined
    const target = { ...resolved.target };
    delete target.identityFile;
    return { ...resolved, target };
  }
  return resolved;
}

/** assertConnectable 的可选项 */
export interface AssertConnectableOptions {
  /** 已显式提供密码（--password）：无 IdentityFile 也放行，非交互终端同样有效 */
  passwordAuth?: boolean;
}

/**
 * 校验主机配置含连接所必需的字段。
 *
 * 认证途径：IdentityFile（私钥），或「无 IdentityFile + 交互式终端」（连接时
 * 提示输密码，不回显，密码只存内存不落盘），或 --password 显式提供。
 *
 * @param resolved - 解析结果
 * @param alias - 主机别名（错误消息用）
 * @param options - 密码认证可用性（--password 时为 true）
 * @throws RemoteError('HOST_CONFIG_INVALID') 缺少 User，或无任何可用认证途径
 */
export function assertConnectable(
  resolved: ResolvedHostWithJump,
  alias: string,
  options?: AssertConnectableOptions,
): void {
  const missing: string[] = [];
  if (!resolved.target.username) missing.push('User');
  // 无 IdentityFile 且既非交互终端也无显式密码时才视为缺配置——
  // 管道/CI 场景保持报错退出，绝不挂死等输入
  if (!resolved.target.identityFile
    && !isInteractiveTerminal()
    && options?.passwordAuth !== true) {
    missing.push('IdentityFile');
  }
  if (missing.length > 0) {
    throw new RemoteError(
      'HOST_CONFIG_INVALID',
      `主机 ${alias} 的 ssh config 缺少必要字段：${missing.join('、')}`
        + `（${cachedPath}）。请补上 IdentityFile，或在交互式终端下用密码登录，`
        + '或用 --password',
      { hostAlias: alias },
    );
  }
  // 跳板机不走 --password（覆盖只作用于目标主机）：无 IdentityFile 时
  // 只有交互式终端能救——连接时逐级提示输密码
  for (const [index, jump] of resolved.jumpHosts.entries()) {
    if (!jump.identityFile && !isInteractiveTerminal()) {
      throw new RemoteError(
        'HOST_CONFIG_INVALID',
        `主机 ${alias} 的跳板机 ${index + 1}（${jump.host}:${jump.port}）缺少 IdentityFile`
          + '（跳板机不走 --password，需配置私钥或交互式终端）',
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
    // 一个 Host 行可以列多个模式，归一后逐个比对
    for (const single of directiveValues(section.value)) {
      // `*` 是通配默认值块，对任意别名都匹配，不能作为"别名存在"的依据
      if (single === '*') continue;
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

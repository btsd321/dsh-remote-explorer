/**
 * @file 高级选项全局存储（连接表单的「上一次输入」，按传输形态分域）
 * @description 高级选项弹窗（环境变量 / 代理 / 直连主机跳板机）的持久化：
 *              **按传输形态分域**记录上一次的输入——SSH 域三项齐备
 *              （env / proxy / jumpHosts），WSL 域只有环境变量（WSL 无代理、
 *              无跳板机概念）。分域动机：WSL 连接不能吃到 SSH 场景配的
 *              env/proxy/jumpHosts（旧全局单条模型下 WSL 会整份继承）。
 *              域内仍不按主机区分——用户换主机（或换发行版）连接沿用同一份
 *              域配置（用户拍板的语义，取代旧 per-host 模型）。
 *
 * 落盘位置 `~/.dsh/remote-advanced.json`（与旧 remote-host-env.json 同目录），
 * 结构 v2：`{ "version": 2, "ssh": { env, proxy?, jumpHosts? }, "wsl": { env } }`。
 * **两域全空**时删除文件（清空配置不留空壳）；只清空一域时保留文件与另一域。
 *
 * v1 迁移：旧 v1 形状（顶层 env/proxy/jumpHosts，无 version 或 version 1）
 * 读取时归一化为 v2 内存形状——旧配置全部是 SSH 表单配的，进 ssh 域、
 * wsl 域空 env；首次写入后落盘即为 v2。迁移只发生在内存，不单独改写文件。
 *
 * 语义边界：
 * - `env`：连接时经 openSession 的 extraEnv 注入远端 dsh（三层合并中间层）
 * - `proxy`：连接时经 collectProxyEnv(explicit) 展开为八个代理键；优先级低于
 *   用户 env、高于 `DSH_REMOTE_PROXY` 环境变量兜底；**仅 SSH 域存储**
 *   （WSL 连接的代理兜底也在 tunnels 层被切断）
 * - `jumpHosts`：**仅对 user@host[:port] 直连主机生效**——config 别名主机
 *   的跳板机由 ssh config 的 ProxyJump 决定（分流规则唯一落点在
 *   session/transport/factory.ts），本存储里的值对别名主机被忽略
 *
 * 安全约束：
 * - **值可能敏感**（代理认证信息、token）：文件权限 0o600（Windows 上
 *   mode 位无效，靠用户目录 ACL 兜底）；日志与错误消息只打键名/字段名不打值
 * - **env 键名是命令注入面**：键名最终会经 remote-process.ts 的 envAssignments
 *   直接插值进远端启动命令，读写两侧都过校验（写入整组拒绝、读取逐键过滤
 *   ——后者防手工编辑文件绕过写入校验）
 * - 保留键黑名单（DSH_HOME/DSH_AGENTS_HOME/PATH）与 session 层同一集合
 *   （单一来源在 session/proxy-env.ts，本文件 import 而不自建）
 * - WSL 域只有 env：写入带 proxy/jumpHosts 属于调用方程序错误，直接抛错
 *   （防御性契约，路由层已先行 400）
 *
 * 与旧 remote-host-env.json 的关系：per-host 模型已废弃，旧文件**不读不迁
 * 不删**（留置由用户自行处置）。
 *
 * 读写频率低（弹窗保存时写、连接时读），与 host-env-store 一样不引入锁；
 * 原子性保留——写临时文件再 rename，并发读者不会看到半个文件。写路径是
 * 「读整个文件→归一化→替换目标域→落盘」，并发写两域存在丢更新窗口，
 * 但两个弹窗同时保存的场景不存在（同面板弹窗互斥）。
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { toErrorMessage } from '../util/errors.js';
import { createLogger } from '../util/logger.js';
import { isSafeEnvKey } from '../session/proxy-env.js';
import type { TransportType } from '../session/options.js';

const log = createLogger('advanced-store');

/** 落盘文件名（目录默认 `~/.dsh`，与旧 remote-host-env.json 同目录） */
const ADVANCED_FILE_NAME = 'remote-advanced.json';

/** 默认落盘目录 */
const DEFAULT_BASE_DIR = join(homedir(), '.dsh');

/** 值中不允许出现的控制字符（C0 控制码与 DEL）——防终端污染与注入 */
const CONTROL_CHARS_PATTERN = /[\x00-\x1f\x7f]/;

/** 跳板机条目（别名或 user@host[:port]）的宽松形态：非空、无空白与控制字符 */
const JUMP_ENTRY_PATTERN = /^\S+$/;

/**
 * 高级选项配置（内存形状；一个域的读出/写入面）。
 */
export interface AdvancedConfig {
  /** 注入远端 dsh 的用户环境变量 */
  env: Record<string, string>;
  /** 代理 URL（http(s) origin，可含 userinfo）；undefined = 未配置 */
  proxy?: string;
  /** 直连主机的跳板机条目（**落盘子集**：只有标识与私钥路径）；undefined = 未配置 */
  jumpHosts?: StoredJumpEntry[];
}

/**
 * 持久化的跳板机条目。
 *
 * 连接请求携带的完整 JumpEntry 还含内存态密码——**密码不落盘**（安全
 * 约束见 advanced-store 文件头），本类型是剔除密码后的落盘子集。
 */
export interface StoredJumpEntry {
  /** 跳板机标识（ssh config 别名或 user@host[:port] 直连语法） */
  target: string;
  /** 私钥路径覆盖（别名条目可省——config 的 IdentityFile 兜底） */
  identityFile?: string;
}

/** v2 落盘文件里的 SSH 域（三项齐备） */
interface SshDomainFile {
  /** 环境变量键值对 */
  env: Record<string, string>;
  /** 代理 URL（未配置时缺省） */
  proxy?: string;
  /** 直连主机跳板机条目（落盘子集，无密码；未配置时缺省） */
  jumpHosts?: StoredJumpEntry[];
}

/** v2 落盘文件里的 WSL 域（只有 env——WSL 无代理、无跳板机概念） */
interface WslDomainFile {
  /** 环境变量键值对 */
  env: Record<string, string>;
}

/** 落盘文件结构（v2，分域） */
interface AdvancedFile {
  /** 格式版本（2 = 按传输形态分域；v1 读取时归一化，见文件头迁移说明） */
  version: 2;
  /** SSH 域 */
  ssh: SshDomainFile;
  /** WSL 域 */
  wsl: WslDomainFile;
}

/**
 * 读出指定传输形态的高级选项配置。
 *
 * 容错读取：文件缺失、JSON 损坏或形状不对时回落全空配置（读不到配置不阻断
 * 连接）。各域各字段逐项过滤——手工编辑过的文件可能含非法值，坏项跳过并
 * 告警（键名/字段名可打、值不打），好项照常生效。wsl 域读出**永远只有
 * env**（域形状决定；手工塞进 wsl 域的 proxy/jumpHosts 不读出）。
 *
 * @param transportType - 传输形态（域键）：'ssh' 读 SSH 域，'wsl' 读 WSL 域
 * @param baseDir - 落盘目录（默认 `~/.dsh`；测试传临时目录）
 * @returns 配置；无文件或读取失败时全空（env 空对象、无 proxy、无 jumpHosts）
 */
export function readAdvancedConfig(transportType: TransportType, baseDir?: string): AdvancedConfig {
  const file = readAdvancedFile(baseDir ?? DEFAULT_BASE_DIR);
  if (transportType === 'wsl') {
    return { env: filterEnvEntries(file.wsl.env) };
  }
  return filterSshDomain(file.ssh);
}

/**
 * 保存指定传输形态的高级选项配置（整组替换该域，保留另一域）。
 *
 * 写入前整组校验——路由层通常已先行校验并返回 400，这里再拦一次是给绕过
 * 路由直接调用的调用方兜底。写路径是「读整个文件→归一化→替换目标域→
 * 落盘」：只清空一域时保留文件与另一域；**两域全空**时删除文件（清空配置
 * 不留空壳；缺失文件本就是合法空态）。
 *
 * 原子写：先写同目录临时文件再 rename，文件权限 0o600。
 *
 * @param transportType - 传输形态（域键）：'ssh' 写 SSH 域，'wsl' 写 WSL 域
 * @param config - 待保存配置（proxy/jumpHosts 为 undefined 表示清除该字段）
 * @param baseDir - 落盘目录（默认 `~/.dsh`；测试传临时目录）
 * @throws Error transportType='wsl' 但 config 带 proxy/jumpHosts（调用方程序
 *         错误，WSL 域只有 env）；校验失败（中文消息含具体键名/字段名）或
 *         写入失败
 */
export function writeAdvancedConfig(
  transportType: TransportType,
  config: AdvancedConfig,
  baseDir?: string,
): void {
  // WSL 域只有 env：带 proxy/jumpHosts 进来属于调用方程序错误（路由层已
  // 400 拦截），这里显式抛错防御绕过路由的调用
  if (transportType === 'wsl' && (config.proxy !== undefined || config.jumpHosts !== undefined)) {
    throw new Error('WSL 高级选项域仅支持环境变量，不支持 proxy/jumpHosts 字段（调用方不应传递）');
  }
  const error = validateAdvancedConfig(config);
  if (error !== undefined) {
    throw new Error(error);
  }
  const dir = baseDir ?? DEFAULT_BASE_DIR;
  // 读整个文件→归一化（v1 一并迁移）→替换目标域；保留的另一域顺带过读取侧
  // 过滤（手工编辑塞进文件的坏项借此清理，不再回写）
  const current = readAdvancedFile(dir);
  const preservedSsh: SshDomainFile = sshDomainToFile(filterSshDomain(current.ssh));
  const preservedWsl: WslDomainFile = { env: filterEnvEntries(current.wsl.env) };
  const next: AdvancedFile = transportType === 'wsl'
    ? { version: 2, ssh: preservedSsh, wsl: { env: config.env } }
    : {
      version: 2,
      // 空串代理/空跳板列表按「未配置」落盘（不写空壳字段）
      ssh: sshDomainToFile(config),
      wsl: preservedWsl,
    };
  if (sshDomainIsEmpty(next.ssh) && wslDomainIsEmpty(next.wsl)) {
    // 两域全空 = 清除全部配置：删文件而非留空壳
    try { rmSync(join(dir, ADVANCED_FILE_NAME), { force: true }); } catch { /* 删除失败无妨 */ }
    return;
  }
  writeAdvancedFile(next, dir);
}

/**
 * 校验一份高级选项配置（纯函数，路由层 400 判定用）。
 *
 * @param config - 待校验配置（值可能来自外部 JSON，类型注解不代表运行时形状）
 * @returns 第一条错误的中文消息（含具体键名/字段名）；全部合法返回 undefined
 */
export function validateAdvancedConfig(config: AdvancedConfig): string | undefined {
  for (const [key, value] of Object.entries(config.env)) {
    const error = envEntryError(key, value);
    if (error !== undefined) return error;
  }
  if (config.proxy !== undefined && config.proxy !== '' && proxyError(config.proxy) !== undefined) {
    return proxyError(config.proxy);
  }
  if (config.jumpHosts !== undefined) {
    for (const entry of config.jumpHosts) {
      const error = storedJumpEntryError(entry);
      if (error !== undefined) return error;
    }
  }
  return undefined;
}

/**
 * 校验单个环境变量键值对。
 *
 * @param key - 环境变量键名
 * @param value - 变量值（unknown：手工编辑过的 JSON 里可能是任意类型）
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
 * 校验代理 URL。
 *
 * 形态要求：http(s) 协议的 origin（可含 userinfo 与端口，允许尾随斜杠），
 * 不允许 path/query/fragment——代理地址是整条转发目标，带路径的值会把
 * 下游请求引向错误位置。
 *
 * @param proxy - 代理 URL 字符串
 * @returns 错误消息；合法返回 undefined
 */
function proxyError(proxy: string): string | undefined {
  if (typeof proxy !== 'string') return '代理地址必须是字符串';
  if (CONTROL_CHARS_PATTERN.test(proxy)) return '代理地址含控制字符';
  let url: URL;
  try {
    url = new URL(proxy);
  } catch {
    return `代理地址 '${proxy}' 不是合法 URL`;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return `代理地址 '${proxy}' 必须是 http 或 https 协议`;
  }
  if (url.pathname !== '/' && url.pathname !== '' ) {
    return `代理地址 '${proxy}' 不允许携带路径`;
  }
  if (url.search !== '' || url.hash !== '') {
    return `代理地址 '${proxy}' 不允许携带查询串或片段`;
  }
  return undefined;
}

/**
 * 校验单个持久化跳板机条目（含「密码不落盘」防御）。
 *
 * 只做形态校验（target 非空无空白、identityFile 无控制字符）——条目是
 * ssh config 别名还是 user@host[:port] 直连语法由连接时的 resolveHost 判定，
 * 存储侧无从（也不应）预判 config 里的别名存在性。**条目出现 password 字段
 * 一律拒绝**：密码只经连接请求内存传递（安全约束见文件头），调用方（路由）
 * 把带密码的条目存进来属于程序性错误，显式报错而非静默剔除。
 *
 * @param entry - 持久化跳板机条目（运行时形状未知）
 * @returns 错误消息；合法返回 undefined
 */
function storedJumpEntryError(entry: unknown): string | undefined {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    return `跳板机条目必须是对象（含 target 字段），收到 ${typeof entry}`;
  }
  const record = entry as Record<string, unknown>;
  if (typeof record.target !== 'string') return '跳板机条目的 target 字段必须是字符串';
  if (record.target.trim() === '') return '跳板机条目的 target 不能为空';
  if (CONTROL_CHARS_PATTERN.test(record.target)) {
    return `跳板机条目 '${record.target}' 的 target 含控制字符`;
  }
  if (!JUMP_ENTRY_PATTERN.test(record.target)) {
    return `跳板机条目 '${record.target}' 含空白字符（每条一个别名或 user@host[:port]）`;
  }
  if (record.identityFile !== undefined) {
    if (typeof record.identityFile !== 'string') {
      return `跳板机条目 '${record.target}' 的 identityFile 必须是字符串`;
    }
    if (CONTROL_CHARS_PATTERN.test(record.identityFile)) {
      return `跳板机条目 '${record.target}' 的 identityFile 含控制字符`;
    }
  }
  if (record.password !== undefined) {
    return `跳板机条目 '${record.target}' 携带 password 字段——密码不落盘，请在连接时输入`;
  }
  return undefined;
}

/**
 * 读取侧过滤 SSH 域（字段级校验与密码剔除——手工编辑防御）。
 *
 * @param domain - 读取/归一化后的 SSH 域（值来自落盘 JSON，运行时形状未知）
 * @returns 过滤后的配置形状（坏项跳过并告警，好项照常生效）
 */
function filterSshDomain(domain: SshDomainFile): AdvancedConfig {
  const env = filterEnvEntries(domain.env);
  const proxy = domain.proxy !== undefined && proxyError(domain.proxy) === undefined
    ? domain.proxy
    : undefined;
  if (domain.proxy !== undefined && proxy === undefined) {
    log.warn('高级选项文件 ssh 域的 proxy 字段非法，已跳过');
  }
  // 读取侧先剔密码字段再校验（手工编辑塞进文件的密码直接丢弃而非整条作废
  // ——条目本身可能仍是有效的跳板配置）；写侧的拒绝语义见 storedJumpEntryError
  const jumpHosts = domain.jumpHosts
    ?.map(entry => {
      const stripped = stripJumpPassword(entry);
      return storedJumpEntryError(stripped) === undefined ? stripped : undefined;
    })
    .filter((entry): entry is StoredJumpEntry => entry !== undefined);
  if (domain.jumpHosts !== undefined && jumpHosts !== undefined && jumpHosts.length !== domain.jumpHosts.length) {
    log.warn('高级选项文件 ssh 域的 jumpHosts 含非法条目，已跳过对应项');
  }
  return {
    env,
    ...(proxy !== undefined ? { proxy } : {}),
    ...(jumpHosts !== undefined && jumpHosts.length > 0 ? { jumpHosts } : {}),
  };
}

/**
 * 读取侧过滤 env 映射（逐键校验——手工编辑防御）。
 *
 * @param env - 归一化后的 env 映射（值来自落盘 JSON）
 * @returns 只含合法键值对的 env
 */
function filterEnvEntries(env: Record<string, string>): Record<string, string> {
  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    // 值来自落盘 JSON，运行时可能是任意 JSON 值（类型注解拦不住手工编辑）
    if (envEntryError(key, value) !== undefined) {
      log.warn(`高级选项文件中的环境变量键 '${key}' 非法，已跳过`);
      continue;
    }
    filtered[key] = value;
  }
  return filtered;
}

/**
 * 把 AdvancedConfig 压回 SSH 域的落盘形状（空串代理/空列表不落盘）。
 *
 * @param config - 已过校验的配置
 * @returns SSH 域落盘形状
 */
function sshDomainToFile(config: AdvancedConfig): SshDomainFile {
  return {
    env: config.env,
    ...(config.proxy !== undefined && config.proxy !== '' ? { proxy: config.proxy } : {}),
    ...(config.jumpHosts !== undefined && config.jumpHosts.length > 0
      ? { jumpHosts: config.jumpHosts }
      : {}),
  };
}

/** SSH 域是否全空（env 空、代理未配、跳板列表空） */
function sshDomainIsEmpty(domain: SshDomainFile): boolean {
  return Object.keys(domain.env).length === 0
    && (domain.proxy === undefined || domain.proxy === '')
    && (domain.jumpHosts === undefined || domain.jumpHosts.length === 0);
}

/** WSL 域是否全空（只有 env 一个面） */
function wslDomainIsEmpty(domain: WslDomainFile): boolean {
  return Object.keys(domain.env).length === 0;
}

/**
 * 剔除条目上的密码字段（读取侧防御：手工编辑塞进文件的密码直接丢弃）。
 *
 * @param entry - 原始条目（已过形态收窄）
 * @returns 只含 target 与 identityFile 的条目
 */
function stripJumpPassword(entry: StoredJumpEntry & { password?: unknown }): StoredJumpEntry {
  const { password: _dropped, ...rest } = entry;
  return rest;
}

/**
 * 读取整个落盘文件并归一化为 v2 内存形状（不做字段语义校验）。
 *
 * 兼容 v1：旧形状（顶层 env/proxy/jumpHosts，无 version 或 version 1）是
 * SSH 表单配的全局单条——归一化进 ssh 域、wsl 域空 env；归一化只发生在
 * 内存，落盘仍是 v1 原文，首次 writeAdvancedConfig 后即为 v2。
 *
 * @param dir - 落盘目录
 * @returns v2 归一化形状；缺失、损坏或形状不对时两域全空
 */
function readAdvancedFile(dir: string): AdvancedFile {
  const filePath = join(dir, ADVANCED_FILE_NAME);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
  } catch (error) {
    // 文件缺失（ENOENT）与 JSON 损坏都回落空配置：读不到配置只影响注入面，
    // 不应阻断连接；损坏时告警留诊断线索
    log.warn(`读取高级选项文件失败（回落空配置）：${toErrorMessage(error)}`);
    return emptyFile();
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    log.warn('高级选项文件形状不符（根不是对象），回落空配置');
    return emptyFile();
  }
  const record = parsed as Record<string, unknown>;
  if (record.version === 2) {
    return {
      version: 2,
      ssh: extractSshDomain(record.ssh),
      wsl: extractWslDomain(record.wsl),
    };
  }
  // v1（无 version 或 version 1）：顶层字段是 SSH 表单配的，归一化进 ssh 域
  const env = extractEnv(parsed);
  if (env === undefined) {
    log.warn('高级选项文件形状不符（env 结构缺失），回落空配置');
    return emptyFile();
  }
  const raw = parsed as { proxy?: unknown; jumpHosts?: unknown };
  const proxy = typeof raw.proxy === 'string' ? raw.proxy : undefined;
  // 条目形状先松收窄为对象数组；字段级校验与密码剔除在读取/写入路径
  const jumpHosts = Array.isArray(raw.jumpHosts)
    && raw.jumpHosts.every(item => typeof item === 'object' && item !== null && !Array.isArray(item))
    ? raw.jumpHosts as StoredJumpEntry[]
    : undefined;
  return {
    version: 2,
    ssh: {
      env,
      ...(proxy !== undefined ? { proxy } : {}),
      ...(jumpHosts !== undefined ? { jumpHosts } : {}),
    },
    wsl: { env: {} },
  };
}

/**
 * 从 v2 文件的 ssh 域收窄出结构形状（缺省/形状不对按空域处理）。
 *
 * @param raw - 落盘 JSON 的 ssh 域（unknown）
 * @returns 结构收窄后的 SSH 域
 */
function extractSshDomain(raw: unknown): SshDomainFile {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    log.warn('高级选项文件 v2 的 ssh 域形状不对，按空处理');
    return { env: {} };
  }
  const record = raw as { env?: unknown; proxy?: unknown; jumpHosts?: unknown };
  const env = extractEnv(record);
  if (env === undefined) {
    log.warn('高级选项文件 v2 的 ssh 域缺 env 结构，按空处理');
    return { env: {} };
  }
  const proxy = typeof record.proxy === 'string' ? record.proxy : undefined;
  const jumpHosts = Array.isArray(record.jumpHosts)
    && record.jumpHosts.every(item => typeof item === 'object' && item !== null && !Array.isArray(item))
    ? record.jumpHosts as StoredJumpEntry[]
    : undefined;
  return {
    env,
    ...(proxy !== undefined ? { proxy } : {}),
    ...(jumpHosts !== undefined ? { jumpHosts } : {}),
  };
}

/**
 * 从 v2 文件的 wsl 域收窄出 env（缺省/形状不对按空处理；域里手工塞进的
 * proxy/jumpHosts 不读出——wsl 域只有 env）。
 *
 * @param raw - 落盘 JSON 的 wsl 域（unknown）
 * @returns 只含 env 的 WSL 域
 */
function extractWslDomain(raw: unknown): WslDomainFile {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    log.warn('高级选项文件 v2 的 wsl 域形状不对，按空处理');
    return { env: {} };
  }
  const record = raw as { env?: unknown; proxy?: unknown; jumpHosts?: unknown };
  if (record.proxy !== undefined || record.jumpHosts !== undefined) {
    // wsl 域只有 env：手工编辑塞进来的 proxy/jumpHosts 一律忽略（告警留痕）
    log.warn('高级选项文件 v2 的 wsl 域出现 proxy/jumpHosts 字段，已忽略（WSL 仅支持环境变量）');
  }
  const env = extractEnv(record);
  if (env === undefined) {
    log.warn('高级选项文件 v2 的 wsl 域缺 env 结构，按空处理');
    return { env: {} };
  }
  return { env };
}

/**
 * 从解析结果中提取合法形状的 env 映射。
 *
 * 只做结构收窄（env 是 plain object），键值语义校验留给读取/写入路径。
 *
 * @param parsed - 含 env 字段的对象（v1 根对象或 v2 域对象）
 * @returns 合法形状的 env；形状不对时 undefined
 */
function extractEnv(parsed: unknown): Record<string, string> | undefined {
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const rawEnv = (parsed as { env?: unknown }).env;
  if (typeof rawEnv !== 'object' || rawEnv === null || Array.isArray(rawEnv)) {
    return undefined;
  }
  return rawEnv as Record<string, string>;
}

/** 两域全空的 v2 形状 */
function emptyFile(): AdvancedFile {
  return { version: 2, ssh: { env: {} }, wsl: { env: {} } };
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
function writeAdvancedFile(file: AdvancedFile, dir: string): void {
  mkdirSync(dir, { recursive: true });
  const finalPath = join(dir, ADVANCED_FILE_NAME);
  const tmpPath = `${finalPath}.${process.pid}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(file, undefined, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    renameSync(tmpPath, finalPath);
  } catch (error) {
    // rename 失败要清掉临时文件，否则会在目录里累积
    try { rmSync(tmpPath, { force: true }); } catch { /* 清理失败无妨 */ }
    throw new Error(`写入高级选项文件失败（${finalPath}）：${toErrorMessage(error)}`);
  }
}

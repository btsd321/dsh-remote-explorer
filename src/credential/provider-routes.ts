/**
 * @file 本机 settings.yaml 的供应商路由提取与远端镜像
 * @description 读本机 `~/.dsh/settings.yaml`，抽出 `llm-pi-ai.providers` 里所有
 *              带凭据引用的供应商，构建代理路由表；同时产出一份「远端镜像」
 *              settings——内容与本机一致，仅把供应商的 `baseURL` 重定向进反向隧道。
 *
 * 为什么需要这一层（P5 后多供应商支持的依据）：
 *
 * - dsh 的模型供应商有两套通道：`llm-deepseek` 原生适配器（P4 已覆盖，走 patch）
 *   和 `llm-pi-ai` 多供应商适配器（走 settings.yaml 的 `llm-pi-ai:` 段）。
 *   用户的默认模型可能配置在后者（如 AStudio），P4 的单上游代理覆盖不到。
 * - `llm-pi-ai` 在 base bundle 里（远端 web 组合自带），其 settings 段热重载，
 *   `apiKeyEnv` 每次请求经 `ctx.credentials` 从**继承环境**解析——所以远端
 *   进程环境里放占位令牌即可生效，与 DeepSeek 的机制一致。
 * - settings.yaml 只含**凭据引用**（环境变量名），不含明文密钥；真正的密钥在
 *   `$DSH_HOME/.credentials.yaml`（凭据库）或环境变量里。**我们只镜像 settings，
 *   绝不镜像 .credentials.yaml**——后者可能含真实密钥，落远端就违背了
 *   「key 不出本机」的整个设计。
 *
 * 路由前缀约定：
 *
 * - DeepSeek 原生通道保留 `/anthropic`（P4 行为，messages 协议上游自带该路径）
 * - pi-ai 供应商统一用 `/r/<供应商名>` 前缀——独立命名空间，
 *   供应商名字再巧也不会撞上 `/anthropic`
 *
 * 分层约束：本文件属能力层，只依赖 yaml 库与 node 内置模块。
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';

/** 一条代理路由 */
export interface ProxyRoute {
  /** 路由前缀（远端 baseURL 的路径部分，以 / 开头） */
  prefix: string;
  /** 上游 origin（协议 + 主机 + 端口，不含路径） */
  upstreamOrigin: string;
  /** 上游路径（prefix 之外的替换目标，可为空串） */
  upstreamPath: string;
  /** 真实 key 的本机环境变量名 */
  keyEnv: string;
  /** 展示名 */
  label: string;
}

/** 本机 settings.yaml 的默认路径 */
const LOCAL_SETTINGS_PATH = join(homedir(), '.dsh', 'settings.yaml');

/** DeepSeek 原生通道的路由前缀（保留字，pi-ai 供应商不得占用） */
const DEEPSEEK_PREFIX = '/anthropic';

/** pi-ai 供应商的路由前缀命名空间 */
const PROVIDER_NS = '/r';

/** 合法环境变量名的判据：env 前缀里的名字不经引号转义，必须严格校验 */
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** settings.yaml 顶层结构中我们关心的段 */
interface SettingsDocument {
  /** llm-pi-ai 段 */
  'llm-pi-ai'?: {
    /** 供应商字典：键名即路由名 */
    providers?: Record<string, ProviderProfile>;
  };
  /** 其余键原样保留（镜像时透传） */
  [key: string]: unknown;
}

/** 一个供应商的配置（只声明我们读写的字段） */
interface ProviderProfile {
  /** 凭据引用（环境变量名） */
  apiKeyEnv?: string;
  /** 上游地址 */
  baseURL?: string;
  /** 其余字段镜像时原样保留 */
  [key: string]: unknown;
}

/**
 * DeepSeek 原生通道的路由（固定值）。
 *
 * 前缀与上游路径相同，转发时路径不变——这正是 P4 的既有行为，
 * 泛化后的路由机制把它统一了进来。
 */
export function deepseekRoute(): ProxyRoute {
  return {
    prefix: DEEPSEEK_PREFIX,
    upstreamOrigin: 'https://api.deepseek.com',
    upstreamPath: '/anthropic',
    keyEnv: 'DEEPSEEK_API_KEY',
    label: 'DeepSeek',
  };
}

/**
 * 读取本机 settings.yaml 文本。
 *
 * @param path - 覆盖路径（默认 ~/.dsh/settings.yaml）
 * @returns 文本；文件不存在时 undefined
 */
export function readLocalSettings(path: string = LOCAL_SETTINGS_PATH): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch { /* 文件不存在或不可读：凭据路径只剩 DeepSeek 原生通道 */ }
  return undefined;
}

/**
 * 从 settings 文本提取 pi-ai 供应商路由。
 *
 * 只收同时具备 `apiKeyEnv` 与 `baseURL` 的供应商——没有凭据引用的路由
 * 无从注入占位令牌（代理收不到可校验的请求），没有上游地址则无从转发。
 * 其余供应商的配置**不改动**，远端直连（远端有网络，不依赖代理）。
 *
 * @param settingsText - 本机 settings.yaml 文本
 * @returns 路由列表（前缀为 /r/<名>）
 */
export function extractProviderRoutes(settingsText: string): ProxyRoute[] {
  let document: SettingsDocument;
  try {
    document = parse(settingsText) as SettingsDocument;
  } catch {
    // 解析失败不能让整个会话失败：跳过 pi-ai 镜像，凭据路径只剩 DeepSeek
    return [];
  }

  const providers = document?.['llm-pi-ai']?.providers;
  if (providers === undefined || typeof providers !== 'object') return [];

  const routes: ProxyRoute[] = [];
  for (const [name, profile] of Object.entries(providers)) {
    if (profile === null || typeof profile !== 'object') continue;
    const apiKeyEnv = (profile as ProviderProfile).apiKeyEnv;
    const baseURL = (profile as ProviderProfile).baseURL;
    if (typeof apiKeyEnv !== 'string' || typeof baseURL !== 'string') continue;

    // 环境变量名会不经引号写进远端 runner 脚本，非法名必须跳过而不是侥幸拼进去
    if (!ENV_NAME_PATTERN.test(apiKeyEnv)) continue;

    const upstream = splitUrl(baseURL);
    if (!upstream) continue;

    routes.push({
      prefix: `${PROVIDER_NS}/${name}`,
      upstreamOrigin: upstream.origin,
      upstreamPath: upstream.path,
      keyEnv: apiKeyEnv,
      label: name,
    });
  }
  return routes;
}

/**
 * 产出远端镜像 settings：内容与本机一致，仅供应商 baseURL 重定向进隧道。
 *
 * 解析失败时返回 undefined（调用方跳过镜像，会话继续）。
 *
 * @param settingsText - 本机 settings.yaml 文本
 * @param reversePort - 反向隧道端口
 * @returns 远端 settings.yaml 文本；无法处理时 undefined
 */
export function mirrorSettingsForTunnel(
  settingsText: string,
  reversePort: number,
): string | undefined {
  let document: unknown;
  try {
    document = parse(settingsText);
  } catch {
    return undefined;
  }
  if (document === null || typeof document !== 'object') return undefined;

  const piAi = (document as SettingsDocument)['llm-pi-ai'];
  if (piAi !== undefined && typeof piAi === 'object' && piAi !== null) {
    const providers = (piAi as { providers?: unknown }).providers;
    if (providers !== undefined && typeof providers === 'object' && providers !== null) {
      for (const [name, profile] of Object.entries(providers as Record<string, unknown>)) {
        if (profile === null || typeof profile !== 'object') continue;
        const record = profile as Record<string, unknown>;
        const apiKeyEnv = record['apiKeyEnv'];
        const baseURL = record['baseURL'];
        // 与 extractProviderRoutes 同一判据：两个条件齐才有资格重定向
        if (typeof apiKeyEnv !== 'string' || !ENV_NAME_PATTERN.test(apiKeyEnv)) continue;
        if (typeof baseURL !== 'string' || baseURL.length === 0) continue;
        record['baseURL'] = `http://127.0.0.1:${reversePort}${PROVIDER_NS}/${name}`;
      }
    }
  }

  return stringify(document);
}

/**
 * 拆 URL 为 origin 与路径。
 *
 * @param url - 完整 URL
 * @returns 拆分结果；非法 URL 时 undefined
 */
function splitUrl(url: string): { origin: string; path: string } | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    return {
      origin: parsed.origin,
      // pathname 可能含需要保留的编码形式，原样使用
      path: parsed.pathname.replace(/\/+$/, ''),
    };
  } catch { /* 非法 URL 的供应商跳过 */ }
  return undefined;
}

/** 本机 settings.yaml 默认路径（导出供测试与诊断引用） */
export const localSettingsPath = LOCAL_SETTINGS_PATH;

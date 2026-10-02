/**
 * @file 本机 .credentials.yaml 凭据读取
 * @description 读取本机 `$DSH_HOME/.credentials.yaml` 的两个段：
 *              - `refs` 段：环境变量名到密钥值的映射（API key 等简单引用）
 *              - `records` 段：结构化凭据记录（DeepSeek 账号 grant token 等）
 *
 *              两段都供反向隧道代理在本机替换真实凭据——远端只存占位令牌，
 *              请求经隧道回到本机后替换为真实值转发上游。真实密钥全程不出本机。
 *
 * 安全约束：
 * - 只读不写；绝不把 `.credentials.yaml` 的内容传到远端
 * - 日志与错误消息不打印密钥值
 * - 文件不存在或解析失败时返回空结果（graceful fallback），不阻断会话
 *
 * 格式约定（与 dsh credentials-local 包一致）：
 * ```yaml
 * version: 1
 * refs:
 *   DEEPSEEK_API_KEY: sk-xxx
 *   OPENAI_API_KEY: sk-yyy
 * records:
 *   deepseek-account-platform/default:
 *     kind: grant
 *     payload:
 *       version: 1
 *       token: <平台 OAuth token>
 *       issuer: https://platform.deepseek.com
 * ```
 *
 * 分层约束：本文件属能力层，只依赖 yaml 库与 node 内置模块。
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { createLogger } from '../util/logger.js';

const log = createLogger('local-credentials');

/** `.credentials.yaml` 文件名（与 dsh credentials-local 包的 CREDENTIALS_FILENAME 一致） */
const CREDENTIALS_FILENAME = '.credentials.yaml';

/** 当前支持的文档版本 */
const DOCUMENT_VERSION = 1;

/**
 * 本机 `.credentials.yaml` 的默认路径。
 *
 * 优先 `$DSH_HOME/.credentials.yaml`：以 dsh 插件形态运行时，本进程就是宿主 dsh，
 * 它的家由 DSH_HOME 决定（桌面版指向 userData 而非 ~/.dsh）——必须读取
 * **宿主真正在用的**那份凭据。CLI 形态通常没有 DSH_HOME，回落 ~/.dsh。
 * 做成函数而非常量：DSH_HOME 是进程环境，读取时机应在调用点而非模块加载点。
 */
function defaultLocalCredentialsPath(): string {
  const dshHome = process.env.DSH_HOME;
  // 本机路径，node:path 的 join 是正确工具（远端路径才禁用 join）
  return join(dshHome !== undefined && dshHome !== '' ? dshHome : join(homedir(), '.dsh'), CREDENTIALS_FILENAME);
}

/**
 * 从本机 `.credentials.yaml` 读取 refs 段的凭据映射。
 *
 * 只提取 `refs` 段中值为非空字符串的条目——这些是 dsh 凭据解析中
 * `ctx.credentials.resolve(credentialRef(name))` 能查到的简单引用。
 * `records` 段（结构化凭据如 grant/api-key record）由 {@link readLocalAccountToken} 处理。
 *
 * @param path - 覆盖路径（默认 `$DSH_HOME/.credentials.yaml`）
 * @returns 环境变量名到密钥值的映射；文件不存在、版本不匹配或解析失败时返回空 Map
 */
export function readLocalCredentials(path: string = defaultLocalCredentialsPath()): Map<string, string> {
  const result = new Map<string, string>();
  const root = parseCredentialsDocument(path);
  if (root === undefined) return result;

  const refs = root['refs'];
  if (refs === undefined || refs === null) return result;
  if (typeof refs !== 'object' || Array.isArray(refs)) {
    log.warn(`本机凭据文件 refs 段格式无效（${path}），仅使用环境变量`);
    return result;
  }

  for (const [key, value] of Object.entries(refs as Record<string, unknown>)) {
    // 只收非空字符串值；其余类型（数字、对象等）不是合法的凭据引用
    if (typeof value === 'string' && value.length > 0) {
      result.set(key, value);
    }
  }

  log.debug(`本机凭据文件已加载（${path}）：${result.size} 条引用`);
  return result;
}

/** DeepSeek 账号平台在 records 段中的键名（与 dsh deepseek-account-platform 包的 KEY 一致） */
const ACCOUNT_RECORD_KEY = 'deepseek-account-platform/default';

/**
 * 从本机 `.credentials.yaml` 读取 DeepSeek 账号的 grant token。
 *
 * dsh 的 `deepseek-account-platform` 插件登录后把 OAuth token 以 grant record
 * 形式存入 `records` 段。dsh 的 `llm-deepseek-account` 适配器从该 record 取
 * token，放进 `x-dsh-auth-token` 头发往 `api.deepseek.com`——与 `refs` 段的
 * `DEEPSEEK_API_KEY`（放进 `x-api-key` 头）在安全层面完全等价：都是直接用于
 * 模型调用的认证密钥。因此 token 全程不出本机，远端走隧道代理替换。
 *
 * @param path - 覆盖路径（默认 `$DSH_HOME/.credentials.yaml`）
 * @returns grant token；文件不存在、无记录或格式不符时 undefined
 */
export function readLocalAccountToken(path: string = defaultLocalCredentialsPath()): string | undefined {
  const root = parseCredentialsDocument(path);
  if (root === undefined) {
    // 未登录账号是常态（API key 用户），debug 级即可
    log.debug('readLocalAccountToken: 凭据文档不可读或格式不符', { path });
    return undefined;
  }

  const records = root['records'];
  if (records === undefined || records === null) return undefined;
  if (typeof records !== 'object' || Array.isArray(records)) return undefined;

  const record = (records as Record<string, unknown>)[ACCOUNT_RECORD_KEY];
  if (record === undefined || record === null || typeof record !== 'object') {
    log.debug('readLocalAccountToken: records 段无 deepseek-account-platform/default 记录', { path });
    return undefined;
  }

  // record 形如 { kind: 'grant', payload: { version: 1, token: '...', issuer: '...' } }
  const r = record as Record<string, unknown>;
  if (r['kind'] !== 'grant') return undefined;

  const payload = r['payload'];
  if (payload === undefined || payload === null || typeof payload !== 'object') return undefined;

  const token = (payload as Record<string, unknown>)['token'];
  if (typeof token !== 'string' || token.length === 0) return undefined;

  // info 级：账号通道是否可用是每次连接的关键事实（远端会否镜像登录态）
  log.info('readLocalAccountToken: 已读取 account token', { path, tokenLength: token.length });
  return token;
}

/**
 * 解析本机 `.credentials.yaml` 的顶层对象。
 *
 * 共享的文件读取 + 版本校验逻辑——refs 和 records 两段的读取都经此入口，
 * 避免重复 parse 与版本检查。文件不存在、版本不匹配或解析失败时返回 undefined。
 *
 * @param path - 文件路径
 * @returns 顶层对象；不可读或格式不符时 undefined
 */
function parseCredentialsDocument(path: string): Record<string, unknown> | undefined {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    // 文件不存在或不可读：凭据路径只剩环境变量，不阻断会话
    log.debug(`本机凭据文件不可读（${path}），仅使用环境变量`);
    return undefined;
  }

  let document: unknown;
  try {
    document = parse(text);
  } catch {
    // YAML 解析失败：记录警告但不阻断——环境变量仍可兜底
    log.warn(`本机凭据文件解析失败（${path}），仅使用环境变量`);
    return undefined;
  }

  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    log.warn(`本机凭据文件格式无效（${path}），仅使用环境变量`);
    return undefined;
  }

  const root = document as Record<string, unknown>;

  // 空文档（纯注释）视为空存储
  if (Object.keys(root).length === 0) return undefined;

  // 版本校验：不匹配的版本文档结构可能完全不同，静默跳过比误读安全
  if (root['version'] !== DOCUMENT_VERSION) {
    log.warn(
      `本机凭据文件版本不匹配（${path}：期望 ${DOCUMENT_VERSION}，实际 ${JSON.stringify(root['version'])}），仅使用环境变量`,
    );
    return undefined;
  }

  return root;
}

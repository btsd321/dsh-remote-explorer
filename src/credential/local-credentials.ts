/**
 * @file 本机 .credentials.yaml 凭据读取
 * @description 读取本机 `$DSH_HOME/.credentials.yaml` 的 `refs` 段，提取
 *              环境变量名到密钥值的映射。供反向隧道代理在 `process.env`
 *              之外回退查找真实 key——对齐 dsh 自身的凭据解析优先级
 *              （`.credentials.yaml` > 环境变量）。
 *
 * 安全约束：
 * - 只读不写；绝不把 `.credentials.yaml` 的内容传到远端
 * - 日志与错误消息不打印密钥值
 * - 文件不存在或解析失败时返回空 Map（graceful fallback），不阻断会话
 *
 * 格式约定（与 dsh credentials-local 包一致）：
 * ```yaml
 * version: 1
 * refs:
 *   DEEPSEEK_API_KEY: sk-xxx
 *   OPENAI_API_KEY: sk-yyy
 * ```
 * 本模块只关心 `refs` 段的扁平 key→value 映射，不处理 `records` 段。
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
 * `records` 段（结构化凭据如 grant/api-key record）不在本模块范围内：
 * 反向隧道代理只需要「环境变量名 → 密钥字符串」的扁平映射。
 *
 * @param path - 覆盖路径（默认 `$DSH_HOME/.credentials.yaml`）
 * @returns 环境变量名到密钥值的映射；文件不存在、版本不匹配或解析失败时返回空 Map
 */
export function readLocalCredentials(path: string = defaultLocalCredentialsPath()): Map<string, string> {
  const result = new Map<string, string>();

  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    // 文件不存在或不可读：凭据路径只剩环境变量，不阻断会话
    log.debug(`本机凭据文件不可读（${path}），仅使用环境变量`);
    return result;
  }

  let document: unknown;
  try {
    document = parse(text);
  } catch {
    // YAML 解析失败：记录警告但不阻断——环境变量仍可兜底
    log.warn(`本机凭据文件解析失败（${path}），仅使用环境变量`);
    return result;
  }

  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    log.warn(`本机凭据文件格式无效（${path}），仅使用环境变量`);
    return result;
  }

  const root = document as Record<string, unknown>;

  // 空文档（纯注释）视为空存储
  const keys = Object.keys(root);
  if (keys.length === 0) return result;

  // 版本校验：不匹配的版本文档结构可能完全不同，静默跳过比误读安全
  const version = root['version'];
  if (version !== DOCUMENT_VERSION) {
    log.warn(
      `本机凭据文件版本不匹配（${path}：期望 ${DOCUMENT_VERSION}，实际 ${JSON.stringify(version)}），仅使用环境变量`,
    );
    return result;
  }

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

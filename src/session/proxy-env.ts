/**
 * @file 远端环境变量注入的收集与校验
 * @description 为启动远端 dsh 的 extraEnv 注入口提供两个能力：
 *
 * 1. **代理变量收集**（collectProxyEnv）：远端 dsh 装插件时 dsh 会把
 *    `github:` 规格改写成 `https://github.com/...` 再跑 `git ls-remote`（HTTPS
 *    443 端口），无公网主机上裸连必超时。dsh 自身的代理透传链路是完好的
 *    ——`scrubbedParentEnv()` 会保留 `http_proxy`/`https_proxy` 等变量并注入
 *    `NODE_USE_ENV_PROXY=1`，使 dsh 拉起的 git/pnpm 子进程走同一代理；缺的
 *    只是「dsh 进程自己的环境里有这些变量」。本模块在启动远端 dsh 时把
 *    代理变量并进 extraEnv，值指向 SSH 反向隧道在远端的代理端口。
 *
 * 2. **键名校验**（assertSafeEnvKeys / isSafeEnvKey）：remote-process.ts 拼
 *    envAssignments 时键名**不经 quote 直接插值**进 shell 命令
 *    （`${key}=${quote(value)}`），用户自定义 env 的键名一旦含空格、`=`、
 *    `$()` 等字符就是命令注入；DSH_HOME/DSH_AGENTS_HOME/PATH 在
 *    envAssignments 里先于 extraEnv 赋值，用户值会覆盖会话隔离契约
 *    （见 docs/lessons.md 第 11 条）。校验规则在这里收口成单一来源，
 *    session 层与 plugin 层（host-env-store）共用。
 *
 * 分层：本文件属编排层（session/），plugin 层入口允许向下 import。
 */

import { RemoteError } from '../util/errors.js';

/**
 * 环境变量键名合法形态。
 *
 * 只允许字母/数字/下划线且不以数字开头——这是 sh 的 `KEY=VALUE` 赋值里
 * KEY 侧的安全字符集，也顺带排除了空串键。
 */
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * 保留键：不允许出现在用户自定义 env 里。
 *
 * - `DSH_HOME` / `DSH_AGENTS_HOME`：remote-process.ts 的 envAssignments 在
 *   extraEnv 之前赋值，用户值会覆盖会话隔离契约（远端落盘隔离，见
 *   docs/lessons.md 第 11 条）
 * - `PATH`：启动器要保证 node bin 目录在最前（`quote(nodeBinDir):"$PATH"`），
 *   用户覆盖会破坏 dsh 与子进程的命令查找
 */
export const RESERVED_REMOTE_ENV_KEYS: readonly string[] = ['DSH_HOME', 'DSH_AGENTS_HOME', 'PATH'];

/**
 * 收集要注入远端 dsh 的代理环境变量。
 *
 * 来源优先级：显式传入 > 本机环境变量 `DSH_REMOTE_PROXY` > 不设（有网机器
 * 零影响的回归语义）。命中时同时设六个键（大小写各半 + ALL_PROXY），值相同
 * ——git 认小写、npm/curl 认大小写皆可、Node 的 undici 认大写，全设是为了
 * 覆盖各自的读取习惯，不指望消费方统一。
 *
 * dsh 的 `scrubbedParentEnv` 会保留这些变量并注入 `NODE_USE_ENV_PROXY=1`，
 * 使远端 dsh 拉起的 git/pnpm 子进程走同一代理（见 deepseek-harness
 * subprocess 包）；不设则零影响。
 *
 * @param explicit - 调用方显式指定的代理 URL（如 per-host 配置），优先于环境变量
 * @returns 代理环境变量映射；无代理时返回空对象
 */
export function collectProxyEnv(explicit?: string): Record<string, string> {
  const proxy = explicit ?? process.env.DSH_REMOTE_PROXY;
  // 空串与 undefined 同等对待：空代理 URL 无意义，注入反而会让子进程解析失败
  if (proxy === undefined || proxy === '') return {};
  return {
    http_proxy: proxy,
    HTTP_PROXY: proxy,
    https_proxy: proxy,
    HTTPS_PROXY: proxy,
    ALL_PROXY: proxy,
    all_proxy: proxy,
  };
}

/**
 * 判断单个环境变量键名是否安全（合法字符集且非保留键）。
 *
 * session 层与 plugin 层共用的单一判定来源。
 *
 * @param key - 环境变量键名
 * @returns 安全返回 true
 */
export function isSafeEnvKey(key: string): boolean {
  return ENV_KEY_PATTERN.test(key) && !RESERVED_REMOTE_ENV_KEYS.includes(key);
}

/**
 * 校验一组用户自定义环境变量的键名，非法即抛错。
 *
 * 值由 remote-process.ts 的 `quote()` 转义，键名没有这道防线——本函数就是
 * 键名侧的注入防线。凭据占位键（`credential.remoteEnv()` 的 `DEEPSEEK_API_KEY`
 * 等）不在校验范围：它们的键名来自路由配置而非用户 env 输入。
 *
 * @param env - 待注入的用户自定义环境变量
 * @param context - 错误消息定位前缀（调用方拼好主机别名等上下文）
 * @throws RemoteError('EXEC_FAILED') 键名非法或撞保留键
 */
export function assertSafeEnvKeys(env: Record<string, string>, context: string): void {
  for (const key of Object.keys(env)) {
    if (!ENV_KEY_PATTERN.test(key)) {
      throw new RemoteError(
        'EXEC_FAILED',
        `${context}：环境变量名 '${key}' 非法（只允许字母、数字、下划线，且不以数字开头）——`
          + '键名会直接拼进远端启动命令，拒绝它是命令注入防线',
      );
    }
    if (RESERVED_REMOTE_ENV_KEYS.includes(key)) {
      throw new RemoteError(
        'EXEC_FAILED',
        `${context}：环境变量名 '${key}' 是保留键（DSH_HOME/DSH_AGENTS_HOME 参与会话隔离契约，`
          + 'PATH 由启动器管理），不允许用户覆盖',
      );
    }
  }
}

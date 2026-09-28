/**
 * @file 代理凭据材料读写
 * @description 会话级代理令牌与反向端口的远端落盘读写。
 *
 * 凭据材料随会话固定，存储在远端 `.runtime/` 目录下（令牌文件 600 权限）。
 * 无论哪个本机视图重连、复用会话还是重启 CLI，读回的都是同一组值，
 * 保证代理校验通过且 baseURL patch 保持一致。
 *
 * 分层约束：本文件属能力层（credential/），只依赖传输层与基础层，
 * 不得 import 编排层（session/）。
 */

import type { RemoteContext } from '../provision/remote-context.js';
import { quote } from '../util/shell-quote.js';

/** 随会话固定的凭据材料（远端 `.runtime/` 落盘的那组值） */
export interface ProxySecret {
  /** 代理令牌（远端占位凭据） */
  token: string;
  /** 反向隧道监听端口 */
  reversePort: number;
}

/**
 * 读回会话的凭据材料。
 *
 * @param ctx - 远端执行上下文
 * @param sessionId - 会话 id
 * @returns 材料；任一文件缺失或非法时 undefined
 */
export async function readProxySecret(
  ctx: RemoteContext,
  sessionId: string,
): Promise<ProxySecret | undefined> {
  const { transport, paths } = ctx;
  const tokenFile = paths.sessionProxyTokenFile(sessionId);
  const portFile = paths.sessionReversePortFile(sessionId);
  const script = [
    `[ -f ${quote(tokenFile)} ] && [ -f ${quote(portFile)} ] || exit 0`,
    `printf 'TOKEN=%s\\n' "$(cat ${quote(tokenFile)})"`,
    `printf 'PORT=%s\\n' "$(cat ${quote(portFile)})"`,
  ].join('\n');

  const result = await transport.exec(script, { allowNonZeroExit: true });
  const token = /^TOKEN=(.+)$/m.exec(result.stdout)?.[1]?.trim();
  const portText = /^PORT=(\d+)$/m.exec(result.stdout)?.[1];
  if (!token || !portText) return undefined;
  const port = Number.parseInt(portText, 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65_535) return undefined;
  return { token, reversePort: port };
}

/**
 * 落盘会话的凭据材料。
 *
 * 令牌文件以 umask 077 创建（仅会话属主可读）。它只是代理共享密钥，
 * 不是真实 API key；残余风险与 PLAN 4.5 节的既有评估一致
 * （同权限用户本就能读进程环境拿到它）。
 *
 * @param ctx - 远端执行上下文
 * @param sessionId - 会话 id
 * @param secret - 凭据材料
 */
export async function writeProxySecret(
  ctx: RemoteContext,
  sessionId: string,
  secret: ProxySecret,
): Promise<void> {
  const { transport, paths } = ctx;
  const tokenFile = paths.sessionProxyTokenFile(sessionId);
  const portFile = paths.sessionReversePortFile(sessionId);
  // 令牌值不打印到任何日志；这里只写文件
  const script = [
    `umask 077`,
    `printf '%s' ${quote(secret.token)} > ${quote(tokenFile)}`,
    `printf '%s' ${quote(String(secret.reversePort))} > ${quote(portFile)}`,
  ].join('\n');
  await transport.exec(script, { allowNonZeroExit: true });
}

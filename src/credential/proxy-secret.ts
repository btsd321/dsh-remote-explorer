/**
 * @file 代理凭据材料读写
 * @description 会话级代理令牌、反向端口与反向端点主机的远端落盘读写，
 *              以及机器级占位账号凭据（base/.credentials.yaml）的写入。
 *
 * 凭据材料随会话固定，存储在远端 `.runtime/` 目录下（令牌文件 600 权限）。
 * 无论哪个本机视图重连、复用会话还是重启 CLI，读回的都是同一组值，
 * 保证代理校验通过且 baseURL patch 保持一致。
 *
 * 反向端点主机（reverse-host）是唯一**不**随会话固定的材料：WSL NAT 模式
 * 的网关 IP 随 WSL 重启变化，每次连接/重连都重探测重写；文件缺失或读取
 * 失败时消费方回落 `127.0.0.1`（与 handoff 组件的向后兼容契约）。SSH 会话
 * 恒为 `127.0.0.1`，不写该文件。
 *
 * 分层约束：本文件属能力层（credential/），只依赖传输层与基础层，
 * 不得 import 编排层（session/）。
 */

import type { RemoteContext } from '../provision/remote-context.js';
import { writeRemoteTextFile } from '../transport/write-text.js';
import { isValidIpv4 } from '../util/ipv4.js';
import { quote } from '../util/shell-quote.js';

/**
 * 反向端点主机的默认值（SSH 恒 127.0.0.1；WSL mirrored 同值）。
 *
 * 合法性判据（严格 IPv4 点分形式）收口在 util/ipv4 的 isValidIpv4——
 * 该值会拼进远端 YAML 的 baseURL 与命令行材料，只接受无 shell/YAML 元
 * 字符可能的形态，从读取侧堵住手工编辑/损坏文件注入。
 */
const DEFAULT_REVERSE_HOST = '127.0.0.1';

/** 随会话固定的凭据材料（远端 `.runtime/` 落盘的那组值） */
export interface ProxySecret {
  /** 代理令牌（远端占位凭据） */
  token: string;
  /** 反向隧道监听端口 */
  reversePort: number;
  /**
   * 反向端点主机地址（远端 dsh 回连本机的目标）。
   * SSH 恒 '127.0.0.1'；WSL NAT 模式为默认路由网关 IP（随 WSL 重启可能
   * 变化，每次连接重探测）；mirrored 模式为 '127.0.0.1'。材料文件缺失
   * 或非法时读取方回落默认值。
   */
  reverseHost: string;
}

/**
 * 读回会话的凭据材料。
 *
 * 令牌与端口是成立条件（任一文件缺失或非法即整体 undefined，触发重新
 * 生成）；反向端点主机缺失或非法只回落默认值——它是「每次连接重写」的
 * 派生材料，不该让凭据路径整体失效。
 *
 * @param ctx - 远端执行上下文
 * @param sessionId - 会话 id
 * @returns 材料；令牌或端口文件缺失/非法时 undefined
 */
export async function readProxySecret(
  ctx: RemoteContext,
  sessionId: string,
): Promise<ProxySecret | undefined> {
  const { transport, paths } = ctx;
  const tokenFile = paths.sessionProxyTokenFile(sessionId);
  const portFile = paths.sessionReversePortFile(sessionId);
  const hostFile = paths.sessionReverseHostFile(sessionId);
  // reverse-host 缺失时回落默认值（`|| echo` 兜住文件不存在的 cat 错误）
  const script = [
    `[ -f ${quote(tokenFile)} ] && [ -f ${quote(portFile)} ] || exit 0`,
    `printf 'TOKEN=%s\\n' "$(cat ${quote(tokenFile)})"`,
    `printf 'PORT=%s\\n' "$(cat ${quote(portFile)})"`,
    `printf 'HOST=%s\\n' "$(cat ${quote(hostFile)} 2>/dev/null || echo ${quote(DEFAULT_REVERSE_HOST)})"`,
  ].join('\n');

  const result = await transport.exec(script, { allowNonZeroExit: true });
  const token = /^TOKEN=(.+)$/m.exec(result.stdout)?.[1]?.trim();
  const portText = /^PORT=(\d+)$/m.exec(result.stdout)?.[1];
  if (!token || !portText) return undefined;
  const port = Number.parseInt(portText, 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65_535) return undefined;
  const hostText = /^HOST=(.*)$/m.exec(result.stdout)?.[1]?.trim();
  const reverseHost = hostText !== undefined && isValidIpv4(hostText)
    ? hostText
    : DEFAULT_REVERSE_HOST;
  return { token, reversePort: port, reverseHost };
}

/**
 * 落盘会话的凭据材料。
 *
 * 令牌文件以 umask 077 创建（仅会话属主可读）。它只是代理共享密钥，
 * 不是真实 API key；残余风险与 PLAN 4.5 节的既有评估一致
 * （同权限用户本就能读进程环境拿到它）。
 *
 * 只写令牌与端口（随会话固定的那组值）；反向端点主机是每次连接重写的
 * 派生材料，走 {@link writeSessionReverseHost}。
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

/**
 * 落盘会话的反向端点主机。
 *
 * 每次连接/重连都重写：NAT 网关 IP 随 WSL 重启变化，落盘值必须跟上探测
 * 结果（远端 dsh 与 handoff 组件按文件值回连）。内容为单行主机地址
 * （带尾随换行，与 owner 文件同款约定，消费方读取时自行 trim）。
 *
 * 写失败**不**静默：该文件是 NAT 模式下反向链路的成立条件（缺失时消费方
 * 回落 127.0.0.1，NAT 下必不通），失败要让会话打开流程直接暴露。
 *
 * @param ctx - 远端执行上下文
 * @param sessionId - 会话 id
 * @param host - 反向端点主机（必须是合法 IPv4）
 * @throws Error host 非法 IPv4
 * @throws RemoteError 写入命令失败
 */
export async function writeSessionReverseHost(
  ctx: RemoteContext,
  sessionId: string,
  host: string,
): Promise<void> {
  if (!isValidIpv4(host)) {
    throw new Error(`反向端点主机必须是合法 IPv4，实际为 ${host || '(空)'}`);
  }
  const { transport, paths } = ctx;
  const hostFile = paths.sessionReverseHostFile(sessionId);
  const script = `printf '%s\\n' ${quote(host)} > ${quote(hostFile)}`;
  await transport.exec(script);
}

/**
 * 写入机器级占位账号凭据（`base/.credentials.yaml`，DSH_HOME = base）。
 *
 * 仅本机已登录 DeepSeek 账号时调用：写一条占位 grant record（token = 代理
 * 令牌，issuer = 平台 origin）让远端 dsh 的 `deepseek-account-platform`
 * 插件认为已登录，`resolveToken` 返回占位令牌——请求带 `x-dsh-auth-token`
 * 头经隧道回到本机代理，替换为真实 account token 转发上游。真实 token
 * 全程不出本机。
 *
 * 契约与幂等性：
 * - **issuer 必须与会话 patch 的 platformOrigin 一致**——dsh 的
 *   `Service.init` 检查 `issuer === this.origin`，不匹配会丢弃 record
 * - 每次连接重写（同值幂等）；record 被 dsh 因上游 401 删除后，下次
 *   连接也能借此恢复
 * - 值域受限（base64url 令牌、`http://host:port` origin），无 YAML 元
 *   字符注入面，直接拼 YAML 安全
 * - 文件权限 600（与真实 credentials.yaml 同权限）；SFTP 主路径带
 *   mode，回退 exec 后补 chmod
 *
 * @param ctx - 远端执行上下文
 * @param token - 代理令牌（占位凭据值）
 * @param issuer - 平台 origin（= 会话 patch 的 platformOrigin，纯 origin 不含路径）
 * @throws RemoteError 两条写入路径（SFTP / exec）都失败
 */
export async function writePlaceholderAccountCredentials(
  ctx: RemoteContext,
  token: string,
  issuer: string,
): Promise<void> {
  const { transport, paths } = ctx;
  const credYaml = [
    'version: 1',
    'records:',
    '  deepseek-account-platform/default:',
    '    kind: grant',
    '    payload:',
    '      version: 1',
    `      token: ${token}`,
    `      issuer: ${issuer}`,
    '',
  ].join('\n');
  try {
    await transport.writeRemoteFile(paths.credentialsFile, credYaml, { mode: 0o600 });
  } catch {
    // SFTP 不可用（个别加固 sshd 关闭 sftp 子系统）回退 exec；写入内容为
    // 定长结构 YAML，printf 重定向无长度风险
    await writeRemoteTextFile(transport, paths.credentialsFile, credYaml);
    await transport.exec(`chmod 600 ${quote(paths.credentialsFile)}`, { allowNonZeroExit: true });
  }
}

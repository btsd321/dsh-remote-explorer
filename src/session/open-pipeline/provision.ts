/**
 * @file 打开流水线·引导与配置阶段
 * @description open() 流水线的第三阶段：凭据策略实例化、provision（幂等）、
 *              handoff 组件安装、会话接入主机级 plugin store、settings 双写、
 *              新凭据材料落盘。
 *
 * 所有序列约束（所有反向端点相关落盘必须先于远端 dsh 启动完成——启动后的
 * 进程消费的就是这批材料）详见 provisionAndConfigure 的函数注释。
 *
 * 原为 session-manager.ts 的 RemoteSession 私有静态方法，拆分后为同层
 * 导出函数。
 *
 * 分层：本文件属编排层（session/open-pipeline/ 子目录），向下使用能力层
 * （provision 引导与 profile 接线、credential 凭据策略与材料落盘）、
 * 同层模块（wsl-reverse 的凭据镜像双写）与传输层。
 */

import { provision } from '../../provision/provisioner.js';
import { installHandoffBundle } from '../../provision/handoff-installer.js';
import {
  attachSessionProfile, syncHostProfileManifest, transportIo,
} from '../../provision/plugin-store.js';
import { readLocalCredentials } from '../../credential/local-credentials.js';
import { TunnelProxyCredential } from '../../credential/tunnel-proxy.js';
import {
  deepseekRoute, extractProviderRoutes, readLocalSettings,
} from '../../credential/provider-routes.js';
import { writeProxySecret, writeSessionReverseHost } from '../../credential/proxy-secret.js';
import { writeTunnelCredentialMirrors } from '../wsl-reverse.js';
import { toErrorMessage } from '../../util/errors.js';
import type { RemoteTransport } from '../../transport/types.js';
import type { OpenSessionOptions } from '../options.js';
import type { ProbeStageContext, ProvisionStageContext } from './prepare.js';
import type { RemoteContext } from '../../provision/remote-context.js';

/**
 * 引导远端环境、构造凭据策略、同步配置并落盘新凭据材料。
 *
 * 包含：凭据策略实例化、provision（幂等）、handoff 组件安装、
 * 会话接入 store、settings 双写、新凭据材料落盘。所有反向端点相关
 * 落盘（reverse-host、patch、settings 镜像）都在远端 dsh 启动之前
 * 完成——启动后的进程消费的就是这批材料。
 *
 * @param transport - 已连接的传输实例
 * @param sessionId - 会话 id
 * @param options - 会话打开选项
 * @param probeCtx - 探测上下文
 * @returns 引导结果与凭据策略实例
 */
export async function provisionAndConfigure(
  transport: RemoteTransport,
  sessionId: string,
  options: OpenSessionOptions,
  probeCtx: Pick<ProbeStageContext, 'paths' | 'secret' | 'secretIsNew' | 'reversePortChanged'>,
): Promise<ProvisionStageContext> {
  const { paths, secret, secretIsNew, reversePortChanged } = probeCtx;
  const ctx: RemoteContext = { transport, paths };
  const isWsl = options.transportType === 'wsl';

  // 4. 凭据策略实例。构造便宜（不起监听），放在引导之前——
  //    环境注入、patch 条目与 settings 镜像都从它取，编排层不重复拼细节。
  //    路由表 = DeepSeek 原生通道 + 本机 settings.yaml 里的 pi-ai 供应商
  //    （用户的默认模型可能配置在后者）
  //    本机凭据从 .credentials.yaml 读取，作为 process.env 的回退源——
  //    对齐 dsh 自身的凭据解析优先级（文件存储 > 环境变量缺失时兜底）
  const localSettings = readLocalSettings();
  const providerRoutes = localSettings ? extractProviderRoutes(localSettings) : [];
  const localCredentials = readLocalCredentials();
  const credential = secret
    ? new TunnelProxyCredential(
      secret.token, secret.reversePort, secret.reverseHost,
      [deepseekRoute(), ...providerRoutes],
      options.hostAlias,
      localCredentials,
      ...(options.manageHandlers ? [options.manageHandlers] : []),
    )
    : undefined;

  // 5. 引导（幂等）。patch 让 DeepSeek 原生通道的 baseURL 指向反向端口——
  //    secret 存在就写，复用与新建 alike：prepareSessionProfile 每次重写
  //    patch，反向端口来自同一份落盘材料，值保持一致
  const provisioned = await provision(transport, {
    sessionId,
    patches: credential?.remotePatches() ?? [],
    ...(options.nodeVersion ? { nodeVersion: options.nodeVersion } : {}),
    ...(options.dshVersion ? { dshVersion: options.dshVersion } : {}),
    ...(options.refreshMirrors ? { refreshMirrors: true } : {}),
    ...(options.onStageStart ? { onStageStart: options.onStageStart } : {}),
    ...(options.onStageDone ? { onStageDone: options.onStageDone } : {}),
    ...(options.onStageSkip ? { onStageSkip: options.onStageSkip } : {}),
  });

  // 5.5 handoff 组件（幂等，store 级）：合成 bundle 写进用户级 plugin store
  //     并登记启用——该远程账号的所有会话共享这一份，新会话零额外安装。
  //     老会话补装时若远端进程仍存活复用，菜单要等下次远端重启才出现。
  //     安装失败不阻断会话（增强面非成立条件）
  options.onStageStart?.('检查远端交接组件');
  try {
    const installed = await installHandoffBundle(ctx, provisioned.dsh.version);
    options.onStageDone?.(installed ? '已安装交接组件（远端窗口获得管理菜单）' : '交接组件已就位');
  } catch (error) {
    options.onStageSkip?.(`交接组件安装失败（不影响会话）：${toErrorMessage(error)}`);
  }

  // 5.6 会话接入主机级 profile（必须在远端启动前）：session profile 整体
  //     symlink 到 host profile + manifest 自愈。dsh 启动时 --profile web
  //     在 $DSH_HOME/profiles/web/ 找到 symlink，指向主机级共享安装
  await attachSessionProfile(ctx, sessionId);
  await syncHostProfileManifest(transportIo(transport), paths);

  // 6. settings 双写：本机 settings 整体复制到会话 DSH_HOME + pi-ai 供应商
  //    路由写进 home patch 层（`$DSH_HOME/cordis.patch.yml`）。文件语义与
  //    容忍语义（失败不阻断）收口在 wsl-reverse 的 writeTunnelCredentialMirrors
  //    ——与重连路径（refreshWslReverseOnReconnect）共用同一实现，本处只
  //    决定「何时写、写哪个端点」。baseURL 的 host 用 secret.reverseHost
  //    （SSH 恒 127.0.0.1 不变；WSL NAT 为网关 IP）
  if (secret && localSettings) {
    await writeTunnelCredentialMirrors(ctx, {
      sessionId,
      reversePort: secret.reversePort,
      reverseHost: secret.reverseHost,
      localSettings,
    });
  }

  // 6.5 WSL：反向端点 host 每次连接都重写（NAT 网关随 WSL 重启变化；
  //     材料必须与本次探测结果一致，远端 dsh / handoff 组件按文件值回连）。
  //     SSH 不写该文件——消费方按契约回落 127.0.0.1，SSH 路径行为不变
  if (secret && isWsl) {
    await writeSessionReverseHost(ctx, sessionId, secret.reverseHost);
  }

  // 7. 凭据材料落盘（600 权限）。之后无论哪个视图重连都读回同一组值。
  //    新建材料照旧；WSL 幽灵占用换端口（reversePortChanged）时也重写——
  //    patch 已带新端口，反向端口文件必须跟上，否则下次连接读回旧值
  if (secret && (secretIsNew || reversePortChanged)) {
    await writeProxySecret(ctx, sessionId, secret);
  }

  return { provisioned, credential };
}

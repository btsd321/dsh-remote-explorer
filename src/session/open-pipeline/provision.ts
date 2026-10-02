/**
 * @file 打开流水线·引导与配置阶段
 * @description open() 流水线的第三阶段：凭据策略实例化、provision（幂等）、
 *              handoff 组件安装、会话接入主机级 plugin store、机器级 credentials.yaml
 *              写入、新凭据材料落盘。
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
  syncHostProfileManifest, transportIo,
} from '../../provision/plugin-store.js';
import { readLocalCredentials, readLocalAccountToken } from '../../credential/local-credentials.js';
import { TunnelProxyCredential } from '../../credential/tunnel-proxy.js';
import {
  deepseekRoute, extractProviderRoutes, readLocalSettings,
  renderProviderTunnelPatch,
} from '../../credential/provider-routes.js';
import { writeProxySecret, writePlaceholderAccountCredentials, writeSessionReverseHost } from '../../credential/proxy-secret.js';
import { quote } from '../../util/shell-quote.js';
import { toErrorMessage } from '../../util/errors.js';
import { createLogger } from '../../util/logger.js';
import type { PatchEntry } from '../../provision/profile-writer.js';
import type { RemoteTransport } from '../../transport/types.js';
import type { OpenSessionOptions } from '../options.js';
import type { ProbeStageContext, ProvisionStageContext } from './prepare.js';
import type { RemoteContext } from '../../provision/remote-context.js';

const log = createLogger('open-pipeline-provision');

/**
 * 引导远端环境、构造凭据策略、同步配置并落盘新凭据材料。
 *
 * 包含：凭据策略实例化、provision（幂等）、handoff 组件安装、
 * 会话接入 store、机器级 credentials.yaml 写入、新凭据材料落盘。
 * 所有反向端点相关落盘（reverse-host、patch、credentials.yaml）
 * 都在远端 dsh 启动之前完成——启动后的进程消费的就是这批材料。
 *
 * DSH_HOME = base（机器级），所有会话共享。patch 文件在
 * `sessions/<id>/.runtime/patch.yml`（会话隔离），通过 `--patch` 参数传入。
 * credentials.yaml 在 `base/.credentials.yaml`（机器级共享）。
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
  //    环境注入、patch 条目都从它取，编排层不重复拼细节。
  //    路由表 = DeepSeek 原生通道 + 本机 settings.yaml 里的 pi-ai 供应商
  //    （用户的默认模型可能配置在后者）
  //    本机凭据从 .credentials.yaml 读取，作为 process.env 的回退源——
  //    对齐 dsh 自身的凭据解析优先级（文件存储 > 环境变量缺失时兜底）
  //    accountToken 同样从 .credentials.yaml 的 records 段读取——它是
  //    DeepSeek 账号的 OAuth grant token，与 refs 段的 DEEPSEEK_API_KEY
  //    在安全层面等价（都是模型调用认证密钥），走同一隧道代理替换，不出本机
  const localSettings = readLocalSettings();
  const providerRoutes = localSettings ? extractProviderRoutes(localSettings) : [];
  const localCredentials = readLocalCredentials();
  const accountToken = readLocalAccountToken();
  if (accountToken !== undefined) {
    log.info('本机已登录 DeepSeek 账号，account token 通道可用', { hostAlias: options.hostAlias });
  }
  const credential = secret
    ? new TunnelProxyCredential(
      secret.token, secret.reversePort, secret.reverseHost,
      [deepseekRoute(), ...providerRoutes],
      options.hostAlias,
      localCredentials,
      // manageHandlers 直接传（undefined 落到可选参数位）——**不能用条件
      // 展开**：`...(x ? [x] : [])` 在 x 缺席时会把它后面的 accountToken
      // 挤进 manage 参数位（CLI 形态不传 manageHandlers，曾因此把账号
      // token 错塞进 manage、accountToken 位落空——代理对账号通道一律
      // 报「本机未登录 DeepSeek 账号」502）
      options.manageHandlers,
      accountToken,
    )
    : undefined;

  // 5. 引导（幂等）。标量 patch 条目（llm-deepseek / llm-deepseek-account 的
  //    baseURL 重定向）合并写入 sessions/<id>/.runtime/patch.yml，通过 --patch 参数传入。
  //    pi-ai 供应商路由（含 providers 嵌套结构）走独立追加路径（下方第 6 步），
  //    因为 provisioner 的 renderPatchYaml 只支持标量 config 字段。
  const patches: PatchEntry[] = credential?.remotePatches() ?? [];

  const provisioned = await provision(transport, {
    sessionId,
    patches,
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

  // 5.6 profile manifest 自愈（必须在远端启动前）。DSH_HOME = base，
  //     dsh 启动时 --profile web 直接读 base/profiles/web/，
  //     不再需要会话级 symlink。
  await syncHostProfileManifest(transportIo(transport), paths);

  // 6. pi-ai 供应商路由 patch：追加到会话 patch 文件（.runtime/patch.yml）末尾。
  //    pi-ai 的 patch 结构含 providers 嵌套对象，provisioner 的 renderPatchYaml
  //    只支持标量 config 字段——所以 pi-ai patch 走独立追加路径，追加到
  //    provisioner 已写的标量 patch（llm-deepseek/llm-deepseek-account）之后。
  //    **必须用 >> 追加，不能用 writeRemoteTextFile（覆盖写入）**——后者会
  //    把 provisioner 写的标量 patch 全部覆盖掉。
  //    baseURL 的 host 用 secret.reverseHost（SSH 恒 127.0.0.1；WSL NAT 为网关 IP）
  if (secret && localSettings) {
    const piAiPatch = renderProviderTunnelPatch(localSettings, secret.reversePort, secret.reverseHost);
    if (piAiPatch !== undefined) {
      try {
        const patchFile = paths.sessionPatchFile(sessionId);
        // 用 printf 追加（>> 重定向），不覆盖 provisioner 已写的标量 patch
        await transport.exec(`printf '\\n%s' ${quote(piAiPatch)} >> ${quote(patchFile)}`, { allowNonZeroExit: true });
      } catch (error) {
        options.onStageSkip?.(`pi-ai 供应商路由写入失败（不影响其他通道）：${toErrorMessage(error)}`);
      }
    }
  }

  // 6.1 机器级 credentials.yaml（`base/.credentials.yaml`，仅本机已登录 DeepSeek 账号时写入）。
  //     DSH_HOME = base，dsh 的 credentials-local 包从 $DSH_HOME/.credentials.yaml 读取。
  //     写入占位 grant record 让远端插件认为已登录（契约与幂等语义见
  //     writePlaceholderAccountCredentials 的函数注释）；真实 token 不出本机。
  //     机器级共享：所有会话共用同一份，每次连接都重写（同值幂等）。
  if (secret && accountToken !== undefined) {
    // issuer 必须与 remotePatches() 中 platform patch 的 platformOrigin 一致——
    // 隧道代理地址（http://<reverseHost>:<reversePort>，不含路径）
    const issuer = `http://${secret.reverseHost}:${secret.reversePort}`;
    try {
      await writePlaceholderAccountCredentials(ctx, secret.token, issuer);
      log.info('机器级占位 credentials.yaml 已写入', { hostAlias: options.hostAlias });
    } catch (error) {
      // 写失败不阻断会话——account 通道不可用，但 API key 通道不受影响
      options.onStageSkip?.(`远端占位凭据写入失败（account 通道不可用）：${toErrorMessage(error)}`);
    }
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

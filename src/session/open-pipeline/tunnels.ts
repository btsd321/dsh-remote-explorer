/**
 * @file 打开流水线·隧道阶段
 * @description open() 流水线的第五阶段（setupTunnels）：启动本机 LLM 凭据
 *              代理、按传输类型挂反向转发（WSL 接 ReverseListener，SSH 走
 *              transport.forwardIn）、建正向隧道。
 *
 *              同时承载远端 dsh 进程启动（launch，open 流水线第四阶段的
 *              启动分支与重连重启共用）与 SSH 反向转发挂接
 *              （attachReverseForward）——三者都是「以传输实例为轴的
 *              隧道/进程接线」，收在同一文件。
 *
 * 原为 session-manager.ts 的 RemoteSession 私有静态方法与模块级私有函数，
 * 拆分后为同层导出。
 *
 * 分层：本文件属编排层（session/open-pipeline/ 子目录），向下使用能力层
 * （tunnel 正向转发与端口分配、credential 凭据代理）、同层模块
 * （wsl-reverse 的反向链路自检、proxy-env 的环境合并、remote-process 的
 * 进程启动）与传输层。
 */

import { LocalForward } from '../../tunnel/forward-local.js';
import { allocateRemotePorts } from '../../tunnel/port-allocator.js';
import { startRemoteDsh } from '../remote-process.js';
import { assertSafeEnvKeys, collectProxyEnv } from '../proxy-env.js';
import { checkWslReverseLink } from '../wsl-reverse.js';
import { RemoteError, toErrorMessage } from '../../util/errors.js';
import { createLogger } from '../../util/logger.js';
import type { ReverseHandle, RemoteTransport } from '../../transport/types.js';
import type { OpenSessionOptions } from '../options.js';
import type { ProvisionResult } from '../../provision/provisioner.js';
import type { TunnelProxyCredential } from '../../credential/tunnel-proxy.js';
import type { RemoteProcessInfo } from '../remote-process.js';
import type { ReverseListener } from '../../tunnel/reverse-listener.js';

const log = createLogger('open-pipeline-tunnels');

/**
 * 建立隧道：启动凭据代理、挂反向转发、建正向隧道。
 *
 * 反向转发按传输类型分流：WSL 向会话持有的 ReverseListener 挂凭据
 * handler（监听在分配阶段已建立，这里只是接线，且挂接后立刻做反向链路
 * 自检）；SSH 维持 transport.forwardIn 不变。
 *
 * @param transport - 已连接的传输实例
 * @param options - 会话打开选项
 * @param processInfo - 远端进程信息
 * @param credential - 凭据代理实例；undefined 表示不带凭据路径
 * @param reverseListener - WSL 反向监听器（分配阶段绑定）；SSH 路径为 undefined
 * @returns 正向隧道与反向转发句柄（WSL 后者恒 undefined——监听器即句柄）
 */
export async function setupTunnels(
  transport: RemoteTransport,
  options: OpenSessionOptions,
  processInfo: RemoteProcessInfo,
  credential: TunnelProxyCredential | undefined,
  reverseListener: ReverseListener | undefined,
): Promise<{ forward: LocalForward; reverseHandle: ReverseHandle | undefined }> {
  // 9. 起本机 LLM 代理并挂反向转发
  let reverseHandle: ReverseHandle | undefined;
  if (credential) {
    log.info('步骤9: 启动密钥代理');
    options.onStageStart?.('启动密钥代理');
    await credential.start();
    log.info('步骤9: 代理已启动，开始挂反向转发', { reversePort: credential.reversePort });

    if (reverseListener !== undefined) {
      // WSL：向会话持有的监听器挂凭据 handler。分配阶段绑定的监听对
      // 杂散连接一律销毁，挂接后到达的连接才被代理接管
      reverseListener.setHandler((connection) => {
        credential.handleReverseConnection(connection.stream);
      });
      log.info('步骤9: WSL 反向监听已挂接凭据代理', {
        hosts: reverseListener.hosts.join(','),
        port: reverseListener.port,
      });
      // 反向链路自检（可观测性是硬要求）：从 WSL 内探测反向端点，
      // 拿到任何 HTTP 状态码即证明链路通；不通则 warn + 面板可见
      await checkWslReverseLink(transport, credential, options);
    } else {
      reverseHandle = await attachReverseForward(transport, credential, options);
    }

    log.info('步骤9完成: 反向转发已挂载');
    const missing = credential.missingKeyEnvs;
    if (missing.length === 0) {
      options.onStageDone?.(
        `反向端口 ${credential.reversePort} → 本机代理（${credential.routeCount} 条路由）`,
      );
    } else {
      options.onStageDone?.(
        `反向端口 ${credential.reversePort} → 本机代理（${credential.routeCount} 条路由；`
        + `本机缺 key：${missing.join('、')}）`,
      );
    }
  }

  // 10. 建正向隧道。监听器跨重连存活，端口从此不再变化；
  //     转发失败告警经钩子上抛（插件形态接日志缓冲；CLI 缺省直写 stderr）
  log.info('步骤10: 建立正向隧道');
  options.onStageStart?.('建立正向隧道');
  const forward = new LocalForward(transport, '127.0.0.1', processInfo.port, {
    ...(options.onForwardError ? { onForwardError: options.onForwardError } : {}),
  });
  const localPort = await forward.listen(options.localPort ?? 0);
  log.info('步骤10完成: 正向隧道就绪', { localPort, remotePort: processInfo.port });
  options.onStageDone?.(`127.0.0.1:${localPort} → 远端 ${processInfo.port}`);

  return { forward, reverseHandle };
}

/**
 * 启动远端 dsh。
 *
 * 端口分配有固有竞态（探到空闲与实际绑定之间存在窗口），
 * 所以失败后换端口重试一次。
 *
 * 环境注入三层合并（后者覆盖前者同名键，**仅 SSH 有代理层**）：
 * `collectProxyEnv(options.proxy)`（面板代理显式值，`DSH_REMOTE_PROXY`
 * 环境变量兜底）< `options.extraEnv`（面板环境变量）< `credential.remoteEnv()`
 * （凭据占位键最高优先，防被用户 env 覆盖导致远端报 MISSING_CREDENTIAL）。
 * WSL 连接**无代理层**——即使宿主进程设了 `DSH_REMOTE_PROXY` 也不注入：
 * 该变量是为 SSH 远端装插件走代理设计的，WSL 内出网语义不同（NAT/镜像
 * 模式直连宿主网络），代理键塞进 WSL 进程只会得到错误路由。
 *
 * @param transport - 传输实例
 * @param provisioned - 引导结果
 * @param sessionId - 会话 id
 * @param options - 打开选项（进度回调、传输形态、代理、用户自定义 env 与 WSL 用户名）
 * @param port - 预分配的 web 端口
 * @param credential - 凭据策略；存在则占位凭据进环境
 * @returns 远端进程信息
 * @throws RemoteError('EXEC_FAILED') 用户 env 键名非法或启动失败
 */
export async function launch(
  transport: RemoteTransport,
  provisioned: ProvisionResult,
  sessionId: string,
  options: Pick<OpenSessionOptions, 'onStageStart' | 'onStageDone' | 'transportType' | 'proxy' | 'extraEnv' | 'wslUser'>,
  port: number,
  credential: TunnelProxyCredential | undefined,
): Promise<RemoteProcessInfo> {
  // 合并前先校验用户 env 的键名：remote-process.ts 的 envAssignments 把
  // 键名不经 quote 直接插值进 shell 命令，非法键名 = 命令注入；保留键
  // （DSH_HOME/DSH_AGENTS_HOME/PATH）被用户值覆盖会破坏会话隔离与技能共享契约
  assertSafeEnvKeys(options.extraEnv ?? {}, `主机 ${transport.hostAlias}`);
  const extraEnv: Record<string, string> = {
    // 代理层仅 SSH：WSL 连接切断 DSH_REMOTE_PROXY 兜底（见函数 JSDoc）
    ...(options.transportType === 'ssh' ? collectProxyEnv(options.proxy) : {}),
    ...(options.extraEnv ?? {}),
    ...(credential ? credential.remoteEnv() : {}),
  };
  // 只打键名不打值：值可能含代理认证信息或敏感 token
  const injectedEnvKeys = Object.keys(extraEnv);
  if (injectedEnvKeys.length > 0) {
    log.info('将注入远端 dsh 的环境变量', {
      hostAlias: transport.hostAlias,
      keys: injectedEnvKeys.join(','),
    });
  }

  const tried: number[] = [port];
  let lastError: unknown;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    options.onStageStart?.(`启动远端 dsh（端口 ${port}）`);
    try {
      const info = await startRemoteDsh({ transport, paths: provisioned.paths }, {
        sessionId,
        dshBin: provisioned.dsh.dshBin,
        dshHome: provisioned.profile.dshHome,
        profileName: provisioned.profile.profileName,
        nodeBinDir: provisioned.node.binDir,
        port,
        ...(provisioned.profile.patchFile ? { patchFile: provisioned.profile.patchFile } : {}),
        ...(Object.keys(extraEnv).length > 0 ? { extraEnv } : {}),
        // WSL 用户名透传：远端 dsh 必须与 probe/安装用同一用户跑，否则
        // .runtime 材料（600 权限）属主错位，远端进程读不回凭据材料
        ...(options.wslUser !== undefined ? { wslUser: options.wslUser } : {}),
      });
      options.onStageDone?.(`pid ${info.pid}`);
      return info;
    } catch (error) {
      lastError = error;
      // 端口冲突是预期内的竞态，换端口重试；其他错误重试也无意义，但
      // 区分成本高于收益——第二次失败就会如实抛出
      if (attempt === 0) {
        const [next] = await allocateRemotePorts(transport, 1, { exclude: tried });
        tried.push(next!);
        port = next!;
      }
    }
  }

  throw new RemoteError(
    'EXEC_FAILED',
    `在主机 ${transport.hostAlias} 上启动远端 dsh 失败（已试端口 ${tried.join('、')}）：`
      + toErrorMessage(lastError),
    { cause: lastError, hostAlias: transport.hostAlias },
  );
}

/**
 * 把反向转发挂到指定传输上（SSH 路径）。
 *
 * 挂不上时返回 undefined 并以警告说明——同一会话的另一个本机视图
 * 先到先得持有反向端口（sshd 拒绝重复绑定），凭据路径由它维持；
 * 这里失败不代表会话不可用。但**绝不静默**：error 级日志（含主机、端口、
 * 原因）必须留痕，面板也要看到跳过说明。
 *
 * @param transport - 传输实例
 * @param credential - 凭据代理
 * @param options - 打开选项（进度回调）
 * @returns 反向转发句柄；挂不上时 undefined
 */
export async function attachReverseForward(
  transport: RemoteTransport,
  credential: TunnelProxyCredential,
  options: Pick<OpenSessionOptions, 'onStageSkip'>,
): Promise<ReverseHandle | undefined> {
  const port = credential.reversePort;
  try {
    const handle = await transport.forwardIn?.(port, (connection) => {
      credential.handleReverseConnection(connection.stream);
    });
    if (handle === undefined) {
      // 传输未实现 forwardIn（可选能力）。WSL 路径在 setupTunnels 已分流到
      // ReverseListener，走到这里说明编排接线错误——按挂接失败处理
      const message = `传输 ${transport.hostAlias} 不支持 forwardIn，反向端口 ${port} 无法挂接`
        + '（密钥代理将不可用）';
      log.error(message, { port, hostAlias: transport.hostAlias });
      options.onStageSkip?.(message);
      return undefined;
    }
    return handle;
  } catch (error) {
    // 多视图并发持有同一会话时的预期情形；也可能是 sshd 禁了 TcpForwarding。
    // 不再静默：error 日志留痕（含主机/端口/原因），面板可见跳过说明
    log.error(
      `反向端口 ${port} 挂接失败（主机 ${transport.hostAlias}）: ${toErrorMessage(error)}`,
      { port, hostAlias: transport.hostAlias },
    );
    options.onStageSkip?.(
      `反向端口 ${port} 挂接失败：可能已被同一会话的其他本机进程占用（密钥代理由它维持），`
        + '或远端 sshd 禁用了端口转发（检查 AllowTcpForwarding）',
    );
    return undefined;
  }
}

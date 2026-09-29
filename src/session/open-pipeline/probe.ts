/**
 * @file 打开流水线·探测阶段
 * @description open() 流水线的第二与第四阶段：探测远端环境（家目录/路径）、
 *              读取或生成凭据材料、准备反向端点（WSL 走「分配即绑定」）、
 *              探既有远端进程；引导完成后启动或复用远端 dsh 进程并落盘
 *              owner 指纹。
 *
 * 凭据材料读取先于进程探测——无论进程是否存活，落盘材料都可能存在
 * （契约详见各函数注释）。
 *
 * 原为 session-manager.ts 的 RemoteSession 私有静态方法，拆分后为同层
 * 导出函数。
 *
 * 分层：本文件属编排层（session/open-pipeline/ 子目录），向下使用能力层
 * （provision 探测与路径、credential 材料、tunnel 端口分配）、同层模块
 * （wsl-reverse 的 WSL 反向端点编排、remote-process 的进程探测/启动）
 * 与传输层。
 */

import { probeRemote } from '../../provision/probe.js';
import { createRemotePaths } from '../../provision/remote-paths.js';
import { generateProxyToken } from '../../credential/token.js';
import { readProxySecret } from '../../credential/proxy-secret.js';
import { allocateRemotePorts } from '../../tunnel/port-allocator.js';
import { writeRemoteTextFile } from '../../transport/write-text.js';
import { ownerFingerprint } from '../../util/owner-fingerprint.js';
import { openWslReverse } from '../wsl-reverse.js';
import { launch } from './tunnels.js';
import {
  probeExistingSession, stopRemoteDsh, type RemoteProcessInfo,
} from '../remote-process.js';
import { createLogger } from '../../util/logger.js';
import type { RemoteTransport } from '../../transport/types.js';
import type { OpenSessionOptions } from '../options.js';
import type { ProbeStageContext } from './prepare.js';
import type { RemoteContext } from '../../provision/remote-context.js';
import type { ReverseListener } from '../../tunnel/reverse-listener.js';
import type { ProvisionResult } from '../../provision/provisioner.js';
import type { TunnelProxyCredential } from '../../credential/tunnel-proxy.js';

const log = createLogger('open-pipeline-probe');

/**
 * 探测远端环境、读取/生成凭据材料、探既有进程并分配端口。
 *
 * 家目录要先拿到：既有会话探测与凭据材料读取都需要路径。
 * 凭据材料读取放在进程探测之前——无论进程是否存活，落盘材料都可能存在
 * （进程刚死待重启时，材料仍然有效且应当继续用）。
 *
 * WSL 分支的差异（SSH 路径行为不变）：反向端口由 Windows 侧
 * ReverseListener「分配即绑定」——真实 bind 成功的端口才写进会话材料，
 * 远端探测只负责 web 端口。详见 openWslReverse。
 *
 * @param transport - 已连接的传输实例
 * @param sessionId - 会话 id
 * @param options - 会话打开选项
 * @returns 探测上下文（路径、凭据材料、进程信息、web 端口、反向监听器等）
 */
export async function probeAndReadCredentials(
  transport: RemoteTransport,
  sessionId: string,
  options: OpenSessionOptions,
): Promise<ProbeStageContext> {
  const isWsl = options.transportType === 'wsl';
  // 家目录要先拿到：既有会话探测与凭据材料读取都需要路径
  const probe = await probeRemote(transport);
  log.info(`远端探测完成: homeDir=${probe.homeDir}`);
  const paths = createRemotePaths(probe.homeDir);
  const ctx: RemoteContext = { transport, paths };

  // 1. 凭据材料：读回已有的，没有则生成新的
  let secret = await readProxySecret(ctx, sessionId);

  // 2. 探既有远端进程
  if (options.forceRestart === true) {
    await stopRemoteDsh(ctx, { sessionId });
  }
  let processInfo: RemoteProcessInfo | undefined;
  if (options.forceRestart !== true) {
    processInfo = await probeExistingSession(ctx, sessionId);
  }

  if (processInfo && !secret) {
    // 会话是凭据功能上线前启动的：占位凭据没进它的环境，baseURL 也没指向代理。
    // 只降级为警告——用户可能只想要隧道；要启用凭据路径用 --force-restart
    options.onStageSkip?.('远端会话早于凭据功能启动；加 --force-restart 可启用密钥代理');
  }

  // 3. 需要凭据路径时准备反向端点。
  //    - WSL：网络模式探测 + ReverseListener 分配即绑定（首选落盘的既有
  //      reversePort——复用语义；幽灵占用绑不上则换端口并标记材料重写）
  //    - SSH：反向端口继续在远端探测分配（既有行为，一字不改）
  let webPort: number | undefined;
  let secretIsNew = false;
  let reverseListener: ReverseListener | undefined;
  let reversePortChanged = false;

  if (isWsl && (secret !== undefined || processInfo === undefined)) {
    const { listener, plan } = await openWslReverse(transport, secret?.reversePort);
    reverseListener = listener;
    const boundPort = listener.port!;
    try {
      if (secret === undefined) {
        // 新会话：绑定结果即落盘值（先绑后写——消灭探测/绑定竞态）
        secret = {
          token: generateProxyToken(),
          reversePort: boundPort,
          reverseHost: plan.reverseHost,
        };
        secretIsNew = true;
      } else if (boundPort !== secret.reversePort) {
        // 落盘端口被幽灵占用（netstat 查无监听但 bind 报 EADDRINUSE），
        // 已换新端口：更新内存值并触发材料重写。若远端进程仍在复用，
        // 它认的是旧端口的 baseURL——凭据路径在远端重启前不可用，
        // 必须显式告警而不是静默降级（主 bug 的修复点）
        reversePortChanged = true;
        const oldPort = secret.reversePort;
        secret = { ...secret, reversePort: boundPort, reverseHost: plan.reverseHost };
        if (processInfo) {
          const message = `反向端口 ${oldPort} 在 Windows 侧绑定失败（可能被 VS Code/WSL relay`
            + ` 静默保留），已换用 ${boundPort}；复用中的远端进程仍指向旧端口，`
            + '密钥代理在远端重启前不可用（加 --force-restart 可重启启用）';
          log.warn(message, { hostAlias: transport.hostAlias, oldPort, boundPort });
          options.onStageSkip?.(message);
        }
      } else {
        secret = { ...secret, reverseHost: plan.reverseHost };
      }

      // web 端口一次性分配好；排除反向端口（mirrored 模式两端共享回环，
      // 同号会真撞车；NAT 模式命名空间不同，排除只是保持一致语义）
      if (!processInfo) {
        const exclude = secret !== undefined ? [secret.reversePort] : [];
        const [web] = await allocateRemotePorts(transport, 1, { exclude });
        webPort = web;
      }
    } catch (error) {
      // 后续步骤失败时释放已绑定的监听，否则泄漏端口
      await listener.close().catch(() => { /* 关闭失败不影响错误上抛 */ });
      throw error;
    }
  } else if (!processInfo) {
    // SSH：web 与反向端口都在远端探测分配
    const exclude = secret ? [secret.reversePort] : [];
    const ports = await allocateRemotePorts(transport, secret ? 1 : 2, { exclude });
    webPort = ports[0]!;
    if (!secret) {
      secret = { token: generateProxyToken(), reversePort: ports[1]!, reverseHost: '127.0.0.1' };
      secretIsNew = true;
    }
  }

  return { paths, secret, processInfo, webPort, secretIsNew, reverseListener, reversePortChanged };
}

/**
 * 探测既有远端进程或启动新的，并落盘 owner 指纹。
 *
 * @param transport - 已连接的传输实例
 * @param sessionId - 会话 id
 * @param options - 会话打开选项
 * @param existingProcess - 既有的远端进程信息；undefined 表示需要启动
 * @param webPort - 预分配的 web 端口（仅在需要启动时使用）
 * @param provisioned - 引导结果
 * @param credential - 凭据策略；存在则占位凭据进环境
 * @returns 远端进程信息
 */
export async function probeOrStartRemote(
  transport: RemoteTransport,
  sessionId: string,
  options: OpenSessionOptions,
  existingProcess: RemoteProcessInfo | undefined,
  webPort: number | undefined,
  provisioned: ProvisionResult,
  credential: TunnelProxyCredential | undefined,
): Promise<RemoteProcessInfo> {
  let processInfo = existingProcess;

  // 8. 启动远端进程（占位凭据进环境——每条路由的 keyEnv 都是同一个令牌）
  if (!processInfo) {
    log.info('步骤8: 启动远端 dsh 进程');
    processInfo = await launch(
      transport, provisioned, sessionId, options, webPort!, credential,
    );
    log.info('步骤8完成: 远端 dsh 已启动', { port: processInfo.port, pid: processInfo.pid });
  } else {
    log.info('步骤8: 复用既有远端进程', { port: processInfo.port, pid: processInfo.pid });
  }

  // 8.5 owner 指纹落盘：kill/clean 的跨用户 scope 化凭据（非秘密）。
  //     容忍模式——写失败不阻断会话（最坏退化为「无 owner 的老目录」语义）
  log.info('步骤8.5: owner 指纹落盘');
  await writeRemoteTextFile(
    transport,
    provisioned.paths.sessionOwnerFile(sessionId),
    `${ownerFingerprint()}\n`,
    { tolerant: true },
  );

  return processInfo;
}

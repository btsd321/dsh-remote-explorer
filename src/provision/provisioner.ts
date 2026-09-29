/**
 * @file 引导流程编排
 * @description 把探测、镜像测速、装 Node、装 dsh、准备会话 profile 串成一条流程，
 *              对外只暴露一个 {@link provision} 入口。
 *
 * 编排原则：每一步都幂等且可复用已有结果——重复执行时命中已装版本就跳过，
 * 只有真正缺失的部分才做。这对标 Zed 的 `binary_exists_on_server` 检查：
 * 已引导过的主机再次连接应当很快，而不是每次重跑一遍完整引导。
 *
 * 分层约束：本文件属能力层，可以用传输层与基础层，不得 import 编排层（session/）。
 */

import { assertDiskSpace, probeRemote, type ProbeResult } from './probe.js';
import { selectMirror } from './mirror-selector.js';
import { DEFAULT_NODE_VERSION, ensureNode, type NodeInstallResult } from './node-installer.js';
import { ensureDsh, resolveDshVersion, resolveLatestDshVersion, type DshInstallResult } from './dsh-installer.js';
import { ensurePnpm } from './pnpm-installer.js';
import { ensurePnpmProfileSettings } from './pnpm-profile.js';
import { prepareSessionProfile, type PatchEntry, type ProfileResult } from './profile-writer.js';
import { createRemotePaths, type RemotePaths } from './remote-paths.js';
import { createLogger } from '../util/logger.js';
import { toErrorMessage } from '../util/errors.js';
import type { RemoteContext } from './remote-context.js';
import type { RemoteTransport } from '../transport/types.js';

/** 模块日志器（默认版本解析的降级告警） */
const log = createLogger('provisioner');

/** 引导选项 */
export interface ProvisionOptions {
  /** 会话 id */
  sessionId: string;
  /** 目标 Node 版本；省略用已验证稳定的默认值 */
  nodeVersion?: string;
  /**
   * 目标 dsh 版本或 dist-tag。
   *
   * 传具体版本号则直接用；传 `latest`/`alpha` 这类标签会先解析成具体版本
   * 再安装——安装命令里绝不出现标签（dist-tags 的 latest 可能比预期更旧）。
   * 省略时默认解析 registry 已发布版本的最大值，解析失败回退
   * {@link DEFAULT_DSH_VERSION} 兜底。
   */
  dshVersion?: string;
  /** 会话 profile 的 patch 覆盖条目 */
  patches?: readonly PatchEntry[];
  /** 强制重测镜像，忽略缓存 */
  refreshMirrors?: boolean;
  /** 跳过 Node 稳定性自检（只读诊断场景用） */
  skipStabilityCheck?: boolean;
  /** 取消信号 */
  signal?: AbortSignal;
  /** 阶段开始回调 */
  onStageStart?: (stage: string) => void;
  /** 阶段完成回调；detail 为补充说明 */
  onStageDone?: (detail?: string) => void;
  /** 阶段跳过回调 */
  onStageSkip?: (reason: string) => void;
}

/** 引导结果 */
export interface ProvisionResult {
  /** 远端路径集合 */
  paths: RemotePaths;
  /** 探测结果 */
  probe: ProbeResult;
  /** Node 安装结果 */
  node: NodeInstallResult;
  /** dsh 安装结果 */
  dsh: DshInstallResult;
  /** 会话 profile 准备结果 */
  profile: ProfileResult;
}

/**
 * dsh 默认版本解析失败时的离线兜底（回退地板）。
 *
 * 语义已变：不再是日常默认，而是「解析不出最新已发布版本时也能把引导
 * 跑完」的保底值。未显式指定版本时默认解析 registry 已发布版本的最大值
 * （dist-tag `latest` 实测滞后，见 dsh-installer 文件头与 lessons 6c），
 * 仅在解析失败（离线、registry 抖动）时落到这里。取值需随已发布最大值
 * 的前进手动抬高，保证兜底不至于过旧。
 */
export const DEFAULT_DSH_VERSION = '0.2.0-rc.2';

/** 看起来像 dist-tag 而非版本号的判据：不以数字开头 */
const TAG_PATTERN = /^[a-z]/i;

/**
 * 执行完整引导流程。
 *
 * @param transport - 已连接的传输
 * @param options - 引导选项
 * @returns 引导结果
 */
export async function provision(
  transport: RemoteTransport,
  options: ProvisionOptions,
): Promise<ProvisionResult> {
  const { signal } = options;

  // 1. 探测远端环境
  options.onStageStart?.('探测远端环境');
  const probe = await probeRemote(transport, signal);
  assertDiskSpace(probe, transport.hostAlias);
  const paths = createRemotePaths(probe.homeDir);
  const ctx: RemoteContext = { transport, paths };
  options.onStageDone?.(`${probe.platform.os}/${probe.platform.arch}`);

  const nodeVersion = options.nodeVersion ?? DEFAULT_NODE_VERSION;
  const alreadyHasNode = probe.managedNodes.some(node => node.version === nodeVersion);

  // 2. Node 镜像测速——已装目标版本时不需要，省掉一次网络往返
  let nodeMirrorUrl: string | undefined;
  if (alreadyHasNode) {
    options.onStageStart?.('Node 发行版镜像测速');
    options.onStageSkip?.(`已装 Node ${nodeVersion}`);
  } else {
    options.onStageStart?.('Node 发行版镜像测速');
    const selection = await selectMirror(transport, 'node', {
      cachePath: paths.mirrorCache,
      ...(options.refreshMirrors ? { force: true } : {}),
      ...(signal ? { signal } : {}),
    });
    nodeMirrorUrl = selection.selected.baseUrl;
    if (selection.fromCache) options.onStageSkip?.(`命中缓存：${selection.selected.name}`);
    else options.onStageDone?.(`选中 ${selection.selected.name}`);
  }

  // 3. 装 Node（含稳定性自检）
  options.onStageStart?.(`准备 Node ${nodeVersion}`);
  const node = await ensureNode(ctx, {
    version: nodeVersion,
    // 已装时不会用到 URL，给个占位避免把 undefined 传下去
    mirrorBaseUrl: nodeMirrorUrl ?? '',
    ...(options.skipStabilityCheck ? { skipStabilityCheck: true } : {}),
    ...(signal ? { signal } : {}),
  });
  options.onStageDone?.(node.reused ? '复用已有安装' : '已安装');

  // 4. npm registry 测速
  options.onStageStart?.('npm registry 测速');
  const npmSelection = await selectMirror(transport, 'npm', {
    cachePath: paths.mirrorCache,
    ...(options.refreshMirrors ? { force: true } : {}),
    ...(signal ? { signal } : {}),
  });
  if (npmSelection.fromCache) options.onStageSkip?.(`命中缓存：${npmSelection.selected.name}`);
  else options.onStageDone?.(`选中 ${npmSelection.selected.name}`);

  // 5. 确定 dsh 版本：显式传值时 tag 先解析成具体版本（行为不变）；
  //    缺省时解析 registry 已发布版本的最大值（dist-tag latest 实测
  //    滞后，见 dsh-installer 文件头），解析失败不中断——回退兜底继续
  let dshVersion: string;
  if (options.dshVersion !== undefined) {
    const requested = options.dshVersion;
    dshVersion = requested;
    if (TAG_PATTERN.test(requested)) {
      options.onStageStart?.(`解析 dsh ${requested} 标签`);
      dshVersion = await resolveDshVersion(ctx, {
        tag: requested,
        registryUrl: npmSelection.selected.baseUrl,
        nodeBinDir: node.binDir,
        ...(signal ? { signal } : {}),
      });
      options.onStageDone?.(`${requested} → ${dshVersion}`);
    }
  } else {
    options.onStageStart?.('解析 dsh 最新版本');
    try {
      dshVersion = await resolveLatestDshVersion(ctx, {
        registryUrl: npmSelection.selected.baseUrl,
        nodeBinDir: node.binDir,
        ...(signal ? { signal } : {}),
      });
      options.onStageDone?.(`最新已发布 ${dshVersion}`);
    } catch (error) {
      // 用户主动取消不是「解析失败」，照常上抛
      if (signal?.aborted) throw error;
      // 解析失败不中断引导：离线/registry 抖动时用兜底地板继续跑完，
      // 远端 npm install 命中缓存的可能性得以保留
      dshVersion = DEFAULT_DSH_VERSION;
      log.warn(`远端默认 dsh 版本解析失败，回退兜底 ${DEFAULT_DSH_VERSION}`, {
        hostAlias: transport.hostAlias,
        error: toErrorMessage(error),
      });
      options.onStageDone?.(`解析失败，回退兜底 ${DEFAULT_DSH_VERSION}`);
    }
  }

  // 6. 装 dsh
  options.onStageStart?.(`准备 dsh ${dshVersion}`);
  const dsh = await ensureDsh(ctx, {
    version: dshVersion,
    registryUrl: npmSelection.selected.baseUrl,
    nodeBinDir: node.binDir,
    ...(signal ? { signal } : {}),
  });
  options.onStageDone?.(dsh.reused ? '复用已有安装' : '已安装');

  // 6.5 准备 pnpm：双表面插件管理的共同前提（远端窗口原生插件 UI 在远端
  //     进程内跑 pnpm；本地面板经 SSH 在远端 profile 跑 pnpm）。幂等复用
  options.onStageStart?.('准备 pnpm');
  const pnpm = await ensurePnpm(ctx, {
    registryUrl: npmSelection.selected.baseUrl,
    nodeBinDir: node.binDir,
    ...(signal ? { signal } : {}),
  });
  // pnpm 11 启用前提：host profile 的 pnpm-workspace.yaml 幂等补齐
  // （allowBuilds/minimumReleaseAge，缺段的插件安装必炸——见 pnpm-profile.ts；
  //   写失败上抛，不给运行期埋雷）
  await ensurePnpmProfileSettings(ctx, signal ? { signal } : {});
  options.onStageDone?.(pnpm.reused ? '复用已有安装' : '已安装');

  // 7. 准备会话 profile
  options.onStageStart?.('准备会话 profile');
  const profile = await prepareSessionProfile(ctx, {
    sessionId: options.sessionId,
    dshBin: dsh.dshBin,
    nodeBinDir: node.binDir,
    ...(options.patches ? { patches: options.patches } : {}),
    ...(signal ? { signal } : {}),
  });
  options.onStageDone?.(profile.reused ? '复用已有 profile' : '已创建');

  return { paths, probe, node, dsh, profile };
}

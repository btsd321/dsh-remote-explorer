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

import { inspectOfflineRuntime } from './offline-runtime.js';
import { assertDiskSpace, probeRemote, type ProbeResult } from './probe.js';
import { selectMirror } from './mirror-selector.js';
import { DEFAULT_NODE_VERSION, ensureNode, type NodeInstallResult } from './node-installer.js';
import { DEFAULT_NODE_MAJOR, fetchLatestNodeStableVersion } from './node-version-fetch.js';
import { ensureDsh, resolveDshVersion, resolveDshCandidates, type DshInstallResult } from './dsh-installer.js';
import { ensurePnpm } from './pnpm-installer.js';
import { ensurePnpmProfileSettings } from './pnpm-profile.js';
import {
  ensureProfileNpmRegistry, normalizeNpmRegistry, prepareExistingRuntime,
  resolveDeploymentMode, validateNpmRegistry, type DeploymentMode,
} from './intranet-runtime.js';
import { prepareSessionProfile, type PatchEntry, type ProfileResult } from './profile-writer.js';
import { createRemotePaths, type RemotePaths } from './remote-paths.js';
import { setupProvisionProxyTunnel } from './provision-proxy-tunnel.js';
import { createLogger } from '../util/logger.js';
import { toErrorMessage } from '../util/errors.js';
import type { LocalResourceDownloadMode } from './local-download-mode.js';
import type { RemoteContext } from './remote-context.js';
import type { RemoteTransport } from '../transport/types.js';

/** 模块日志器（默认版本解析的降级告警） */
const log = createLogger('provisioner');

/** 引导选项 */
export interface ProvisionOptions {
  /**
   * 部署方式：
   * - `auto`（默认）：远端没有 Node 时自动下载安装，npm 走公共镜像
   * - `existing`：复用远端现有 Node/npm，只从指定内网源安装 dsh/pnpm
   * - `offline`：严格离线，只校验已导入的完整运行时
   *
   * 显式值优先于旧版 {@link ProvisionOptions.offline}；宿主级
   * `DSH_REMOTE_OFFLINE=1` 仍强制 offline。
   */
  deploymentMode?: DeploymentMode;
  /** 旧版严格离线开关（兼容保留；deploymentMode 优先） */
  offline?: boolean;
  /** existing 模式显式 node 路径；缺省从远端非交互 PATH 探测 */
  nodePath?: string;
  /** 内网 npm 源（existing 必填；auto 可选，设置后不再测速公共 npm 镜像） */
  npmRegistry?: string;
  /** 会话 id */
  sessionId: string;
  /** 目标 Node 版本；省略时在线解析 Node 24 最新稳定版、离线用兜底地板 */
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
  /**
   * 本地资源下载模式（local_resource_download，**仅 SSH 传输**）。
   *
   * 远端无网时建代理隧道（本机 HTTP 代理 + SSH 反向转发），让远端 curl/npm
   * install 经隧道走本机网络。三值 auto/always/off，默认 auto。undefined = auto。
   * 严格离线模式下忽略（离线不下载任何东西，只复用预装运行时）
   */
  localResourceDownload?: LocalResourceDownloadMode;
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
  /** 实际使用的部署方式 */
  deploymentMode: DeploymentMode;
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
 * 语义已变：不再是日常默认，而是「解析不出最大稳定版/最新 rc 时也能把
 * 引导跑完」的保底值。未显式指定版本时默认解析 registry 的最大稳定版、
 * 无稳定版时取最新 rc（dist-tag `latest` 实测滞后，见 dsh-installer 文件头
 * 与 lessons 6c），仅在解析失败（离线、registry 抖动）时落到这里。取值需
 * 随目标版本（当前应为已发布的最新 rc）的前进手动抬高，保证兜底不至于过旧。
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

  // 0. 归一部署方式：环境变量硬开关 > 显式值 > 旧版 offline 布尔
  const deploymentMode = resolveDeploymentMode(options.deploymentMode, options.offline);

  // 1. 探测远端环境。existing/offline 不依赖 curl/wget/tar 下载 Node，
  //    跳过下载工具检查；auto 仍按原规则要求 curl 或 wget。
  options.onStageStart?.('探测远端环境');
  const probe = await probeRemote(transport, signal, deploymentMode !== 'auto');
  assertDiskSpace(probe, transport.hostAlias);
  const paths = createRemotePaths(probe.homeDir);
  const ctx: RemoteContext = { transport, paths };
  options.onStageDone?.(`${probe.platform.os}/${probe.platform.arch}`);

  if (deploymentMode === 'offline') {
    // 严格离线模式不能查询发行站：直接用用户指定版本或兜底地板
    // （离线包内的 Node 是固定版本）。
    const nodeVersion = options.nodeVersion ?? DEFAULT_NODE_VERSION;
    if (options.refreshMirrors) throw new Error('严格离线模式不能与 refreshMirrors 同时使用');
    options.onStageStart?.('严格离线校验运行时（不查询、不下载）');
    const { node, dsh } = await inspectOfflineRuntime(ctx, { ...options, nodeVersion });
    await ensurePnpmProfileSettings(ctx, signal ? { signal } : {});
    const profile = await prepareSessionProfile(ctx, {
      ...options, dshBin: dsh.dshBin, nodeBinDir: node.binDir,
    });
    options.onStageDone?.(`复用 Node ${node.version} / DSH ${dsh.version}`);
    return { deploymentMode, paths, probe, node, dsh, profile };
  }

  if (deploymentMode === 'existing') {
    // existing 不下载 Node，也不建 local_resource_download 代理隧道；
    // 内网 npm 源是唯一安装入口。
    const npmRegistry = requireNpmRegistry(options.npmRegistry);
    if (options.refreshMirrors) {
      throw new Error('「现有 Node + 内网 npm 源」部署不测速公共镜像，不能与 refreshMirrors 同时使用');
    }
    if (options.nodeVersion !== undefined && options.nodeVersion !== '') {
      options.onStageSkip?.(`existing 模式复用现成 Node，忽略 nodeVersion=${options.nodeVersion}`);
    }
    options.onStageStart?.('探测远端现有 Node 与 npm');
    const runtime = await prepareExistingRuntime(ctx, {
      ...(options.nodePath !== undefined ? { nodePath: options.nodePath } : {}),
      ...(options.skipStabilityCheck ? { skipStabilityCheck: true } : {}),
      ...(signal ? { signal } : {}),
    });
    options.onStageDone?.(
      `复用 Node ${runtime.inspection.nodeVersion}（${runtime.inspection.nodePath}）`
        + ` / npm ${runtime.inspection.npmVersion}`,
    );
    return await runProvisionStages(
      ctx, options, probe, runtime.node.version, runtime.node, npmRegistry, undefined, signal, deploymentMode,
    );
  }

  // 2. 在线 auto：解析 Node 版本。默认不 pin 具体版本号：解析 Node 24
  //    LTS 最新稳定版（发行站 index.json，带镜像竞速与缓存），
  //    解析失败回退兜底地板，不中断引导。
  let nodeVersion: string;
  if (options.nodeVersion !== undefined) {
    nodeVersion = options.nodeVersion;
  } else {
    options.onStageStart?.(`解析 Node ${DEFAULT_NODE_MAJOR} 最新稳定版`);
    try {
      const resolved = await fetchLatestNodeStableVersion(DEFAULT_NODE_MAJOR);
      if (resolved !== undefined) {
        nodeVersion = resolved;
        options.onStageDone?.(`Node ${DEFAULT_NODE_MAJOR} 最新稳定版 ${resolved}`);
      } else {
        throw new Error('发行站未返回可用的稳定版');
      }
    } catch (error) {
      // 用户主动取消不是「解析失败」，照常上抛
      if (signal?.aborted) throw error;
      nodeVersion = DEFAULT_NODE_VERSION;
      log.warn(`Node ${DEFAULT_NODE_MAJOR} 最新稳定版解析失败，回退兜底 ${DEFAULT_NODE_VERSION}`, {
        hostAlias: transport.hostAlias,
        error: toErrorMessage(error),
      });
      options.onStageDone?.(`解析失败，回退兜底 ${DEFAULT_NODE_VERSION}`);
    }
  }

  // existing 分支已返回；auto 可选自定义 npm 源。指定源时跳过 npm 镜像测速，
  // 但 Node 下载仍按 auto 原逻辑（local_resource_download 代理隧道也保留）。
  const customNpmRegistry = options.npmRegistry !== undefined && options.npmRegistry !== ''
    ? requireNpmRegistry(options.npmRegistry)
    : undefined;

  const proxyTunnel = await setupProvisionProxyTunnel(transport, options.localResourceDownload);
  if (proxyTunnel.proxyUrl !== undefined) {
    options.onStageStart?.('建立代理隧道（远端无网时经本机网络下载）');
    options.onStageDone?.(`代理: ${proxyTunnel.proxyUrl}`);
  }

  try {
    return await runProvisionStages(
      ctx, options, probe, nodeVersion, undefined, customNpmRegistry,
      proxyTunnel.proxyUrl, signal, deploymentMode,
    );
  } finally {
    await proxyTunnel.teardown();
  }
}

/**
 * 校验并归一必填的内网 npm 源。
 *
 * @param raw - 原始地址
 * @returns 归一后的地址
 * @throws Error 缺失或非法
 */
function requireNpmRegistry(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === '') {
    throw new Error('「现有 Node + 内网 npm 源」部署必须提供内网 npm 源地址（npmRegistry）');
  }
  const error = validateNpmRegistry(raw);
  if (error !== undefined) throw new Error(error);
  return normalizeNpmRegistry(raw);
}

/**
 * 执行引导的实际各阶段（从 probe 之后到返回结果）。
 *
 * 拆分出独立函数是为了让 {@link provision} 的 try/finally 能在 provision 完成后
 * teardown 代理隧道——这个函数的返回/抛错都触发 finally 里的 teardown。
 *
 * @param ctx - 远端执行上下文（已含 transport 与 paths）
 * @param options - 引导选项
 * @param probe - 探测结果
 * @param nodeVersion - 已解析或探测到的 Node 版本
 * @param existingNode - existing 模式的现成运行时；undefined = 需要自动安装
 * @param customNpmRegistry - 自定义 npm 源（已归一）；undefined = 公共镜像测速
 * @param proxyUrl - 代理隧道 URL（undefined = 不代理）
 * @param signal - 取消信号
 * @param deploymentMode - 部署方式（影响 dsh 版本解析失败语义）
 * @returns 引导结果
 */
async function runProvisionStages(
  ctx: RemoteContext,
  options: ProvisionOptions,
  probe: ProbeResult,
  nodeVersion: string,
  existingNode: NodeInstallResult | undefined,
  customNpmRegistry: string | undefined,
  proxyUrl: string | undefined,
  signal: AbortSignal | undefined,
  deploymentMode: DeploymentMode,
): Promise<ProvisionResult> {
  const { transport, paths } = ctx;
  const alreadyHasNode = probe.managedNodes.some(node => node.version === nodeVersion);

  // 2. 准备 Node：existing 模式直接使用探测到的现成运行时；auto 模式
  //    已装目标版本时跳过测速，否则测速并安装（含稳定性自检）
  let node: NodeInstallResult;
  if (existingNode !== undefined) {
    options.onStageStart?.(`准备 Node ${existingNode.version}`);
    node = existingNode;
    options.onStageSkip?.(`existing 模式复用远端现有 Node（${existingNode.nodeBin}）`);
  } else {
    let nodeMirrorUrl: string | undefined;
    if (alreadyHasNode) {
      options.onStageStart?.('Node 发行版镜像测速');
      options.onStageSkip?.(`已装 Node ${nodeVersion}`);
    } else {
      options.onStageStart?.('Node 发行版镜像测速');
      const selection = await selectMirror(transport, 'node', {
        cachePath: paths.mirrorCache,
        ...(options.refreshMirrors ? { force: true } : {}),
        ...(proxyUrl !== undefined ? { proxyUrl } : {}),
        ...(signal ? { signal } : {}),
      });
      nodeMirrorUrl = selection.selected.baseUrl;
      if (selection.fromCache) options.onStageSkip?.(`命中缓存：${selection.selected.name}`);
      else options.onStageDone?.(`选中 ${selection.selected.name}`);
    }

    // 3. 装 Node（含稳定性自检）
    options.onStageStart?.(`准备 Node ${nodeVersion}`);
    node = await ensureNode(ctx, {
      version: nodeVersion,
      // 已装时不会用到 URL，给个占位避免把 undefined 传下去
      mirrorBaseUrl: nodeMirrorUrl ?? '',
      ...(proxyUrl !== undefined ? { proxyUrl } : {}),
      ...(options.skipStabilityCheck ? { skipStabilityCheck: true } : {}),
      ...(signal ? { signal } : {}),
    });
    options.onStageDone?.(node.reused ? '复用已有安装' : '已安装');
  }

  // 4. 确定 npm 源：自定义内网源直接使用（不测速、不回退公网）；
  //    否则沿用公共 registry 镜像测速（auto 默认行为）
  let npmRegistryUrl: string;
  if (customNpmRegistry !== undefined) {
    npmRegistryUrl = customNpmRegistry;
    options.onStageStart?.('使用内网 npm 源');
    options.onStageDone?.(npmRegistryUrl);
  } else {
    options.onStageStart?.('npm registry 测速');
    const npmSelection = await selectMirror(transport, 'npm', {
      cachePath: paths.mirrorCache,
      ...(options.refreshMirrors ? { force: true } : {}),
      ...(proxyUrl !== undefined ? { proxyUrl } : {}),
      ...(signal ? { signal } : {}),
    });
    npmRegistryUrl = npmSelection.selected.baseUrl;
    if (npmSelection.fromCache) options.onStageSkip?.(`命中缓存：${npmSelection.selected.name}`);
    else options.onStageDone?.(`选中 ${npmSelection.selected.name}`);
  }

  // 5. 确定 dsh 版本与降级候选：显式传值时 tag 先解析成具体版本（行为不变）；
  //    缺省时解析 registry 的最大稳定版（无稳定版才取最新 rc，alpha 一律不选；
  //    dist-tag latest 实测滞后，见 dsh-installer 文件头），解析失败不中断
  //    ——回退兜底继续。首选版本装不上时沿候选序列退到次新（见 ensureDsh）。
  let dshVersion: string;
  let dshCandidates: string[];
  if (options.dshVersion !== undefined) {
    const requested = options.dshVersion;
    dshVersion = requested;
    if (TAG_PATTERN.test(requested)) {
      options.onStageStart?.(`解析 dsh ${requested} 标签`);
      dshVersion = await resolveDshVersion(ctx, {
        tag: requested,
        registryUrl: npmRegistryUrl,
        nodeBinDir: node.binDir,
        ...(proxyUrl !== undefined ? { proxyUrl } : {}),
        ...(signal ? { signal } : {}),
      });
      options.onStageDone?.(`${requested} → ${dshVersion}`);
    }
    // 显式指定版本：只尝试该版本，不做降级（尊重用户选择）
    dshCandidates = [dshVersion];
  } else {
    options.onStageStart?.('解析 dsh 默认版本（稳定版优先）');
    try {
      dshCandidates = await resolveDshCandidates(ctx, {
        registryUrl: npmRegistryUrl,
        nodeBinDir: node.binDir,
        ...(proxyUrl !== undefined ? { proxyUrl } : {}),
        ...(signal ? { signal } : {}),
      });
      dshVersion = dshCandidates[0]!;
      options.onStageDone?.(`首选 ${dshVersion}`);
    } catch (error) {
      // 用户主动取消不是「解析失败」，照常上抛
      if (signal?.aborted) throw error;
      // existing 模式只允许内网源：解析失败必须立刻暴露，不能悄悄回退到
      // 兜底版本再让 npm install 撞同一个错误（且回退可能被误读为公网可用）
      if (deploymentMode === 'existing') {
        throw new Error(
          `内网 npm 源 ${npmRegistryUrl} 无法解析 @deepseek-ai/dsh 的版本：${toErrorMessage(error)}。`
            + '请确认该源包含 @deepseek-ai/dsh，或在连接设置中显式填写 dsh 版本',
        );
      }
      // 解析失败不中断引导：离线/registry 抖动时用兜底地板继续跑完，
      // 远端 npm install 命中缓存的可能性得以保留
      dshVersion = DEFAULT_DSH_VERSION;
      dshCandidates = [DEFAULT_DSH_VERSION];
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
    candidates: dshCandidates,
    registryUrl: npmRegistryUrl,
    nodeBinDir: node.binDir,
    ...(proxyUrl !== undefined ? { proxyUrl } : {}),
    ...(signal ? { signal } : {}),
  });
  options.onStageDone?.(dsh.reused ? '复用已有安装' : '已安装');

  // 6.5 准备 pnpm：双表面插件管理的共同前提（远端窗口原生插件 UI 在远端
  //     进程内跑 pnpm；本地面板经 SSH 在远端 profile 跑 pnpm）。幂等复用
  options.onStageStart?.('准备 pnpm');
  const pnpm = await ensurePnpm(ctx, {
    registryUrl: npmRegistryUrl,
    nodeBinDir: node.binDir,
    ...(proxyUrl !== undefined ? { proxyUrl } : {}),
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

  // 8. 显式源使用托管覆盖；auto 未指定源时撤销旧覆盖，恢复用户原配置。
  // 不删除未标记的 registry：无法证明由本工具写入，不能猜测所有权。
  const wroteRegistry = await ensureProfileNpmRegistry(ctx, customNpmRegistry);
  if (wroteRegistry) options.onStageDone?.('已更新 host profile .npmrc（托管 npm 源）');

  return { deploymentMode, paths, probe, node, dsh, profile };
}

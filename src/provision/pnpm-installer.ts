/**
 * @file 远端 pnpm 安装
 * @description 在远端 nodeDir 里全局装一个 pin 版本 pnpm，让两表面插件管理可用：
 *
 * - **远端窗口原生表面**：远端 dsh 自带 plugin-manager 服务（Settings 插件 UI），
 *   装/卸插件在远端进程内跑 pnpm——没 pnpm 时那些按钮全是坏的（实测）
 * - **本地面板代理表面**：本地经 SSH 在远端 profile 目录跑 `pnpm add/remove`
 *
 * 安装方式与 dsh-installer 同款纪律：版本显式 pin（不依赖 dist-tag）、
 * PATH 含 node bin、npm 缓存收进本工具根目录、写临界区套 flock。
 * `npm install -g` 装进 nodeDir 的 prefix（node 自带的 npm 支持 -g 到
 * PATH 上的 prefix），pnpm 可执行文件落 nodeBinDir，PATH 自然带上。
 */

import { RemoteError } from '../util/errors.js';
import { quote } from '../util/shell-quote.js';
import { installLockHint, lockInstallCommand } from './install-lock.js';
import type { RemotePaths } from './remote-paths.js';
import type { RemoteTransport } from '../transport/types.js';

/**
 * pin 的 pnpm 版本。
 *
 * 与 dsh 版本常量同处维护（provisioner 的 DEFAULT_DSH_VERSION 旁）：
 * 选 10 系而非 11——11 对未决策的 build scripts 直接报错退出（allowBuilds
 * 占位值致命，本机实测），远端 profile 里装插件时无人交互决策，10 系只是
 * 警告更稳。dsh 的 profile 模板（pnpm-workspace.yaml）与 10 系兼容已实测。
 */
export const DEFAULT_PNPM_VERSION = '10.33.0';

/** 安装超时（毫秒）。pnpm 自身包很小，分钟级足够慢链路 */
const INSTALL_TIMEOUT_MS = 300_000;

/** pnpm 安装结果 */
export interface PnpmInstallResult {
  /** 安装的版本 */
  version: string;
  /** 是否复用了已有安装 */
  reused: boolean;
}

/**
 * 确保远端有可用的 pin 版本 pnpm。
 *
 * @param transport - 已连接的传输
 * @param paths - 远端路径集合
 * @param options - 安装选项
 * @returns 安装结果
 * @throws RemoteError('EXEC_FAILED') 安装失败或装后版本不符
 */
export async function ensurePnpm(
  transport: RemoteTransport,
  paths: RemotePaths,
  options: {
    /** npm registry baseUrl */
    registryUrl: string;
    /** node bin 目录，会加进 PATH */
    nodeBinDir: string;
    /** 取消信号 */
    signal?: AbortSignal;
    /** 阶段进度回调 */
    onProgress?: (message: string) => void;
  },
): Promise<PnpmInstallResult> {
  const { registryUrl, nodeBinDir, signal } = options;
  const version = DEFAULT_PNPM_VERSION;

  // 1. 已装且版本相符则复用（pnpm -v 一条命令）
  const existing = await transport.exec(
    `pnpm -v 2>/dev/null || true`,
    { pathPrefix: nodeBinDir, allowNonZeroExit: true, ...(signal ? { signal } : {}) },
  );
  if (existing.stdout.trim() === version) {
    return { version, reused: true };
  }

  // 2. 全局装进 nodeDir prefix（可执行文件落 nodeBinDir）
  options.onProgress?.(`安装 pnpm ${version}`);
  const install = lockInstallCommand(paths, [
    `npm install -g --prefix ${quote(nodeBinDirOf(nodeBinDir))}`,
    `--registry=${quote(registryUrl)} --no-audit --no-fund ${quote(`pnpm@${version}`)}`,
  ].join(' '));

  try {
    await transport.exec(install, {
      pathPrefix: nodeBinDir,
      env: { npm_config_cache: paths.npmCache },
      timeoutMs: INSTALL_TIMEOUT_MS + 60_000,
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    const hint = installLockHint(String((error as { stderr?: string }).stderr ?? ''));
    throw new RemoteError(
      'EXEC_FAILED',
      `在主机 ${transport.hostAlias} 上安装 pnpm ${version} 失败${hint ?? ''}`,
      { cause: error, hostAlias: transport.hostAlias },
    );
  }

  // 3. 验证
  const verify = await transport.exec(`pnpm -v`, {
    pathPrefix: nodeBinDir,
    ...(signal ? { signal } : {}),
  });
  const actual = verify.stdout.trim();
  if (actual !== version) {
    throw new RemoteError(
      'EXEC_FAILED',
      `主机 ${transport.hostAlias} 上安装的 pnpm 版本不符：期望 ${version}，实际 ${actual || '(无输出)'}`,
      { hostAlias: transport.hostAlias },
    );
  }
  return { version, reused: false };
}

/**
 * nodeBinDir → npm 的 prefix（bin 的上一级）。
 *
 * `npm install -g --prefix <prefix>` 把可执行文件装到 `<prefix>/bin`——
 * 即 nodeBinDir 本身，PATH 无需额外处理。
 *
 * @param nodeBinDir - node 的 bin 目录
 * @returns prefix 目录
 */
function nodeBinDirOf(nodeBinDir: string): string {
  return nodeBinDir.endsWith('/bin') ? nodeBinDir.slice(0, -'/bin'.length) : nodeBinDir;
}

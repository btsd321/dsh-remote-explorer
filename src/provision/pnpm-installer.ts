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
 *
 * 版本探针为什么读落盘 package.json 而不是 `pnpm -v`（三重陷阱，均在用户的
 * WSL 机器上实测确诊）：
 *
 * 1. **interop 解析渗入**：管理版未装时，`pnpm` 经 WSL 的 Windows PATH 附加段
 *    解析到 `/mnt/c/<用户>/AppData/Roaming/npm/pnpm`（宿主机 Windows pnpm
 *    11.7.0）——版本检查读到的是宿主机的 pnpm，与管理目录无关。
 * 2. **CWD 钉版自动切换**：wsl.exe 继承 Windows 进程 CWD；CLI 从本仓库根启动
 *    时 bash 的 CWD = /mnt/d/...（仓库 checkout），仓库 package.json 有
 *    `"packageManager": "pnpm@11.7.0"`，pnpm 10 的 managePackageManagerVersions
 *    （10 系默认开启）发现后**自动切换到 11.7.0 执行**——`pnpm -v` 报告的是
 *    切换后版本，与管理目录实际安装的 10.33.0 无关。
 * 3. **CLI 从仓库根启动必踩**：上面两条是叠加关系——探针既可能读到宿主机的
 *    pnpm，也可能读到 CWD 钉版切换出来的版本，`--config.manage-package-manager-versions=false`
 *    无法在 CLI 关闭它（实测）。
 *
 * 结论：`pnpm -v` 作为探针从根上不可靠；唯一可信源是管理目录落盘的
 * `<nodeDir>/lib/node_modules/pnpm/package.json` 的 version 字段。
 */

import { RemoteError } from '../util/errors.js';
import { createLogger } from '../util/logger.js';
import { quote } from '../util/shell-quote.js';
import { installLockHint, lockInstallCommand } from './install-lock.js';
import type { RemoteContext } from './remote-context.js';

const log = createLogger('pnpm-installer');

/**
 * pin 的 pnpm 版本。
 *
 * 与 dsh 官方仓库的 packageManager 钉版对齐（11.7.0）；与 dsh 版本常量同处
 * 维护（provisioner 的 DEFAULT_DSH_VERSION 旁）。既有安装按主版本 10/11/12
 * 兼容复用（见 {@link ACCEPTED_PNPM_MAJORS}）。11 系在远端启用的前提
 * （allowBuilds/minimumReleaseAge）由引导在 host profile 的
 * pnpm-workspace.yaml 幂等补齐（见 pnpm-profile.ts）——历史 pin 10 的原因
 * （11 对未决策的 allowBuilds 致命报错而远端无人交互）由此消除。
 */
export const DEFAULT_PNPM_VERSION = '11.7.0';

/**
 * 兼容复用的 pnpm 主版本集合。
 *
 * dsh 的插件管理（profile 目录内 pnpm add/remove）在 10/11 系行为一致，
 * 12 系为兼容窗口预留；不在集合内的主版本（如 9、13）视为不满足，重新安装
 * pin 版。复用只看主版本：minor/patch 差异对插件管理无实质影响，不值得
 * 为它们触发分钟级重装。
 */
export const ACCEPTED_PNPM_MAJORS: readonly [10, 11, 12] = [10, 11, 12];

/** 安装超时（毫秒）。pnpm 自身包很小，分钟级足够慢链路 */
const INSTALL_TIMEOUT_MS = 300_000;

/** pnpm 安装结果 */
export interface PnpmInstallResult {
  /**
   * 实际在用的 pnpm 版本。
   *
   * 复用时 = 落盘 package.json 读回的实际版本（可能是 10/11/12 系任一），
   * 新装时 = {@link DEFAULT_PNPM_VERSION}。来源见文件头「唯一可信源」。
   */
  version: string;
  /** 是否复用了已有安装 */
  reused: boolean;
}

/**
 * 判断 pnpm 版本的主版本是否在兼容集合内。
 *
 * 解析失败（垃圾输入、无主版本段）一律按不满足处理——调用方会走重装路径，
 * 宁可重装也不带着一个读不懂的版本跑。
 *
 * @param version - 版本字符串，如 '10.33.0'、'11.7.0-beta.1'
 * @returns 主版本 ∈ ACCEPTED_PNPM_MAJORS 时 true
 */
export function pnpmMajorAccepted(version: string): boolean {
  // 完整锚定的 semver 形态（允许 prerelease/build 后缀）：探针值来自
  // JSON.parse 的 version 字段、只参与数值比较不进 shell，但收紧解析可让
  // 带尾部垃圾的读回（如半截写入的文件）落进重装路径而非误判复用
  const match = /^(\d+)\.\d+\.\d+(?:[-+][0-9A-Za-z.-]*)?$/.exec(version.trim());
  if (match === null) return false;
  return (ACCEPTED_PNPM_MAJORS as readonly number[]).includes(Number(match[1]));
}

/**
 * 从落盘 package.json 文本提取 pnpm 版本（版本探针的解析侧）。
 *
 * 这是文件头结论的落地：JSON 损坏、缺 version 字段、字段非字符串一律返回
 * undefined，交由调用方按「未装/损坏 → 安装」处理——半成品安装目录正需要
 * 这个语义（存在但不可读 = 重装覆盖）。
 *
 * @param packageJsonText - `cat` 读回的 package.json 全文
 * @returns 版本字符串；不可解析时 undefined
 */
export function parsePnpmPackageJson(packageJsonText: string): string | undefined {
  try {
    const parsed = JSON.parse(packageJsonText) as { version?: unknown };
    if (typeof parsed.version !== 'string' || parsed.version === '') return undefined;
    return parsed.version;
  } catch {
    // JSON 损坏：按未装处理，重装覆盖（空的 catch 必须说明为何可忽略）
    return undefined;
  }
}

/**
 * 确保远端有可用的 pnpm。
 *
 * check/verify 都不跑 `pnpm -v`（三重陷阱见文件头），只读管理目录落盘的
 * package.json：check 按主版本兼容集合判复用，verify 期望精确等于 pin 版。
 *
 * @param ctx - 远端执行上下文
 * @param options - 安装选项
 * @returns 安装结果
 * @throws RemoteError('EXEC_FAILED') 安装失败或装后落盘版本不符
 */
export async function ensurePnpm(
  ctx: RemoteContext,
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
  const { transport, paths } = ctx;
  const version = DEFAULT_PNPM_VERSION;
  const packageJsonPath = pnpmPackageJsonOf(nodeBinDir);

  // 1. 已装且主版本兼容则复用：读落盘 package.json（唯一可信源，见文件头），
  //    cat 是 POSIX 基础工具、不经 PATH 解析，不受 interop 渗入影响
  const existing = await transport.exec(
    `cat ${quote(packageJsonPath)} 2>/dev/null || true`,
    { allowNonZeroExit: true, ...(signal ? { signal } : {}) },
  );
  const installed = parsePnpmPackageJson(existing.stdout);
  if (installed !== undefined && pnpmMajorAccepted(installed)) {
    // 探针决策留痕：读到什么、判定为什么，复盘时无需再上远端查文件
    log.info(`pnpm 探针：落盘 ${installed}（主版本兼容）→ 复用`, {
      hostAlias: transport.hostAlias,
      path: packageJsonPath,
    });
    return { version: installed, reused: true };
  }
  // 决策留痕（另一分支）：为什么触发安装——缺失/损坏/主版本不兼容三选一
  log.info(
    `pnpm 探针：落盘 ${installed ?? '(缺失或不可解析)'}，不满足主版本兼容`
    + `（${ACCEPTED_PNPM_MAJORS.join('/')}），将安装 pin 版 ${version}`,
    { hostAlias: transport.hostAlias, path: packageJsonPath },
  );

  // 2. 全局装进 nodeDir prefix（可执行文件落 nodeBinDir）
  options.onProgress?.(`安装 pnpm ${version}`);
  const install = lockInstallCommand(paths, [
    `npm install -g --prefix ${quote(npmPrefixOf(nodeBinDir))}`,
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

  // 3. 装后校验：同款落盘读取，期望精确等于 pin 版。跑 `pnpm -v` 在 CWD 钉版
  //    自动切换下可能报出别的版本（见文件头陷阱 2），落盘文件才是安装事实
  const verify = await transport.exec(
    `cat ${quote(packageJsonPath)} 2>/dev/null || true`,
    { allowNonZeroExit: true, ...(signal ? { signal } : {}) },
  );
  const actual = parsePnpmPackageJson(verify.stdout);
  if (actual !== version) {
    throw new RemoteError(
      'EXEC_FAILED',
      `主机 ${transport.hostAlias} 上安装的 pnpm 版本不符：期望 ${version}，`
        + `落盘 package.json 实际读到 ${actual ?? '(文件缺失或不可解析)'}`,
      { hostAlias: transport.hostAlias },
    );
  }
  log.info(`pnpm 装后校验通过：落盘 ${actual}`, {
    hostAlias: transport.hostAlias,
    path: packageJsonPath,
  });
  return { version, reused: false };
}

/**
 * nodeBinDir → pnpm 落盘 package.json 的绝对路径（版本探针的唯一可信源）。
 *
 * `npm install -g --prefix <prefix>` 把包体装到 `<prefix>/lib/node_modules/<包名>/`。
 *
 * @param nodeBinDir - node 的 bin 目录
 * @returns pnpm 的 package.json 路径
 */
function pnpmPackageJsonOf(nodeBinDir: string): string {
  return `${npmPrefixOf(nodeBinDir)}/lib/node_modules/pnpm/package.json`;
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
function npmPrefixOf(nodeBinDir: string): string {
  return nodeBinDir.endsWith('/bin') ? nodeBinDir.slice(0, -'/bin'.length) : nodeBinDir;
}

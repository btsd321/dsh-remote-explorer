/**
 * @file 远端 dsh 安装
 * @description 在远端用 npm 安装 `@deepseek-ai/dsh` 到版本隔离的目录。
 *
 * 主路径是**远端自装**（决策 3）：远端自己 `npm install`，装前由
 * {@link selectMirror} 测出最快的 registry。本地打包上传作为显式可选回退
 * （`--upload-fallback`，默认关闭），因为完全离线的远端是真实存在的场景——
 * Zed 与 VS Code 都保留了这条回退路径。
 *
 * 三个必须显式处理的点（1、2 为 P0 实测，3 为隔离要求）：
 *
 * 1. **版本号必须显式指定。** `@deepseek-ai/dsh` 的 dist-tags 是
 *    `latest: 0.1.5-rc.2`、`alpha: 0.1.6-alpha.2`——装 `latest` 会拿到比
 *    预期更旧的版本，不能依赖默认标签。
 * 2. **PATH 必须含 node 的 bin 目录。** npm 自身的 shebang 是
 *    `#!/usr/bin/env node`，不加 PATH 直接报 `env: 'node': No such file or directory`。
 * 3. **npm 缓存必须收进本工具的根目录。** 不设 `npm_config_cache` 时 npm
 *    写远端用户级 `~/.npm`（缓存与 `_logs` 都在里面）——那是远端其他
 *    npm 使用者的共享目录。隔离契约是「本工具在远端的一切落盘都在
 *    `~/.dsh-remote-explorer/btsd321/` 内、完全不触碰远端 `~/.dsh` 与 `~/.npm`」，
 *    对标 VS Code 的 `~/.vscode-server` 单根自治模型。
 */

import { RemoteError } from '../util/errors.js';
import { quote } from '../util/shell-quote.js';
import type { RemotePaths } from './remote-paths.js';
import type { RemoteTransport } from '../transport/types.js';

/**
 * 安装超时（毫秒）。
 *
 * P0 实测 490 个包用了 60 秒。给到 15 分钟是为了覆盖慢链路与首次无缓存的情况——
 * 决策 7 已接受首次安装耗时长，这里宁可等也不要中途失败留下半个安装。
 */
const INSTALL_TIMEOUT_MS = 900_000;

/** dsh 安装结果 */
export interface DshInstallResult {
  /** 安装的版本 */
  version: string;
  /** dsh 可执行入口绝对路径 */
  dshBin: string;
  /** 安装目录绝对路径 */
  installDir: string;
  /** 是否复用了已有安装 */
  reused: boolean;
}

/**
 * 确保远端有可用的指定版本 dsh。
 *
 * 已装则复用（执行 `dsh --version` 比对，对标 Zed 的做法），未装则安装。
 *
 * @param transport - 已连接的传输
 * @param paths - 远端路径集合
 * @param options - 安装选项
 * @returns 安装结果
 * @throws RemoteError('EXEC_FAILED') 安装失败或装后版本不符
 */
export async function ensureDsh(
  transport: RemoteTransport,
  paths: RemotePaths,
  options: {
    /** 目标 dsh 版本，如 `0.1.6-alpha.2` */
    version: string;
    /** npm registry baseUrl */
    registryUrl: string;
    /** node bin 目录，会加进 PATH */
    nodeBinDir: string;
    /** 取消信号 */
    signal?: AbortSignal;
    /** 阶段进度回调 */
    onProgress?: (message: string) => void;
  },
): Promise<DshInstallResult> {
  const { version, registryUrl, nodeBinDir, signal } = options;
  const installDir = paths.dshDir(version);
  const dshBin = paths.dshBin(version);

  // 1. 检查是否已装。用 `dsh --version` 而非文件存在性——
  //    半成品安装（node_modules 不完整）会让文件检查误判为可用
  const existing = await runWithPath(
    transport,
    `${quote(dshBin)} --version 2>/dev/null || true`,
    nodeBinDir,
    { allowNonZeroExit: true, ...(signal ? { signal } : {}) },
  );
  if (existing.stdout.trim() === version) {
    return { version, dshBin, installDir, reused: true };
  }

  // 2. 安装。目录里放一个占位 package.json，让 npm 把依赖装进本目录而不是向上找
  options.onProgress?.(`安装 dsh ${version}（首次约需 1 分钟）`);
  const placeholder = JSON.stringify({ name: 'dsh-remote-explorer-install', private: true });
  const install = [
    `rm -rf ${quote(installDir)}`,
    `mkdir -p ${quote(installDir)}`,
    `cd ${quote(installDir)}`,
    `printf '%s' ${quote(placeholder)} > package.json`,
    `npm install --registry=${quote(registryUrl)} --no-audit --no-fund ${quote(`@deepseek-ai/dsh@${version}`)}`,
  ].join('\n');

  try {
    await transport.exec(install, {
      pathPrefix: nodeBinDir,
      env: npmEnv(paths),
      timeoutMs: INSTALL_TIMEOUT_MS,
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    // 安装失败必须清掉目录：留下半个安装会让下次的版本检查行为难以预测
    await cleanup(transport, installDir);
    throw new RemoteError(
      'EXEC_FAILED',
      `在主机 ${transport.hostAlias} 上安装 dsh ${version} 失败。`
        + '若报错形如 V8 内存分配失败或 SIGTRAP，通常是 Node 运行时在该架构上不稳定，'
        + '请用 dsh-remote-explorer doctor 检查 Node 稳定性自检结果',
      { cause: error, hostAlias: transport.hostAlias },
    );
  }

  // 3. 验证装出来的版本
  const verify = await runWithPath(transport, `${quote(dshBin)} --version`, nodeBinDir, {
    ...(signal ? { signal } : {}),
  });
  const actual = verify.stdout.trim();
  if (actual !== version) {
    throw new RemoteError(
      'EXEC_FAILED',
      `主机 ${transport.hostAlias} 上安装的 dsh 版本不符：期望 ${version}，实际 ${actual || '(无输出)'}`,
      { hostAlias: transport.hostAlias },
    );
  }

  return { version, dshBin, installDir, reused: false };
}

/**
 * 查询 registry 上某个 dist-tag 对应的具体版本。
 *
 * 供 CLI 在用户未显式指定版本时解析——但解析结果会被显式传下去，
 * 安装命令里绝不出现 dist-tag（见文件头第 1 点）。
 *
 * @param transport - 已连接的传输
 * @param options - 查询选项
 * @returns 具体版本号
 * @throws RemoteError('EXEC_FAILED') 查询失败或标签不存在
 */
export async function resolveDshVersion(
  transport: RemoteTransport,
  paths: RemotePaths,
  options: {
    /** dist-tag，如 `latest` 或 `alpha` */
    tag: string;
    /** npm registry baseUrl */
    registryUrl: string;
    /** node bin 目录 */
    nodeBinDir: string;
    /** 取消信号 */
    signal?: AbortSignal;
  },
): Promise<string> {
  const { tag, registryUrl, nodeBinDir, signal } = options;
  const result = await runWithPath(
    transport,
    `npm view ${quote(`@deepseek-ai/dsh@${tag}`)} version --registry=${quote(registryUrl)} 2>/dev/null || true`,
    nodeBinDir,
    {
      allowNonZeroExit: true,
      timeoutMs: 120_000,
      env: npmEnv(paths),
      ...(signal ? { signal } : {}),
    },
  );

  // npm view 可能输出多行（同一 tag 命中多个版本时），取最后一行非空值
  const lines = result.stdout.trim().split('\n').map(line => line.trim()).filter(Boolean);
  const version = lines.at(-1);
  if (!version) {
    throw new RemoteError(
      'EXEC_FAILED',
      `无法从 ${registryUrl} 解析 @deepseek-ai/dsh 的 ${tag} 标签对应版本`,
      { hostAlias: transport.hostAlias },
    );
  }
  return version;
}

/**
 * 带 PATH 执行远端命令。
 *
 * 把「PATH 必须含 node bin」这条约束收口到一处，避免各调用点漏加。
 *
 * @param transport - 已连接的传输
 * @param command - 命令字符串
 * @param nodeBinDir - node bin 目录
 * @param options - 执行选项
 * @returns 执行结果
 */
async function runWithPath(
  transport: RemoteTransport,
  command: string,
  nodeBinDir: string,
  options: Parameters<RemoteTransport['exec']>[1],
): ReturnType<RemoteTransport['exec']> {
  return transport.exec(command, { ...options, pathPrefix: nodeBinDir });
}

/**
 * npm 的隔离环境变量：缓存收进本工具的根目录。
 *
 * 不设置时 npm 写远端用户级 `~/.npm`（缓存与 `_logs` 都在其中），
 * 那是与远端其他 npm 使用者共享的目录——隔离契约要求装机不碰它。
 * `npm_config_cache` 对 install 与 view 一视同仁。
 *
 * @param paths - 远端路径集合
 * @returns 环境变量
 */
function npmEnv(paths: RemotePaths): Record<string, string> {
  return { npm_config_cache: paths.npmCache };
}

/**
 * 删除远端目录，失败不抛错。
 *
 * @param transport - 已连接的传输
 * @param dir - 待删目录绝对路径
 */
async function cleanup(transport: RemoteTransport, dir: string): Promise<void> {
  try {
    await transport.exec(`rm -rf ${quote(dir)}`, { allowNonZeroExit: true });
  } catch { /* 清理失败只留下无用目录，不影响错误上报 */ }
}

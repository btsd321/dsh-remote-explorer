/**
 * @file 会话 profile 生成
 * @description 为每个会话创建独立的 `DSH_HOME` 与其中的 profile，并写入 patch 覆盖层。
 *
 * 「共享安装 + 每会话 DSH_HOME」之所以成立，是因为 dsh 的模块解析是**双锚**的——
 * bundle 名先从 dsh 安装位置解析、再从 profile 目录解析，所以「dsh 装在哪」与
 * 「DSH_HOME 指向哪」彼此解耦。这一点 P0 已实测：dsh 装在共享的 `versions/` 下，
 * profile 生成在会话目录内，两者并不冲突。
 *
 * 对应成熟项目的两层划分：Zed 是「共享版本化二进制 + proxy --identifier」，
 * VS Code 是「共享 per-commit server + 独立数据目录」。
 *
 * 三条 P0 实测得出的硬约束：
 *
 * 1. **`DSH_HOME` 必须走 `env` 前缀传**，它是 bootstrap-only，任何 `.env` 都改不了它。
 * 2. **patch 条目必须用 `id` 而非 `name`**，否则 dsh 直接拒绝：
 *    `patch: id is required for non-insert patches`。
 * 3. **host/port 用 web 应用原生 flag**（`--host`/`--port`/`--no-open`），不写 patch。
 *    webserver 的 bundle 层配置是 `host: !!js ctx.webStartup.host ?? '127.0.0.1'`，
 *    即命令行 flag 经 `webStartup` 服务覆盖默认值，比写 patch 简单且更稳。
 */

import { RemoteError } from '../util/errors.js';
import { quote } from '../util/shell-quote.js';
import { writeRemoteTextFile } from '../transport/write-text.js';
import type { RemoteContext } from './remote-context.js';

/**
 * 会话内使用的 profile 名。
 *
 * 与 dsh 官方模板 `web` 对齐——dsh 启动时 `--profile web` 在
 * `$DSH_HOME/profiles/web/` 找到 symlink，指向主机级共享 profile。
 */
export const SESSION_PROFILE_NAME = 'web';

/**
 * profile 初始化超时（毫秒）。
 *
 * 首次初始化会解析并组合整棵插件树，比普通命令慢。
 */
const INIT_TIMEOUT_MS = 300_000;

/** profile 准备结果 */
export interface ProfileResult {
  /** 会话的 DSH_HOME 绝对路径 */
  dshHome: string;
  /** profile 名 */
  profileName: string;
  /** patch 文件绝对路径；无 patch 条目时为 undefined */
  patchFile?: string;
  /** 是否复用了已有 profile */
  reused: boolean;
}

/** 一条 patch 覆盖条目 */
export interface PatchEntry {
  /** 目标条目 id（从 `--dump-config` 输出里读，不能猜） */
  id: string;
  /** 要覆盖的配置字段 */
  config: Record<string, string | number | boolean>;
}

/**
 * 准备会话的 DSH_HOME 与 profile。
 *
 * 幂等：profile 已存在则跳过初始化，但 patch 文件每次都重写——
 * 端口与令牌每次会话都可能变。
 *
 * @param ctx - 远端执行上下文
 * @param options - 选项
 * @returns 准备结果
 * @throws RemoteError('EXEC_FAILED') 初始化失败
 */
export async function prepareSessionProfile(
  ctx: RemoteContext,
  options: {
    /** 会话 id */
    sessionId: string;
    /** dsh 可执行入口绝对路径 */
    dshBin: string;
    /** node bin 目录 */
    nodeBinDir: string;
    /** patch 覆盖条目；为空则不生成 patch 文件 */
    patches?: readonly PatchEntry[];
    /** 取消信号 */
    signal?: AbortSignal;
    /** 阶段进度回调 */
    onProgress?: (message: string) => void;
  },
): Promise<ProfileResult> {
  const { sessionId, dshBin, nodeBinDir, signal } = options;
  const { transport, paths } = ctx;
  const dshHome = paths.sessionHome(sessionId);
  const profileDir = paths.sessionProfile(sessionId);
  const runtimeDir = paths.sessionRuntime(sessionId);

  // 1. 建目录骨架
  await transport.exec(`mkdir -p ${quote(runtimeDir)}`, {
    ...(signal ? { signal } : {}),
  });

  // 2. 确保 host profile 已初始化（首次连接时用 dsh --dump-config 初始化），
  //    然后创建 session profile → host profile 的 symlink。
  const hostProfileDir = paths.hostProfileDir(SESSION_PROFILE_NAME);
  const hostMarker = `${hostProfileDir}/package.json`;
  const hostCheck = await transport.exec(
    `test -f ${quote(hostMarker)} && echo EXISTS || true`,
    { allowNonZeroExit: true, ...(signal ? { signal } : {}) },
  );
  const hostExists = hostCheck.stdout.includes('EXISTS');

  if (!hostExists) {
    options.onProgress?.('初始化主机级 profile');
    // 用 --dump-config 触发初始化而不真正启动：它会建好 profile 目录后打印
    // 组合结果并退出，是最轻的初始化手段（P0 验证可用）。
    // DSH_HOME 指向 base（不是 session），让 dsh 在 base/profiles/web/ 下创建 profile
    const init = [
      quote(dshBin),
      '--profile', quote(SESSION_PROFILE_NAME),
      '--from-default-profile', quote(SESSION_PROFILE_NAME),
      '--dump-config',
    ].join(' ');

    try {
      await transport.exec(`${init} >/dev/null`, {
        env: { DSH_HOME: paths.base },
        pathPrefix: nodeBinDir,
        timeoutMs: INIT_TIMEOUT_MS,
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      throw new RemoteError(
        'EXEC_FAILED',
        `在主机 ${transport.hostAlias} 上初始化主机级 profile 失败`,
        { cause: error, hostAlias: transport.hostAlias },
      );
    }

    const verify = await transport.exec(
      `test -f ${quote(hostMarker)} && echo EXISTS || true`,
      { allowNonZeroExit: true, ...(signal ? { signal } : {}) },
    );
    if (!verify.stdout.includes('EXISTS')) {
      throw new RemoteError(
        'EXEC_FAILED',
        `初始化后主机 ${transport.hostAlias} 上仍未生成 host profile：${hostMarker}`,
        { hostAlias: transport.hostAlias },
      );
    }
  }

  // 3. session profile → host profile 的 symlink（幂等）
  //    dsh 启动时 --profile web 在 $DSH_HOME/profiles/web/ 找到此 symlink
  const sessionMarker = `${profileDir}/package.json`;
  const sessionCheck = await transport.exec(
    `test -L ${quote(profileDir)} && echo SYMLINK || test -f ${quote(sessionMarker)} && echo EXISTS || true`,
    { allowNonZeroExit: true, ...(signal ? { signal } : {}) },
  );
  const reused = sessionCheck.stdout.includes('SYMLINK') || sessionCheck.stdout.includes('EXISTS');

  if (!sessionCheck.stdout.includes('SYMLINK')) {
    // 老会话遗留的真实 profile 目录或不存在 → 替换为 symlink
    const parentDir = profileDir.substring(0, profileDir.lastIndexOf('/'));
    const linkScript = [
      `mkdir -p ${quote(parentDir)}`,
      `[ -d ${quote(profileDir)} ] && rm -rf ${quote(profileDir)}`,
      `ln -sfn ${quote(hostProfileDir)} ${quote(profileDir)}`,
    ].join('\n');
    await transport.exec(linkScript, { allowNonZeroExit: true, ...(signal ? { signal } : {}) });
  }

  // 3. 写 patch 文件（每次重写：端口与令牌每次会话都可能变）。
  //    SFTP 主路径（远端未开 sftp 子系统时自动回退 printf-over-exec）；
  //    严格模式——patch 承载凭据 baseURL 重定向，写失败必须立刻暴露
  let patchFile: string | undefined;
  if (options.patches && options.patches.length > 0) {
    patchFile = paths.sessionPatchFile(sessionId);
    const yaml = renderPatchYaml(options.patches);
    await writeRemoteTextFile(transport, patchFile, yaml, signal ? { signal } : {});
  }

  return {
    dshHome,
    profileName: SESSION_PROFILE_NAME,
    ...(patchFile ? { patchFile } : {}),
    reused,
  };
}

/**
 * 把 patch 条目渲染成 YAML 文本。
 *
 * 只支持 `id` + 标量 `config` 字段——这是本工具实际需要的全部形态，
 * 不引入 YAML 序列化依赖。条目必须带 `id`，见文件头第 2 点。
 *
 * @param patches - patch 条目
 * @returns YAML 文本
 */
function renderPatchYaml(patches: readonly PatchEntry[]): string {
  const lines: string[] = [];
  for (const patch of patches) {
    lines.push(`- id: ${patch.id}`);
    lines.push('  config:');
    for (const [key, value] of Object.entries(patch.config)) {
      lines.push(`    ${key}: ${renderScalar(value)}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/**
 * 渲染 YAML 标量值。
 *
 * 字符串一律加双引号并转义——未加引号的 YAML 标量会被隐式类型转换
 * （`127.0.0.1` 尚可，但形如 `on`、`no`、`1.0` 的值会变成布尔或数字）。
 *
 * @param value - 标量值
 * @returns YAML 表示
 */
function renderScalar(value: string | number | boolean): string {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

/**
 * 构造启动远端 dsh 的命令。
 *
 * 集中在此是为了让「`DSH_HOME` 走 env 前缀」「PATH 含 node bin」
 * 「host/port 用原生 flag」这三条约束只在一处表达。
 *
 * 注意本函数只返回命令字符串，不负责 detach——那属于会话编排层的职责。
 *
 * @param options - 启动参数
 * @returns 可交给 `exec` 的命令字符串
 */
export function buildStartCommand(options: {
  /** dsh 可执行入口绝对路径 */
  dshBin: string;
  /** profile 名 */
  profileName: string;
  /** 远端监听端口 */
  port: number;
  /** patch 文件绝对路径（可选） */
  patchFile?: string;
}): string {
  const parts = [
    quote(options.dshBin),
    '--profile', quote(options.profileName),
  ];
  if (options.patchFile) {
    parts.push('--patch', quote(options.patchFile));
  }
  parts.push(
    // 绝不用 0.0.0.0：dsh webserver 自身不带 TLS 与认证围栏之外的保护，
    // 绑全网卡等于把 GUI 挂到网上
    '--host', '127.0.0.1',
    '--port', String(options.port),
    // 远端开浏览器没有意义，而且会在无 DISPLAY 的机器上报错
    '--no-open',
  );
  return parts.join(' ');
}

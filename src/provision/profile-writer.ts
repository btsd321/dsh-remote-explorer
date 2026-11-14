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
  /** 要覆盖的配置字段；允许嵌套值（如 DeepSeek 自定义 models 目录） */
  config: Record<string, unknown>;
}

/**
 * 准备会话的 DSH_HOME 与 profile。
 *
 * DSH_HOME = base（机器级），所有会话共享。profile 在 `base/profiles/web/`，
 * 不再需要会话级 symlink。patch 文件每次都重写——端口与令牌每次会话都可能变。
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
  const dshHome = paths.dshHome;
  const profileDir = paths.hostProfileDir(SESSION_PROFILE_NAME);
  const runtimeDir = paths.sessionRuntime(sessionId);

  // 1. 建 .runtime 目录骨架（会话级）
  await transport.exec(`mkdir -p ${quote(runtimeDir)}`, {
    ...(signal ? { signal } : {}),
  });

  // 2. 确保 host profile 已初始化（首次连接时用 dsh --dump-config 初始化）。
  //    DSH_HOME = base，dsh 在 base/profiles/web/ 下创建 profile。
  //    所有会话共享同一份 profile——不再需要会话级 symlink。
  const hostMarker = paths.hostProfileManifest(SESSION_PROFILE_NAME);
  const hostCheck = await transport.exec(
    `test -f ${quote(hostMarker)} && echo EXISTS || true`,
    { allowNonZeroExit: true, ...(signal ? { signal } : {}) },
  );
  const hostExists = hostCheck.stdout.includes('EXISTS');

  if (!hostExists) {
    options.onProgress?.('初始化主机级 profile');
    // 用 --dump-config 触发初始化而不真正启动：它会建好 profile 目录后打印
    // 组合结果并退出，是最轻的初始化手段。
    const init = [
      quote(dshBin),
      '--profile', quote(SESSION_PROFILE_NAME),
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

  // 3. 写 patch 文件（每次重写：端口与令牌每次会话都可能变）。
  //    patch 文件在 sessions/<id>/.runtime/patch.yml，通过 --patch 参数传入。
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
    reused: hostExists,
  };
}

/**
 * 把 patch 条目渲染成 YAML 文本。
 *
 * 顶层保持 `- id:` 数组条目形态：`provisionAndConfigure` 之后会向同一文件
 * 追加 `- id: llm-pi-ai`，如果用 JSON 数组包起来（`[...]`），追加的 YAML
 * 条目会落在闭合括号之后，整份文件将无法解析。
 *
 * 标量沿用严格引号；嵌套对象/数组用 JSON 序列化——JSON 是 YAML 1.2 的
 * 严格子集，`models: [{"id":"..."}]` 这类 flow style 可被 DSH 的 YAML
 * 解析器直接读取，同时不必把整个 yaml 序列化库带进 profile-writer。
 *
 * @param patches - patch 条目
 * @returns YAML 文本
 */
function renderPatchYaml(patches: readonly PatchEntry[]): string {
  const lines: string[] = [];
  for (const patch of patches) {
    lines.push(`- id: ${renderScalar(patch.id)}`);
    lines.push('  config:');
    for (const [key, value] of Object.entries(patch.config)) {
      lines.push(`    ${renderScalar(key)}: ${renderYamlValue(value)}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/**
 * 渲染 patch 配置值，兼容嵌套对象/数组。
 *
 * @param value - 配置值
 * @returns YAML 表示
 */
function renderYamlValue(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return renderScalar(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  // 嵌套对象/数组用 JSON flow style；JSON 是 YAML 1.2 的严格子集
  return JSON.stringify(value) ?? 'null';
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
function renderScalar(value: string): string {
  return JSON.stringify(value);
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

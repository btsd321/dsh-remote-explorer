/**
 * @file 远端路径规则
 * @description 本工具在远端创建的所有路径的**唯一真源**。任何模块都不得自己拼远端路径。
 *
 * 布局设计依据（参考 dsh 官方 `~/.dsh` 结构 + Zed/VS Code 的远端隔离模型）：
 *
 * - **DSH_HOME = base（机器级）。** 参考 dsh 官方：`DSH_HOME` 默认 `~/.dsh`，所有
 *   用户数据（profiles、sessions、storages、credentials.yaml）在一个根下。本工具
 *   把 `DSH_HOME` 设为 `base`（`~/.dsh-remote-explorer/btsd321/`），所有会话共享
 *   同一个 `DSH_HOME`。会话隔离通过 `--patch` 参数（每个会话独立的 patch 文件）和
 *   `sessions/<id>/.runtime/`（pid/log/token 等运行时状态）实现，不靠拆 `DSH_HOME`。
 *
 * - **dsh 装到 DSH_HOME 下的 node_modules。** 不再按版本分目录（`versions/dsh-<ver>/`），
 *   而是直接在 `base/` 下 `npm install @deepseek-ai/dsh@<version>`——dsh 入口在
 *   `base/node_modules/.bin/dsh`。升级时 npm 自己处理覆盖，版本检查仍用
 *   `dsh --version` 比对（与之前一致）。
 *
 * - **credentials.yaml 机器级共享。** 在 `base/.credentials.yaml`，所有会话共享
 *   同一份占位 grant record。dsh 的 `credentials-local` 包从 `$DSH_HOME/.credentials.yaml`
 *   读取——`DSH_HOME` 是 `base`，所以 credentials.yaml 天然在机器级。
 *
 * - **runtime 状态会话隔离。** pid/log/token/reverse-port/reverse-host/owner 仍在
 *   `sessions/<id>/.runtime/` 下——每个会话有独立的端口和进程，必须隔离。
 *
 * - **patch 文件会话隔离。** 每个会话的 patch（含凭据 baseURL 重定向 + pi-ai 供应商
 *   路由）在 `sessions/<id>/.runtime/patch.yml`，通过 `--patch` 参数传入。
 *
 * - **能力与实例分离。** 插件（`profiles/`）与 agent 能力（`.agents/`）是机器级共享，
 *   只有会话实例（.runtime）落在 `sessions/<id>/` 下。
 *
 * - **临时目录带 pid。** 来自 Zed（`download-<pid>-<文件名>`），避免并发安装撞车。
 *
 * 跨平台约束：远端一定是 POSIX，本机可能是 Windows。所以远端路径**一律用 `/`
 * 字符串拼接**，绝不能用 `node:path` 的 `join`——那在 Windows 上会产出反斜杠。
 */

import { createHash } from 'node:crypto';
import { hostname } from 'node:os';

/**
 * 本机主机名摘要（8 位 hex）。
 *
 * 临时目录名的一段：不同机器的本地 pid 可能相同（都是小整数），
 * 多人连同一主机时 pid 命名的 tmp 目录会撞——加主机名段消除。
 */
const LOCAL_HOST_TAG = createHash('sha1').update(hostname()).digest('hex').slice(0, 8);

/**
 * 本工具在远端家目录下的根目录（相对家目录的两级路径）。
 *
 * 两级结构的用意：顶层 `.dsh-remote-explorer/` 按工具名隔离，其下的作者名
 * 子目录 `btsd321/` 再按作者隔离——同名工具的不同发布方（或本工具未来换维护者）
 * 在远端各占一棵子树，互不覆盖。完全卸载 = `rm -rf ~/.dsh-remote-explorer`。
 *
 * 导出是因为探测阶段还不知道家目录绝对路径，需要在远端脚本里用
 * `"$HOME"/<此名>` 拼接。注意那种场合只能转义这个名字本身，
 * 不能把 `$HOME` 一起塞进 `quote()`——单引号会阻止 shell 展开。
 * 名字含 `/` 没有关系：`quote()` 的单引号包裹对多段路径同样成立。
 */
export const BASE_DIR_NAME = '.dsh-remote-explorer/btsd321';

/**
 * 远端路径集合。
 *
 * 由 {@link createRemotePaths} 基于探测到的家目录构造——不接受相对路径，
 * 因为 `~` 在非交互 shell 下的展开行为不可依赖。
 */
export interface RemotePaths {
  /** 根目录绝对路径，如 `/home/user/.dsh-remote-explorer/btsd321`。同时也是 DSH_HOME */
  readonly base: string;
  /**
   * DSH_HOME 目录（= base）。远端 dsh 进程的 `DSH_HOME` 环境变量指向此目录。
   *
   * 参考 dsh 官方 `~/.dsh` 结构：所有用户数据在一个根下。所有会话共享同一
   * `DSH_HOME`——profile、credentials.yaml 机器级共享，会话隔离靠 `--patch`
   * 参数和 `sessions/<id>/.runtime/`。
   */
  readonly dshHome: string;
  /**
   * 机器级 credentials.yaml（`base/.credentials.yaml`）。
   *
   * dsh 的 `credentials-local` 包从 `$DSH_HOME/.credentials.yaml` 读取——
   * `DSH_HOME` 是 `base`，所以此文件天然在机器级。所有会话共享同一份占位
   * grant record。
   */
  readonly credentialsFile: string;
  /** 镜像测速缓存文件 */
  readonly mirrorCache: string;
  /**
   * npm 缓存目录。
   *
   * 隔离要求：装机的 npm 缓存与 `_logs` 收在此处，不落远端共享的 `~/.npm`
   * （那是远端其他 npm 使用者的目录）。
   */
  readonly npmCache: string;
  /** 临时目录根 */
  readonly tmpRoot: string;
  /**
   * 引导安装临界区锁文件（flock）。
   *
   * 多人同远端账号并发引导时串起 base 目录的写临界区，见 install-lock.ts。
   */
  readonly installLockFile: string;
  /**
   * 主机级 agent 能力根目录（`DSH_AGENTS_HOME` 的指向）。
   *
   * 与本机 `~/.agents` 同形，刻意不放在会话目录下：dsh 的
   * skill-filesystem 把 `<agentsHome>/skills` 当作**用户级**根（rank 500），
   * 语义上属于「这台机器的使用者」而非「这一次会话」。
   *
   * 共享边界 = 远端账号：本工具的根目录就在该账号家目录下，持有该账号者
   * 本就共享这棵树里的一切。不按本机指纹分桶。
   */
  readonly agentsHome: string;
  /**
   * 主机级技能目录（`<agentsHome>/skills`）。
   *
   * dsh 的本地技能提供方只扫一层：`<root>/<name>/SKILL.md` 或
   * `<root>/<name>.md`。该根为 `user-agents` 源、rank 500，低于项目级
   * （rank 100/200），所以用户仓库内的项目技能仍然优先。
   */
  readonly agentsSkills: string;
  /**
   * 主机级 agent 能力写临界区锁文件（flock）。
   *
   * `.agents/` 共享后新增的风险：技能安装器的 `.skill-lock.json` 是**目录级
   * 单文件**，多会话并发装技能会互相覆盖。本工具自己发起的写入经此锁串行化，
   * 见 agents-lock.ts。
   */
  readonly agentsLockFile: string;
  /**
   * 主机级共享 profile 目录（dsh 官方 `$DSH_HOME/profiles/<name>/` 结构）。
   *
   * 插件安装/卸载的唯一真源。所有会话共享同一份安装——`DSH_HOME` 是 `base`，
   * dsh 启动时 `--profile web` 直接读 `base/profiles/web/`，不再需要会话级 symlink。
   *
   * @param platform - 平台 profile 名（如 `web`、`cli`、`desktop`）
   */
  hostProfileDir(platform: string): string;

  /**
   * 主机级 profile 的 package.json。
   * @param platform - 平台 profile 名
   */
  hostProfileManifest(platform: string): string;

  /**
   * 主机级 profile 的 node_modules。
   * @param platform - 平台 profile 名
   */
  hostProfileNodeModules(platform: string): string;

  /**
   * 某 Node 版本的安装目录。
   * @param version - 版本号，含前缀 v，如 `v24.21.0`
   */
  nodeDir(version: string): string;

  /**
   * 某 Node 版本的可执行文件。
   * @param version - 版本号，如 `v24.21.0`
   */
  nodeBin(version: string): string;

  /**
   * 某 Node 版本的 bin 目录（需要加进 PATH）。
   *
   * dsh 与 npm 的 shebang 都是 `#!/usr/bin/env node`，不把这个目录放进 PATH
   * 会直接报 `env: 'node': No such file or directory`（P0 实测）。
   * @param version - 版本号，如 `v24.21.0`
   */
  nodeBinDir(version: string): string;

  /**
   * dsh 安装目录（= base）。dsh 装在 `base/node_modules` 下，不再按版本分目录。
   *
   * 参考 dsh 官方安装方式：`npm install @deepseek-ai/dsh@<version>` 在 `DSH_HOME`
   * 下安装。dsh 入口在 `base/node_modules/.bin/dsh`。升级时 npm 自己处理覆盖，
   * 版本检查用 `dsh --version` 比对。
   */
  readonly dshDir: string;

  /**
   * dsh 可执行入口（`base/node_modules/.bin/dsh`）。
   *
   * 不再按版本分目录——dsh 装在 `base/node_modules` 下，入口固定在此路径。
   */
  readonly dshBin: string;

  /**
   * 某会话的运行时状态目录（pid、端口、日志）。
   * @param sessionId - 会话 id
   */
  sessionRuntime(sessionId: string): string;

  /**
   * 某会话的 pid 文件。
   *
   * 停进程必须靠这个文件或监听端口定位——**绝不能用 `pkill -f <模式>`**：
   * P0 清理时用 `pkill -f "dsh --profile remote"`，把执行该命令的 SSH 会话
   * 自己杀掉了，因为承载命令的 shell 命令行也含这个模式串。
   * @param sessionId - 会话 id
   */
  sessionPidFile(sessionId: string): string;

  /**
   * 某会话的启动日志。
   *
   * 这个文件同时是**令牌的唯一来源**：dsh 启动时把访问地址连令牌打在首行
   * （`dsh web: http://127.0.0.1:<端口>/?token=<43 字符>`），令牌不落盘到别处。
   * @param sessionId - 会话 id
   */
  sessionLogFile(sessionId: string): string;

  /**
   * 某会话的 patch 覆盖文件（含所有 patch 条目：llm-deepseek、llm-deepseek-account、llm-pi-ai）。
   *
   * 通过 `--patch` 参数传给 dsh。每个会话的 patch 独立——因为 baseURL 指向
   * 各会话独立的反向端口。所有 patch 条目合并写入此文件，不再分散到
   * settings.yaml 和 cordis.patch.yml。
   * @param sessionId - 会话 id
   */
  sessionPatchFile(sessionId: string): string;

  /**
   * 某会话的代理令牌文件（权限 600）。
   *
   * 存的是**占位令牌**（本机代理与远端 dsh 的共享密钥），不是真实 API key。
   * 会话重启复用同一远端进程或重新拉起时，编排层从这里读回令牌，
   * 保证换一个本机 CLI / 重连之后代理校验仍然通过。
   * @param sessionId - 会话 id
   */
  sessionProxyTokenFile(sessionId: string): string;

  /**
   * 某会话的反向端口文件。
   *
   * 反向端口一经启用就随会话固定：patch 里的 baseURL 指向它，
   * 运行中的远端进程也认它。换端口必须重启远端 dsh，所以复用会话时读回原值。
   * @param sessionId - 会话 id
   */
  sessionReversePortFile(sessionId: string): string;

  /**
   * 某会话的反向端点主机文件。
   *
   * 内容 = 单行主机地址（IPv4，带尾随换行）。WSL NAT 模式下是默认路由网关
   * IP——它随 WSL 重启变化，所以每次连接/重连都重探测重写；SSH 会话不写此
   * 文件，消费方在文件缺失或读取失败时回落 `127.0.0.1`。
   * @param sessionId - 会话 id
   */
  sessionReverseHostFile(sessionId: string): string;

  /**
   * 某会话的 owner 指纹文件（非秘密，644 即可）。
   *
   * 内容 = 发起本机指纹（hostname:os用户，可被 DSH_OWNER_TAG 覆盖）。
   * kill/clean 的跨用户 scope 化靠它区分「我的会话」与「他人的会话」——
   * VS Code 多用户模型下同远端账号的会话是共享的，但破坏性操作默认
   * 只动自己发起的。
   * @param sessionId - 会话 id
   */
  sessionOwnerFile(sessionId: string): string;

  /**
   * 一次性临时目录。
   * @param pid - 本机进程 pid，用于并发隔离
   * @param suffix - 区分用途的后缀
   */
  tmpDir(pid: number, suffix: string): string;
}

/**
 * 基于远端家目录构造路径集合。
 *
 * @param homeDir - 探测到的远端家目录绝对路径
 * @returns 路径集合
 * @throws Error 家目录不是绝对路径
 */
export function createRemotePaths(homeDir: string): RemotePaths {
  if (!homeDir.startsWith('/')) {
    throw new Error(`远端家目录必须是绝对路径，实际为 ${homeDir || '(空)'}`);
  }
  // 去掉可能的尾部斜杠，避免拼出双斜杠
  const home = homeDir.endsWith('/') ? homeDir.slice(0, -1) : homeDir;
  const base = `${home}/${BASE_DIR_NAME}`;

  return {
    base,
    dshHome: base,
    credentialsFile: `${base}/.credentials.yaml`,
    mirrorCache: `${base}/mirror-cache.json`,
    npmCache: `${base}/npm-cache`,
    tmpRoot: `${base}/tmp`,
    installLockFile: `${base}/tmp/install.lock`,
    agentsHome: `${base}/.agents`,
    agentsSkills: `${base}/.agents/skills`,
    agentsLockFile: `${base}/.agents/.lock`,
    hostProfileDir: (platform) => `${base}/profiles/${platform}`,
    hostProfileManifest: (platform) => `${base}/profiles/${platform}/package.json`,
    hostProfileNodeModules: (platform) => `${base}/profiles/${platform}/node_modules`,

    nodeDir: (version) => `${base}/node/${version}`,
    nodeBin: (version) => `${base}/node/${version}/bin/node`,
    nodeBinDir: (version) => `${base}/node/${version}/bin`,

    // dsh 装在 base/node_modules 下，不再按版本分目录
    dshDir: base,
    dshBin: `${base}/node_modules/.bin/dsh`,

    // 会话级路径：只有 .runtime 系列需要会话隔离
    sessionRuntime: (sessionId) => `${base}/sessions/${sessionId}/.runtime`,
    sessionPidFile: (sessionId) => `${base}/sessions/${sessionId}/.runtime/pid`,
    sessionLogFile: (sessionId) => `${base}/sessions/${sessionId}/.runtime/dsh.log`,
    sessionPatchFile: (sessionId) => `${base}/sessions/${sessionId}/.runtime/patch.yml`,
    sessionProxyTokenFile: (sessionId) => `${base}/sessions/${sessionId}/.runtime/proxy-token`,
    sessionReversePortFile: (sessionId) => `${base}/sessions/${sessionId}/.runtime/reverse-port`,
    sessionReverseHostFile: (sessionId) => `${base}/sessions/${sessionId}/.runtime/reverse-host`,
    sessionOwnerFile: (sessionId) => `${base}/sessions/${sessionId}/.runtime/owner`,

    tmpDir: (pid, suffix) => `${base}/tmp/${suffix}-${LOCAL_HOST_TAG}-${pid}`,
  };
}

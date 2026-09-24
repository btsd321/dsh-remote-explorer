/**
 * @file 远端路径规则
 * @description 本工具在远端创建的所有路径的**唯一真源**。任何模块都不得自己拼远端路径。
 *
 * 布局设计依据（Zed 与 VS Code 一致的做法）：
 *
 * - **安装按版本入名，多版本并存。** Zed 的远端二进制名形如
 *   `zed-remote-server-<通道>-<版本>`，存在性检查是直接执行 `<binary> version`
 *   成功即复用；VS Code 按 commit 分目录（`~/.vscode-server/bin/<commit>/`）。
 *   这样客户端升级时新旧版本自然隔离，不需要原地覆盖——而原地覆盖正是
 *   "运行中的进程占着文件，写入报 Text file busy" 这类故障的根因。
 *
 * - **会话状态与安装分离。** 安装在 `versions/` 下共享，每个会话有独立的
 *   `DSH_HOME`。这条之所以成立，是因为 dsh 的模块解析是双锚的——bundle 名先从
 *   dsh 安装位置解析、再从 profile 目录解析，所以"装在哪"与"DSH_HOME 指向哪"
 *   彼此解耦（P0 已实测）。
 *
 * - **临时目录带 pid。** 同样来自 Zed（`download-<pid>-<文件名>`），避免并发安装撞车。
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
  /** 根目录绝对路径，如 `/home/user/.dsh-remote-explorer/btsd321` */
  readonly base: string;
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
   * 多人同远端账号并发引导时串起版本目录的写临界区，见 install-lock.ts。
   */
  readonly installLockFile: string;
  /**
   * 远端插件仓库根（host × 远程 OS 用户级，VS Code ~/.vscode-server/extensions 对标）。
   *
   * 插件真源在此；会话 profile 连接时同步（硬链接拷贝 + bundles 合并），
   * 见 plugin-store.ts。
   */
  readonly pluginsStore: string;
  /** 插件仓库清单（dependencies + bundles 唯一真源） */
  readonly pluginsStoreManifest: string;
  /** 插件仓库 node_modules */
  readonly pluginsStoreNodeModules: string;

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
   * 某 dsh 版本的安装目录。
   * @param version - dsh 版本号，如 `0.1.7-rc.1`
   */
  dshDir(version: string): string;

  /**
   * 某 dsh 版本的可执行入口。
   * @param version - dsh 版本号
   */
  dshBin(version: string): string;

  /**
   * 某会话的 `DSH_HOME` 目录。
   * @param sessionId - 会话 id
   */
  sessionHome(sessionId: string): string;

  /**
   * 某会话的 profile 目录。
   * @param sessionId - 会话 id
   */
  sessionProfile(sessionId: string): string;

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
   * 自己杀掉了，因为承载命令的 shell 其命令行也含这个模式串。
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
   * 某会话的 patch 覆盖文件。
   * @param sessionId - 会话 id
   */
  sessionPatchFile(sessionId: string): string;

  /**
   * 某会话的 settings.yaml（本机 settings 的远端镜像，provider baseURL 已重定向）。
   *
   * dsh ≤0.1.6 的用户设置文档放在 `$DSH_HOME/settings.yaml` 且热重载——
   * 会话的 DSH_HOME 即会话目录，所以这份镜像落在这里会被旧版远端 dsh 直接读取。
   * dsh 0.1.7 起 settings.yaml 改为**启动时一次性导入**进 profile 的
   * cordis.patch.yml（导入后改名 `.imported`，运行中不再读）——镜像对新版
   * 只在每次进程启动时生效一次，供应商配置的持续热生效由
   * {@link RemotePaths.sessionHomePatchFile} 承接。
   * 注意**只镜像 settings**（凭据引用，不含密钥），绝不镜像
   * `$DSH_HOME/.credentials.yaml`（可能含真实密钥）。
   * @param sessionId - 会话 id
   */
  sessionSettingsFile(sessionId: string): string;

  /**
   * 某会话的 `$DSH_HOME/cordis.patch.yml`（dsh 的 home patch 层）。
   *
   * dsh 0.1.6 与 0.1.7 都把它列为 patch 层叠之一（profile 的
   * cordis.patch.yml 之上、`--patch` overlay 之下）且**受 hmr 热监听**——
   * pi-ai 供应商路由写进这一层，重写即热生效，不受 0.1.7 移除
   * settings.yaml 运行时读取的影响。
   * @param sessionId - 会话 id
   */
  sessionHomePatchFile(sessionId: string): string;

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
    mirrorCache: `${base}/mirror-cache.json`,
    npmCache: `${base}/npm-cache`,
    tmpRoot: `${base}/tmp`,
    installLockFile: `${base}/tmp/install.lock`,
    pluginsStore: `${base}/plugins`,
    pluginsStoreManifest: `${base}/plugins/package.json`,
    pluginsStoreNodeModules: `${base}/plugins/node_modules`,

    nodeDir: (version) => `${base}/node/${version}`,
    nodeBin: (version) => `${base}/node/${version}/bin/node`,
    nodeBinDir: (version) => `${base}/node/${version}/bin`,

    dshDir: (version) => `${base}/versions/dsh-${version}`,
    dshBin: (version) => `${base}/versions/dsh-${version}/node_modules/.bin/dsh`,

    sessionHome: (sessionId) => `${base}/sessions/${sessionId}`,
    sessionProfile: (sessionId) => `${base}/sessions/${sessionId}/profiles/remote`,
    sessionRuntime: (sessionId) => `${base}/sessions/${sessionId}/.runtime`,
    sessionPidFile: (sessionId) => `${base}/sessions/${sessionId}/.runtime/pid`,
    sessionLogFile: (sessionId) => `${base}/sessions/${sessionId}/.runtime/dsh.log`,
    sessionPatchFile: (sessionId) => `${base}/sessions/${sessionId}/.runtime/patch.yml`,
    sessionSettingsFile: (sessionId) => `${base}/sessions/${sessionId}/settings.yaml`,
    sessionHomePatchFile: (sessionId) => `${base}/sessions/${sessionId}/cordis.patch.yml`,
    sessionProxyTokenFile: (sessionId) => `${base}/sessions/${sessionId}/.runtime/proxy-token`,
    sessionReversePortFile: (sessionId) => `${base}/sessions/${sessionId}/.runtime/reverse-port`,
    sessionOwnerFile: (sessionId) => `${base}/sessions/${sessionId}/.runtime/owner`,

    tmpDir: (pid, suffix) => `${base}/tmp/${suffix}-${LOCAL_HOST_TAG}-${pid}`,
  };
}

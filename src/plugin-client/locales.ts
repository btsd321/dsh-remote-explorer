/**
 * @file 浏览器半 locale 字典（zh/en）
 * @description 面板全部文案。键集在 zh 与 en 必须一致（en 兜底——dsh 的
 *              locale 契约要求回退链终止于英语）。键名稳定，改文案不改键。
 */

/** 面板文案键集（LocaleNamespaceMap 增广用它做类型） */
export type RemoteExplorerLocaleKey =
  | 'nav' | 'sectionIntro'
  | 'host' | 'hostPlaceholder' | 'refreshHosts'
  | 'cwd' | 'cwdPlaceholder'
  | 'advanced' | 'localPort' | 'forceRestart' | 'refreshMirrors'
  | 'nodeVersion' | 'dshVersion' | 'privateKey'
  | 'password' | 'passwordWarning'
  | 'connect' | 'connecting' | 'connectCurrent' | 'connectNew'
  | 'enterCurrent' | 'openNew' | 'countdown' | 'cancelCountdown'
  | 'intentDisconnect' | 'intentStop' | 'intentExecute' | 'intentCancel'
  | 'sessions' | 'noSessions' | 'disconnect' | 'stopRemote' | 'open' | 'external'
  | 'pluginsTitle' | 'pluginsNoSession' | 'pluginsEmpty' | 'pluginsBundle'
  | 'pluginsRemove' | 'pluginsInstall' | 'pluginsSpecPlaceholder' | 'pluginsEnabled'
  | 'stateIdle' | 'stateConnecting' | 'stateConnected' | 'stateHeartbeatMissed'
  | 'stateReconnecting' | 'stateReconnectFailed' | 'stateReconnectExhausted' | 'stateDisconnected'
  | 'log' | 'logEmpty' | 'connectError' | 'loadError' | 'retry'
  | 'missingKeys';

/** 中文字典 */
export const zh: Record<RemoteExplorerLocaleKey, string> = {
  nav: '远程 SSH 会话',
  sectionIntro: '把 dsh 装到远程主机上运行，本机只留浏览器；LLM 凭据不离开本机。会话维持在本 dsh 进程里——退出 dsh 会按配置断开或保留远端。',
  host: '主机',
  hostPlaceholder: 'ssh config 别名，或 user@host[:port]',
  refreshHosts: '刷新主机列表',
  cwd: '远端目录',
  cwdPlaceholder: '/home/you/project（留空 = 远端家目录）',
  advanced: '高级选项',
  localPort: '本机端口（0 = 自动分配）',
  forceRestart: '强制重启远端 dsh',
  refreshMirrors: '重新测速镜像源',
  nodeVersion: 'Node 版本（留空 = 默认）',
  dshVersion: 'dsh 版本（留空 = 默认）',
  privateKey: '私钥路径（留空 = 用 ssh config）',
  password: 'SSH 密码',
  passwordWarning: '密码仅存宿主 dsh 进程内存，不落盘、不进日志；留空则要求主机已配置 IdentityFile',
  connect: '连接',
  connecting: '连接中…',
  connectCurrent: '在当前标签页连接',
  connectNew: '在新标签页连接',
  enterCurrent: '进入（当前标签）',
  openNew: '新标签打开',
  countdown: '会话已就绪，切入远端窗口倒计时',
  cancelCountdown: '取消',
  intentDisconnect: '远端窗口请求关闭此远程连接（本机隧道与会话登记将解除，远端 dsh 保留）',
  intentStop: '远端窗口请求停止远端 dsh 并关闭此远程连接',
  intentExecute: '执行',
  intentCancel: '取消',
  sessions: '会话',
  noSessions: '当前没有会话',
  pluginsTitle: '远端插件（选中会话）',
  pluginsNoSession: '选中一个会话后管理它远端 profile 的插件',
  pluginsEmpty: '远端 profile 还没有插件依赖',
  pluginsBundle: 'bundle',
  pluginsRemove: '卸载',
  pluginsInstall: '安装',
  pluginsSpecPlaceholder: '包名或 包名@版本（交给远端 pnpm）',
  pluginsEnabled: '启用（hmr 热生效）',
  disconnect: '断开',
  stopRemote: '同时停止远端 dsh',
  open: '打开',
  external: '外部（其他本机进程维持，只读；管理请用对应进程或 CLI）',
  stateIdle: '未开始',
  stateConnecting: '连接中',
  stateConnected: '已连接',
  stateHeartbeatMissed: '心跳丢失',
  stateReconnecting: '重连中',
  stateReconnectFailed: '重连失败',
  stateReconnectExhausted: '重连次数用尽',
  stateDisconnected: '已断开',
  log: '进度日志',
  logEmpty: '点击会话行查看进度日志',
  connectError: '连接失败',
  loadError: '加载失败',
  retry: '重试',
  missingKeys: '本机缺少的 LLM key 环境变量',
};

/** 英文字典（键集与 zh 一致） */
export const en: Record<RemoteExplorerLocaleKey, string> = {
  nav: 'Remote SSH Sessions',
  sectionIntro: 'Installs dsh on a remote host and serves its UI to this browser; LLM credentials never leave this machine. Sessions live in this dsh process — quitting dsh disconnects or keeps the remote per config.',
  host: 'Host',
  hostPlaceholder: 'ssh config alias, or user@host[:port]',
  refreshHosts: 'Refresh host list',
  cwd: 'Remote directory',
  cwdPlaceholder: '/home/you/project (empty = remote home)',
  advanced: 'Advanced',
  localPort: 'Local port (0 = auto)',
  forceRestart: 'Force-restart remote dsh',
  refreshMirrors: 'Re-run mirror speed test',
  nodeVersion: 'Node version (empty = default)',
  dshVersion: 'dsh version (empty = default)',
  privateKey: 'Private key path (empty = ssh config)',
  password: 'SSH password',
  passwordWarning: 'The password stays in the host dsh process memory only — never written to disk or logged; leave empty to require an IdentityFile on the host',
  connect: 'Connect',
  connecting: 'Connecting…',
  connectCurrent: 'Connect in current tab',
  connectNew: 'Connect in new tab',
  enterCurrent: 'Enter (current tab)',
  openNew: 'Open in new tab',
  countdown: 'Session ready — entering remote window in',
  cancelCountdown: 'Cancel',
  intentDisconnect: 'The remote window asked to close this remote connection (local tunnel and session registration go away; remote dsh stays)',
  intentStop: 'The remote window asked to stop the remote dsh and close this remote connection',
  intentExecute: 'Execute',
  intentCancel: 'Cancel',
  sessions: 'Sessions',
  noSessions: 'No sessions',
  pluginsTitle: 'Remote plugins (selected session)',
  pluginsNoSession: 'Select a session to manage the plugins in its remote profile',
  pluginsEmpty: 'No plugin dependencies in the remote profile yet',
  pluginsBundle: 'bundle',
  pluginsRemove: 'Uninstall',
  pluginsInstall: 'Install',
  pluginsSpecPlaceholder: 'package or package@version (handed to remote pnpm)',
  pluginsEnabled: 'Enabled (hot-applied via hmr)',
  disconnect: 'Disconnect',
  stopRemote: 'Also stop remote dsh',
  open: 'Open',
  external: 'External (kept by another local process, read-only; manage it there or via the CLI)',
  stateIdle: 'Idle',
  stateConnecting: 'Connecting',
  stateConnected: 'Connected',
  stateHeartbeatMissed: 'Heartbeat missed',
  stateReconnecting: 'Reconnecting',
  stateReconnectFailed: 'Reconnect failed',
  stateReconnectExhausted: 'Reconnect exhausted',
  stateDisconnected: 'Disconnected',
  log: 'Progress log',
  logEmpty: 'Select a session row to view its progress log',
  connectError: 'Connect failed',
  loadError: 'Load failed',
  retry: 'Retry',
  missingKeys: 'LLM key env vars missing on this machine',
};

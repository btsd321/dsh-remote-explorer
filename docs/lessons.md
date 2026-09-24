# 经验教训与硬约束

本文档记录开发过程中实测踩坑得出的硬约束。**改相关代码前必读对应条目**。

---

## SSH 传输

**1. 主机配置来自 `~/.ssh/config`，不做持久化；也支持 `user@host[:port]` 直连。** `listHosts()` / `resolveHost(alias)` 用 `ssh-config` 库的 `compute()` 合并 `Host *` 默认值并递归解析 `ProxyJump` 跳板机链；config 里不存在的别名若匹配 `user@host[:port]` 语法则按直连处理（无 IdentityFile、无跳板机）。解析结果带模块级缓存，改了 config 文件必须调 `refreshConfig()`。认证优先级：`--private-key` > `--password` > config `IdentityFile` > 交互式密码提示（无 IdentityFile 且在交互终端时提示，不回显，最多重试 3 次；密码只存进程内存，绝不落盘/入日志）。`--password` 会打印泄露风险警告——明文出现在命令行、进程列表与 shell 历史里，是用户显式选择，工具只警告不阻止。

**5. 远端命令统一经 `sh -c` 包裹。** `SshTransport.exec()` 已做这件事。ssh exec 用的是用户登录 shell，而各 shell 行为有实质差异：zsh 遇到未匹配的 glob 会直接报 `no matches found` 并中止，bash 则保留字面量。写远端脚本时还要注意**多行命令用 `\n` 连接，不能用空格**——`head=$(...) if [ ... ]` 是语法错误，整段脚本在解析期就失败，表现为所有探测"无输出"。

**6. 拼进远端命令的任何动态值必须过 [src/util/shell-quote.ts](../src/util/shell-quote.ts) 的 `quote()`。** 不要用模板字符串直接插值，那等于命令注入。

转义会阻止 shell 展开变量，这一点有两个必须记住的后果：

- `quote('$HOME/x')` 里的 `$HOME` 不会展开。需要展开时写 `"$HOME"/${quote(名字)}`。
- **要在 PATH 前面加目录，用 `exec()` 的 `pathPrefix` 选项，不要走 `env`。** 写 `env: { PATH: '<新>:$PATH' }` 会让 `$PATH` 变成字面量，远端 PATH 只剩这一个目录，连 `rm`、`mkdir` 都找不到——表现为所有远端命令莫名失败。

**8. 停远端进程不能用 `pkill -f <模式>`。** 承载命令的 shell 其命令行也含该模式，会把自己的 SSH 会话一起杀掉（实测踩过）。用会话目录下的 pid 文件，或按监听端口定位。

**13. 内部文件传输走池化 SFTP（P2 起），printf-over-exec 只是回退。** `transport/ssh-transport.ts` 维护每连接一条的池化 SFTP 会话（占 1 个 admin 配额，会话内 4 路并发不新开通道），带每操作超时与「死连接作废重试一次」（错误特征见 `STALE_SFTP_PATTERN`）。文本写入统一走 `transport/write-text.ts` 的 `writeRemoteTextFile`（SFTP 主路径，远端没开 sftp 子系统时回退 printf；`tolerant` 区分尽力而为/严格语义）。**二进制内容（图像等资源）没有回退路径**——shell 重定向过不了二进制，只能 SFTP。凭据材料（proxy-token 600 权限）刻意保留 exec+umask 077 单命令原子写，不切换。

## WSL 传输

**W1. WSL 传输通过 `wsl.exe` CLI 交互，不走 SSH。** `WslTransport` 实现 `RemoteTransport` 接口，命令执行用 `wsl.exe -d <distro> -e bash -c <cmd>`，文件传输优先走 UNC 路径（`\\wsl.localhost\<distro>\...`）直接读写，回退到 `wsl -e cat/printf`。

**W2. WSL 进程 detach 不能用 `setsid nohup &`。** `wsl.exe -e` 退出时会杀掉 WSL 内所有子进程（WSL 实例随之关闭）。必须用 PowerShell `Start-Process -WindowStyle Hidden` 启动 `wsl.exe` 作为独立进程，runner 脚本内部 `exec` 替换自身为 dsh。Node.js spawn 的 `windowsHide` (CREATE_NO_WINDOW) 对控制台子系统程序无效。

**W3. WSL2 localhost forwarding 默认开启。** Windows `localhost:PORT` 自动转发到 WSL 内 `127.0.0.1:PORT`（NAT/mirrored 模式均有效），所以 `openChannel` 始终用 `127.0.0.1` 连接即可，不需要获取 VM IP。首次连接有约 3-5 秒冷启动延迟。反向方向（WSL → Windows）不走此路径。

**W4. WSL 仅在 Windows 平台可用。** 面板通过 `navigator.platform` 检测，非 Windows 不显示 WSL 入口。点击 WSL 卡片时通过后端 `/wsl-distros` API 检测可用性，未安装则显示安装引导。

**W5. WSL 内 dsh 需要 XDG 文档目录。** dsh 用 `xdg-user-dir DOCUMENTS` 创建默认工作区，如果返回 home 目录会报错。首次使用需执行 `xdg-user-dirs-update` 或手动创建 `~/Documents`。

## 远端安装与引导

**2. 远端安装按版本入名，多版本并存，不做 hash 校验。** 路径形如 `~/.dsh-remote-explorer/btsd321/versions/dsh-<版本>/`、`~/.dsh-remote-explorer/btsd321/node/<版本>/`，存在性检查是直接执行 `<bin> --version` 成功即复用（Zed 的做法，完整性由 npm 自己兜底）。这是为了避免升级时原地覆盖——那正是"运行中的进程占着文件，写入报 Text file busy"的根因。

**3. 安装共享、会话状态隔离。** dsh 装在 `versions/` 下所有会话共享；每个会话有独立的 `DSH_HOME=~/.dsh-remote-explorer/btsd321/sessions/<会话 id>/`。这条成立是因为 dsh 的模块解析是双锚的（bundle 名先从 dsh 安装位置解析、再从 profile 目录解析），所以"装在哪"与"`DSH_HOME` 指向哪"解耦。`DSH_HOME` 只能走 `env` 前缀传，它是 bootstrap-only，任何 `.env` 都改不了它。

**4. 所有远端路径由 [src/provision/remote-paths.ts](../src/provision/remote-paths.ts) 统一提供**，任何模块不得自己拼。构造远端路径一律用 `/` 拼字符串，**不要用 `node:path` 的 `join`**——本机可能是 Windows，会产出反斜杠。

**6b. 远端安装与 dsh 版本必须显式指定，不要依赖 dist-tag。** registry 上 `@deepseek-ai/dsh` 的 `latest` 指向 0.1.5-rc.2，比 `rc` 的 0.1.7-rc.1 旧。[src/provision/provisioner.ts](../src/provision/provisioner.ts) 会先把标签解析成具体版本，安装命令里绝不出现标签。

**9. 远端 Node 必须用 v24 系，且装完要做稳定性自检。** v22.23.2 在 aarch64 上起进程崩溃率 35%（V8 初始化 isolate 随机失败，报 OOM 但内存充足）。`npm install` 要起几十次 node，必然失败，且报错会误导到最后一个失败的包。[src/provision/probe.ts](../src/provision/probe.ts) 的 `checkNodeStability()` 强制自检，容错次数为 0。

**10. 镜像测速在远端执行，必须带 `-L` 并校验响应内容。** 测的是远端到镜像的连通性，本机测没意义。阿里源对 `index.json` 返回 302，只测时间会把重定向页当成成功并选出错误的"最快"镜像。腾讯与华为镜像已从候选移除（DNS 解析失败）。

**11. 远端落盘隔离契约（对标 VS Code 的 `~/.vscode-server` 单根自治模型）。** 本工具在远端的一切落盘都在 `~/.dsh-remote-explorer/btsd321/` 内；远端 `~/.dsh`（官方 dsh 的家）、`~/.npm`（远端 npm 使用者共享的缓存）**从不被本工具写入**。完全卸载 = `rm -rf ~/.dsh-remote-explorer/btsd321`。为此做的三件事，改相关代码时别破坏：

- 装机的 npm 命令带 `npm_config_cache=~/.dsh-remote-explorer/btsd321/npm-cache`（[src/provision/dsh-installer.ts](../src/provision/dsh-installer.ts) 的 `npmEnv`）——npm 的缓存与 `_logs` 一并收进我们的根
- runner 脚本给远端 dsh 设 `DSH_AGENTS_HOME=<会话目录>/agents`——dsh 的 skill-filesystem 默认会读机器全局 `~/.agents`，不设就加载了别人的 skills
- 每会话 `DSH_HOME` 本身就是最强的隔离：dsh 契约是「所有用户数据在一个根」，settings/凭据/附件/profiles 全随之走（源码逐一核实过；唯一例外是 `~/.agents`，已用 env 堵上）

已知低风险共享：远端 pnpm store（`~/.local/share/pnpm`）——仅当有人主动在远端跑 `dsh plugin` 才触及，内容寻址并发安全，文档说明即可，不做隔离。`doctor` 的「隔离检查」段会报告占用与官方 `~/.dsh` 的存在性。

## 隧道与网络

**8b. 本机监听器必须跨重连存活。** 重连时只换传输引用（`LocalForward.swapTransport`），本机端口不变——端口一变，用户已打开的浏览器标签全部失效。这正是传输接口提供 `openChannel`（只开一条通道）而非 `forwardOut`（本机监听 + 转发一体）的原因：监听器归 [src/tunnel/forward-local.ts](../src/tunnel/forward-local.ts) 持有，传输实例可以被替换。

**8b-2. raw TCP socket 的 error 监听器必须在任何 destroy 之前挂上。** [src/tunnel/forward-local.ts](../src/tunnel/forward-local.ts) 的连接回调里第一件事就是 `socket.on('error', ...)`：无监听器的 socket 被带 error 参数 destroy 时，未处理 `error` 事件会**直接掀翻整个进程**（用户实测踩过：通道配额耗尽 → pipe 失败路径 destroy(Error) → CLI 崩溃）。失败路径只调用不带参数的 `socket.destroy()`。

**8b-3. forward 通道配额按浏览器稳态并发取，不能拍脑袋取小。** 浏览器对单一 web 主机常规保持 6 条以上 HTTP/1.1 keep-alive 连接（稳态占用，不释放），加 WebSocket 与 SSE，上限 5 在正常使用中就会耗满，之后每条新连接排队 30 秒再失败。direct-tcpip 通道没有等同于 sshd `MaxSessions` 的低值硬上限（`ssh -L` 的常规用法就是几十条并发），[src/transport/channel-pool.ts](../src/transport/channel-pool.ts) 的 forward 默认上限取 64；admin 类（受 `MaxSessions` 约束）仍是 3。

## 会话管理

**8c. 会话表主键是 `(sessionId, localPid)` 组合，不是 `sessionId` 单独。** 会话 id 是**远端**身份：同别名同目录的多个本机 CLI 会共享同一个远端 dsh（后来者探到既有进程即复用），它们是同一远端会话的多个本机视图，各自维持自己的隧道端口。只按 sessionId 去重会让后启动的 CLI 挤掉先前那条记录，于是 `status` 漏报一个仍在工作的隧道。`removeSession(id, localPid)` 删单个视图，`removeSession(id)` 删该会话全部视图（`kill` 用后者）。

**8f. 心跳是三层判据，一条命令拿全。** 进程存活（`kill -0`）+ 端口监听（`ss`/`netstat`）+ **HTTP 应用级**（带会话令牌 curl 根路径，任何非 000 状态码即健康）——第三层能发现"进程在、端口在、但 webserver 僵死"的故障，前两层探测不到。改 [src/session/heartbeat.ts](../src/session/heartbeat.ts) 时保持单命令形态：每 5 秒一次心跳，拆成三次 exec 会在高延迟链路上占配额。

## 凭据与安全

**7. 远端 dsh 已内置令牌认证。** 启动输出形如 `dsh web: http://127.0.0.1:<端口>/?token=<43 字符>`，无令牌访问返回 401，令牌换 `HttpOnly` + `SameSite=Strict` cookie。**令牌不落盘**，只在启动输出首行——所以启动日志文件既是诊断来源也是令牌唯一来源，不能丢。

**8d. 凭据路径：占位令牌 + 落盘材料 + 跨重连的代理。** 三件事必须一起成立，改任何一件都要读 [src/session/session-manager.ts](../src/session/session-manager.ts) 的 open()：

- 远端进程环境里的 key 变量（`DEEPSEEK_API_KEY`等）是**代理令牌**（随机值）不是真实 key——dsh 缺 key 会在请求发出前就报 `MISSING_CREDENTIAL`，代理根本收不到，所以必须有占位值。真实 key 只在本机进程（`process.env[keyEnv]` → [src/credential/tunnel-proxy.ts](../src/credential/tunnel-proxy.ts) 注入）。
- **代理是多供应商路由表**：DeepSeek 原生通道走 `/anthropic` 前缀（patch 重定向），`llm-pi-ai` 供应商走 `/r/<名>` 前缀（路由自动从本机 `~/.dsh/settings.yaml` 的 `llm-pi-ai.providers` 提取，见 [src/credential/provider-routes.ts](../src/credential/provider-routes.ts)）。转发时请求前缀替换成上游自身路径。每条路由的 keyEnv 各自检查，缺哪个只影响哪个供应商。
- **远端 settings 双写**（0.1.7 适配）：本机 settings.yaml 整体复制到会话 `DSH_HOME/settings.yaml`（dsh ≤0.1.6 运行时热读；0.1.7 起只在每次进程启动时一次性导入进 profile 的 cordis.patch.yml，导入后改名 `.imported`），**同时**把 pi-ai 供应商路由写进 home patch 层 `DSH_HOME/cordis.patch.yml`（0.1.6/0.1.7 都存在且受 hmr 热监听——供应商的持续热生效靠它，见 provider-routes 的 renderProviderTunnelPatch；patch `config` 是整块替换，必须携带完整 `llm-pi-ai` 段）。两份都仅重定向 provider baseURL。**只镜像 settings（凭据引用），绝不镜像 `.credentials.yaml`**（可能含真实密钥，落远端违背整个设计）。
- **代理令牌与反向端口随会话固定**，落盘远端 `.runtime/proxy-token`（600）与 `.runtime/reverse-port`。反向端口写进了 patch 的 `baseURL`，运行中的远端进程认它——复用、重连、换本机 CLI 必须读回同一组值，别在启动时重新生成。
- 代理实例（本机回环 http.Server）与正向监听器一样**跨重连存活**，重连只重挂 `forwardIn`。多视图共享会话时反向端口先到先得，挂不上是警告不是错误。

**8e. 本机 Node v24.14.0 的 fetch 拒绝一切流式请求体。** ReadableStream / 异步生成器 / `new Request` 实测全抛 `expected non-null body source`（字符串与 Buffer 正常）。所以代理的请求体整体缓冲后转发；流式要紧的响应侧（SSE）保持 pipe 直传。另：ssh2 的通道**不能**直接 `emit('connection')` 喂给 http.Server（缺 `setTimeout` 等 Socket 接口），代理走本机回环 TCP 对接。

## dsh 插件形态

**12. dsh 插件形态的硬约束（全部实测踩过，改 src/plugin*/ 前必读）。**

- **宿主产物必须是 ESM**（`lib/index.js`，esbuild `format: 'esm'`）。CJS 产物 `require()` ESM-only 的 `@deepseek-ai/dsh-tools` 会直接崩（Node 24 `ERR_INTERNAL_ASSERTION`）；peer 裸导入只有走 ESM 解析链才能命中 profile 的安装闭包供给位（`$DSH_HOME/profiles/node_modules`，cordis 单实例的命脉——0.1.6 是物理回退链接，0.1.7 起改为内存拦截层，位置与语义不变）。ssh2 的惰性 `require('net')` 用 createRequire banner 化解（`HOST_BANNER` 还补了 `__filename/__dirname`——ssh2 的 crypto.js 用 `__dirname` 定位资源，缺了初始化就崩）。
- **entry id 与插件名统一 `dsh-remote-explorer`，locale 命名空间 `dshRemoteExplorer`，全局面板 id `remote-sessions`**（main 槽 key 与 sidebar.panellist id 同值，branded `MainPanelId` 需断言）；cordis.patch.yml 的 entry id 不能叫 `dsh-remote`（第三方 flymysql 插件占用，同 profile 共存会被 loader 拒绝）。浏览器半的 `__ModuleLoader__.load({ id })` **必须等于包名**（graph 行以包名为键），由 build 脚本从 package.json 注入，别手写。
- **命令名必须匹配 `/^[a-z][a-z0-9_-]*$/`**——非法字符（尤其点号）会让整个 dsh 启动失败；**defineTool 的每个显式 `type:'object'` 节点必须写 `additionalProperties`**——缺失是 authorError，宿主启动即崩。这两条 `scripts/check-plugin.ts` 有静态护栏，发布前必跑。
- **面板路由只走 `connection.fetch.register` 的 `/api/dsh-remote-explorer/*` 已鉴权通道**，绝不注册裸 webServer 路由（无鉴权，宿主配 0.0.0.0 时会话元数据+写操作直接暴露）。冒烟判读：不带凭据 curl ping 得 **401** = 正常，404 = 插件没挂上，200 = 绕过了鉴权（安全回归）。
- **Config 必须用 schemastery**（zod 会被 loader 拒绝），3.18 无 enum/optional API——全字段给 default。**Config 里永远不加 password 字段**（随 patch 层落盘 = 明文写磁盘）；面板密码走 POST body → 进程内存 fixed 模式，agent 工具永不接受密码。
- 可选服务（commands/connection）一律 `ctx.get()` 或 `ctx.inject([...])` 反应式获取，绝不属性直取；一切注册走 `ctx.effect()` 返回清理函数。**dispose 语义**：宿主退出默认 `close({ stopRemote: true })`（用户拍板，对齐 CLI Ctrl-C），`keepRemoteOnDispose` 可保留。
- dev 沙箱（`scripts/dev-plugin.ts`）：Windows 上 pnpm 对 `file:` 依赖是**硬链接拷贝**（同 inode）——同步脚本按「同 inode 跳过」处理，别改成无脑 rm+cp（rm 会顺着链接删、cp 会因 src=dest 抛错）；组合脚本 URL 从 HTML 提取后要把 `&amp;` 还原成 `&`；带令牌首访首页是 **303 + set-cookie**（令牌换 Cookie），node fetch 要 `redirect:'manual'` 手动接力。
- **桌面壳（DeepSeek Harness Electron，反编译 app.asar 核实）是单 OS 窗口，网页拿不到"开新 OS 窗口"通道**：主窗口 `setWindowOpenHandler` 把一切 http/https 弹窗转 `shell.openExternal`，`will-navigate` 只放行 `dsh-app:` 协议与同 origin http——所以面板里的会话 URL 在桌面端既不能弹窗也不能当前窗口导航，两条路都落到外部浏览器。应用内承载远程页面的唯一合法通道是 **browser lease 桥**：preload 在应用文档暴露 `window.dshDesktop.browser`（`acquire(workspace)`/`release(lease)`/`onOpenRequested`），webview 必须以 `about:blank#<lease>` 创建并带 acquire 返回的 partition（主进程 `will-attach-webview` 校验，失败即 prevent），**首次 dom-ready 后才能 `loadURL`**，关闭必 `release`。整套封装在 [src/plugin-client/desktop-bridge.ts](../src/plugin-client/desktop-bridge.ts) + [src/plugin-client/remote-window.tsx](../src/plugin-client/remote-window.tsx)。浮层是 **body 级 vanilla DOM（最高 z-index）**而非 slot 内 React：浏览器半 bundle 只 external `react`、没有 react-dom（用不了 createPortal），且主窗口标题栏按钮（收起侧边栏/应用/编辑）渲染在比 `shell.overlay`（z-20）更高的层叠上下文，slot 内盖不住。**不叠加自建顶栏**：远端 web 界面铺满整窗（web 形态本就不渲染「应用/编辑」标题栏，那是桌面壳特性），返回/关闭/停止走远端 handoff pill——桌面端 managerUrl 传假意图 origin `OVERLAY_INTENT_ORIGIN`，于是「返回」的 `window.open` 被桌面壳 deny 并经 `onOpenRequested` 转发给浮层、「关闭/停止」的 `location.href` 被浮层监听 webview `will-navigate` 截获，handoff 零改动且不再只读。**webview 绝不能用 display:none 创建/attach**：guest view 隐藏时量不到真实尺寸、之后显示也不重新布局（实测只渲染顶部一条、下面全白）；加载态用不透明状态层盖在 webview 之上。环境判别 `isDesktopShell()`（网页形态无 preload 恒 false）；桌面路径**只能在真实桌面端验证**，dev-plugin 沙箱是网页形态测不到。

## 远端窗口交接与插件仓库

**14. 远端窗口交接组件（handoff）是会话级合成包，按标记幂等安装。** 0.4.0 的「远端不装插件」红线经用户拍板解除——前提是每个会话的远端 dsh 跑在独立 `DSH_HOME`（`sessions/<id>/`），与远端他人的 `~/.dsh` 零交集。引导期把合成包 `dsh-remote-handoff`（宿主半 + 浏览器半 + 空 patch，产物经 define 内联进宿主半 bundle，单文件分发形态运行期没有相邻 lib/）写进会话 profile 的 node_modules 并登记 `dsh.profile.bundles`；远端已有包目录则一条 `test -f` 跳过。老会话补装时若远端进程仍存活复用，菜单要等下一次远端重启才出现（迟到但不缺席，降级期间远端页面零感知）。通道是三段鉴权链：远端页面 → 同源 `/api/dsh-remote-handoff/*`（远端 dsh Cookie 栅栏）→ 反向隧道 `127.0.0.1:<反向端口>/manage/*`（代理令牌闸门，与 LLM 路由同纪律）→ 本机监督器闭包。manage 响应只含状态/日志/元信息，不含凭据。**「关闭/停止并返回」必须是 navigate-then-act**：断开会立刻杀死经隧道服务的远端页面，所以远端菜单先同标签导航回管理页（带 `#handoff-disconnect=` / `#handoff-stop=` intent hash），由管理页加载后确认执行——VS Code「Close Remote Connection 后窗口重载回本地」的拓扑等价物。窗口形态对环境分流：桌面端单按钮开**整窗浮动桌面**（见第 12 条的桌面壳约束）；浏览器端对齐 VS Code 双入口——面板「在当前标签页连接」（就绪后 3 秒倒计时同标签切入，可取消）与「在新标签页连接」（弹窗拦截不允许无手势开标签，会话行按钮接管）。CLI 形态没有管理页，meta 的 managerUrl 缺省，远端菜单自动降级只读（桌面端同理不传）。

**15. 远端插件仓库是用户级（host × 远程 OS 用户），对标 VS Code `~/.vscode-server/extensions/`。** store 在 `base/plugins/`（pnpm 真目录 + manifest 唯一真源，[plugin-store.ts](../src/provision/plugin-store.ts)）；**会话 profile 的 node_modules 是指向 store 的整体 symlink**——会话零包副本；profile 里同时写 `.npmrc` 把 `virtual-store-dir` 钉到 store 的 `.pnpm`（不钉则远端窗口原生 UI 在 profile 目录跑 pnpm 报 `ERR_PNPM_UNEXPECTED_VIRTUAL_STORE`，实测踩过）。peer 裸导入靠 store 内三条回退链接闭环（`@deepseek-ai/` 整目录、`cpu-features`、`nan` → dsh 安装树，走 Node 原生祖先链物理解析——插件 real path 在 store，不经 dsh 的解析干预；0.1.7 起 dsh 在 `$DSH_HOME/profiles/node_modules` 的物理回退链接已改为内存拦截层，对本布局零影响，也不删外部链接——`.dsh-module-fallback` 清理只认 0.1.5 遗留目录）；**不要改成按包 symlink 或 per-session 拷贝**（peer 父 walk 与占盘都退化）。生效语义（Reload 语义，不自动重启远端）：store 写操作后本机活会话立即合并 manifest（dsh hmr 热加载/卸载 bundle 层），其他用户的活会话下次连接同步；hmr 不可用的老远端 dsh 回退为重连/重启生效。manifest 合并是**双向自愈**（[plugin-store.ts](../src/provision/plugin-store.ts) `syncSessionManifest`）：deps 从 store nm 扫描收编；**bundles 从「会话 manifest 里、store nm 中真实存在」的项收编进 store**——远端原生 UI 启用插件只写会话 bundles，不收编则下次 sync 用 store bundles 整体覆盖会话时会把它关掉、面板列表也显示未启用；收编只增不删（handoff/TEMPLATE 不在扫描集内，不会误删）。并发：pnpm 对同目录自带锁 + 引导临界区另有 flock（[install-lock.ts](../src/provision/install-lock.ts)）。引导期给远端装 pin 版 pnpm（[pnpm-installer.ts](../src/provision/pnpm-installer.ts)，pin 10 系——11 系对未决策的 allowBuilds 致命报错而远端无人交互决策），远端窗口自己的 Settings 插件 UI 由此完全可用；本地面板「远端插件」区经会话既有 SSH 通道本地编排（store 内 pnpm add/remove + 改写 store manifest；**不加远端路由**，监督器复用 RemoteSession 的窄 exec/writeRemoteFile 委托，IO 抽象 ManifestIo 两处复用）。handoff 合成包也在 store（用户级，所有会话共享）。多用户：不同远程 OS 账号 = 完全隔离；**同远端账号 = 共享会话根与 store**（同 (host,目录) 即同会话、会话互见、凭据代理先到者——共享是预期行为，文档建议每人独立远程账号）。破坏性操作按 owner 指纹 scope（[owner-fingerprint.ts](../src/util/owner-fingerprint.ts)，会话启动写 `.runtime/owner`，`DSH_OWNER_TAG` 可覆盖供测试）：`kill --all`/`clean` 默认只动自己指纹 + 死会话，`--include-others` 恢复旧全量行为；**store 永不被 clean 触碰**（用户级数据）。tmp 目录名含本机主机名段（异机 pid 可撞）。

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 语言要求

本仓库的所有交流、代码注释、提交信息、文档一律使用**中文**。代码规范见 [docs/type_script_style.md](docs/type_script_style.md)，写任何代码前先读它。

## 这是什么

`dsh-remote-explorer` 把 dsh 装到远程主机上运行，本机只留浏览器，LLM 凭据不离开本机。0.6.0 起**单包双形态**：

- **独立 CLI**（主形态）：`bin/dsh-remote-explorer.mjs` → tsx 直跑 `src/cli/`
- **dsh 插件**：`dsh plugin --profile web add dsh-remote-explorer` 装进本机 dsh，提供「远程会话」全局面板（左导航按钮 + 中央面板）+ `/remote-ssh` 命令 + `remote_*` agent 工具；宿主半在 `src/plugin/`、浏览器半在 `src/plugin-client/`，经 `scripts/build-plugin.ts` 打包为 `lib/`（gitignored）发布

两形态共享同一套 session/ 编排——插件不是精简版。参照 VS Code Remote-SSH / Zed / JetBrains Gateway 的做法——代码与会话都在远端，本机只做呈现。

**开发流程没有构建步骤。** `tsconfig.json` 是 `noEmit: true` + `allowImportingTsExtensions: true`，源码以 `.ts` 形式经 tsx 直接运行。不要在开发流程里加打包产物或 `outDir`。**打包是分发独立动作**：`scripts/package.ts`（CLI 平台包，产物 `dist/`）与 `scripts/build-plugin.ts`（插件双入口，产物 `lib/`）都只在分发前跑，产物均 gitignored、不提交。插件入口例外于「tsx 直跑」：dsh loader 经纯 ESM import 加载插件、不走 tsx，所以插件形态必须用构建产物。

### 重要：0.4.0 是架构重写；0.3.x 的插件形态不要复活

0.3.x 也是"Cordis 插件"，但那是**另一套设计**（dsh 跑本机 + helper RPC 把文件操作转到远端），代码已全部删除：helper RPC、TLS-PSK 流、依赖收集器、native stub、三个 workspace shim、注入式 Web 面板、WebSocket 桥接。0.6.0 的插件形态是"本机 dsh 宿主驱动本 CLI 的编排能力"，与 0.3.x 没有继承关系。

如果你在 git 历史或旧文档里看到 `Ssh2Connection`、`RemoteHostController`、`RemoteWorkspaceAdapter`、`installRemoteDirectoryPicker`、`collectHelperDependencies`——那些都是旧架构，不要参考，不要恢复。根目录的 `cordis.patch.yml` 是 0.6.0 新插件形态的 bundle patch，与 0.3.x 的同名文件无关。

## 常用命令

```bash
# 类型检查（见下方"已知问题"，本地 tsc 跑不起来，用这条替代）
npx -y -p typescript@5.7.3 tsc --noEmit

# 列出 ~/.ssh/config 中的主机（纯本地，不连接）
npx tsx src/cli/bin.ts list

# 诊断某台主机的引导条件（排查远端问题的首选手段）
npx tsx src/cli/bin.ts doctor myhost
npx tsx src/cli/bin.ts doctor myhost --refresh-mirrors

# 引导远端环境（幂等；改动 provision/ 后用它验证）
npx tsx src/cli/bin.ts provision myhost --cwd //home/youruser
# 验证全新安装路径（复用路径会跳过下载与 npm install，测不到真正易错的代码）
npx tsx src/cli/bin.ts provision myhost --node-version v24.20.0

# 完整会话（常驻进程；改动 session/、tunnel/ 或 credential/ 后用它验证）
# Ctrl-C 默认连远端 dsh 一起停；--keep-remote 保留远端进程。行为验证脚本：
# npx tsx tests/stop-remote-on-close.ts myhost（Windows 收不到合成 SIGINT，
# 脚本直接走 Ctrl-C 处理器的同一条 close 路径）
DEEPSEEK_API_KEY=sk-xxx npx tsx src/cli/bin.ts connect myhost --cwd //home/youruser --local-port 18950 --no-open
npx tsx src/cli/bin.ts status
npx tsx src/cli/bin.ts kill myhost --all
# kill 不带 --cwd 时按默认目录算会话 id——停不到用非默认 --cwd 启动的会话
# （实测踩过：connect 用了 --cwd //home/xxx，kill 忘带同值只报「没有正在运行
# 的远端 dsh」）。要停非默认 cwd 的会话必须带相同的 --cwd，或用 --all
# （按 owner 指纹 scope 扫远端全部会话目录）。

# 清理远端陈旧资源（改动 clean.ts 后用它验证）
npx tsx src/cli/bin.ts clean myhost

# 分发包打包（esbuild 单文件 + 目标平台 Node 二进制，产物在 dist/，gitignored）
# 开发流程仍无构建——本命令只服务分发。--all 打五平台矩阵；默认打当前平台
npx tsx scripts/package.ts --all

# dsh 插件形态（改动 src/plugin/、src/plugin-client/ 后必须跑）
npx tsx scripts/build-plugin.ts        # esbuild 双入口 → lib/index.js + lib/client.js
npx tsx scripts/check-plugin.ts        # 护栏：命令名/工具名/schema/路由前缀/版本一致
npx tsx scripts/dev-plugin.ts --smoke  # 隔离 DSH_HOME 沙箱：安装→启动→探针（ping 401）
npx tsx scripts/dev-plugin.ts          # 常驻沙箱，打印带令牌的 URL 供浏览器联调
npx tsx scripts/dev-plugin.ts --sync   # 产物同步进沙箱（宿主半重启生效，浏览器半刷新生效）
```

**在 Git Bash 里传远端路径必须用双斜杠**（`--cwd //home/xxx`）或先设
`MSYS_NO_PATHCONV=1`。MSYS 会把 `/home/xxx` 改写成 `D:/SoftWare/Git/home/xxx`，
这发生在参数到达程序之前。CLI 已能识别并拒绝，但测试时要记得用正确写法。

清理测试残留：`TaskStop` 只杀包装 shell，Node 子进程会成为孤儿仍占着本机端口，
需按端口找 pid 再 `taskkill`。远端用 `kill --all`。

**改动传输层或引导逻辑后，必须跑一次真实 `doctor`**。类型检查通过不等于连得上——远端 shell 差异、脚本拼接错误这类问题只有实跑才暴露。

文档与示例中的主机别名一律写 `myhost`、远端用户名写 `youruser`——都是占位名，实际使用时替换成你自己的。验证需要一台真实主机：任意能以私钥 SSH 登录的 POSIX（Linux/macOS）机器都行，从 `~/.ssh/config` 解析，或用 `user@host[:port]` 直连。

## 架构

五层 + 两个平级入口适配层，依赖严格单向向下，下层不得 import 上层：

```
入口层      cli/            命令分派、参数解析、终端输出（CLI 形态）
            plugin/         dsh 插件宿主半：supervisor 簿记、命令/工具/路由注册
            plugin-client/  dsh 插件浏览器半：远程会话全局面板（React，slots 注入 main/sidebar.panellist）
编排层      session/      会话生命周期、心跳、重连、多会话簿记
能力层      provision/    装 Node 与 dsh、镜像测速、生成会话 profile
            tunnel/       端口分配、正向转发
            credential/   LLM 凭据代理（反向隧道，key 不出本机）
            handoff/      远端窗口交接组件（宿主半跑在远端 dsh、浏览器半是状态 pill + 管理菜单）
传输层      transport/    ssh2 连接、命令执行、池化 SFTP、开通道、反向转发、通道配额
基础层      hosts/        ssh config 解析（主机配置唯一来源）
            util/         shell 转义、错误类型、会话 id、远端路径校验
```

原计划的第二个交付物 `dsh-remote-guard`（远端插件）**最终不需要**：认证 dsh 已内置（P0 发现），`baseURL` 由 profile patch 解决（P4），免认证探活由心跳的 HTTP 层解决（P5，带会话令牌 curl 根路径，任何 HTTP 状态码即证明 webserver 在服务）。

## 必须知道的几件事

**1. 主机配置来自 `~/.ssh/config`，不做持久化；也支持 `user@host[:port]` 直连。** `listHosts()` / `resolveHost(alias)` 用 `ssh-config` 库的 `compute()` 合并 `Host *` 默认值并递归解析 `ProxyJump` 跳板机链；config 里不存在的别名若匹配 `user@host[:port]` 语法则按直连处理（无 IdentityFile、无跳板机）。解析结果带模块级缓存，改了 config 文件必须调 `refreshConfig()`。认证优先级：`--private-key` > `--password` > config `IdentityFile` > 交互式密码提示（无 IdentityFile 且在交互终端时提示，不回显，最多重试 3 次；密码只存进程内存，绝不落盘/入日志）。`--password` 会打印泄露风险警告——明文出现在命令行、进程列表与 shell 历史里，是用户显式选择，工具只警告不阻止。

**2. 远端安装按版本入名，多版本并存，不做 hash 校验。** 路径形如 `~/.dsh-remote-explorer/btsd321/versions/dsh-<版本>/`、`~/.dsh-remote-explorer/btsd321/node/<版本>/`，存在性检查是直接执行 `<bin> --version` 成功即复用（Zed 的做法，完整性由 npm 自己兜底）。这是为了避免升级时原地覆盖——那正是"运行中的进程占着文件，写入报 Text file busy"的根因。

**3. 安装共享、会话状态隔离。** dsh 装在 `versions/` 下所有会话共享；每个会话有独立的 `DSH_HOME=~/.dsh-remote-explorer/btsd321/sessions/<会话 id>/`。这条成立是因为 dsh 的模块解析是双锚的（bundle 名先从 dsh 安装位置解析、再从 profile 目录解析），所以"装在哪"与"`DSH_HOME` 指向哪"解耦。`DSH_HOME` 只能走 `env` 前缀传，它是 bootstrap-only，任何 `.env` 都改不了它。

**4. 所有远端路径由 [src/provision/remote-paths.ts](src/provision/remote-paths.ts) 统一提供**，任何模块不得自己拼。构造远端路径一律用 `/` 拼字符串，**不要用 `node:path` 的 `join`**——本机可能是 Windows，会产出反斜杠。

**5. 远端命令统一经 `sh -c` 包裹。** `SshTransport.exec()` 已做这件事。ssh exec 用的是用户登录 shell，而各 shell 行为有实质差异：zsh 遇到未匹配的 glob 会直接报 `no matches found` 并中止，bash 则保留字面量。写远端脚本时还要注意**多行命令用 `\n` 连接，不能用空格**——`head=$(...) if [ ... ]` 是语法错误，整段脚本在解析期就失败，表现为所有探测"无输出"。

**6. 拼进远端命令的任何动态值必须过 [src/util/shell-quote.ts](src/util/shell-quote.ts) 的 `quote()`。** 不要用模板字符串直接插值，那等于命令注入。

转义会阻止 shell 展开变量，这一点有两个必须记住的后果：

- `quote('$HOME/x')` 里的 `$HOME` 不会展开。需要展开时写 `"$HOME"/${quote(名字)}`。
- **要在 PATH 前面加目录，用 `exec()` 的 `pathPrefix` 选项，不要走 `env`。** 写 `env: { PATH: '<新>:$PATH' }` 会让 `$PATH` 变成字面量，远端 PATH 只剩这一个目录，连 `rm`、`mkdir` 都找不到——表现为所有远端命令莫名失败。

**6b. 远端安装与 dsh 版本必须显式指定，不要依赖 dist-tag。** registry 上 `@deepseek-ai/dsh` 的 `latest` 指向 0.1.5-rc.2，比 `alpha` 的 0.1.7-alpha.1 旧。[src/provision/provisioner.ts](src/provision/provisioner.ts) 会先把标签解析成具体版本，安装命令里绝不出现标签。

**7. 远端 dsh 已内置令牌认证。** 启动输出形如 `dsh web: http://127.0.0.1:<端口>/?token=<43 字符>`，无令牌访问返回 401，令牌换 `HttpOnly` + `SameSite=Strict` cookie。**令牌不落盘**，只在启动输出首行——所以启动日志文件既是诊断来源也是令牌唯一来源，不能丢。

**8. 停远端进程不能用 `pkill -f <模式>`。** 承载命令的 shell 其命令行也含该模式，会把自己的 SSH 会话一起杀掉（实测踩过）。用会话目录下的 pid 文件，或按监听端口定位。

**8b. 本机监听器必须跨重连存活。** 重连时只换传输引用（`LocalForward.swapTransport`），本机端口不变——端口一变，用户已打开的浏览器标签全部失效。这正是传输接口提供 `openChannel`（只开一条通道）而非 `forwardOut`（本机监听 + 转发一体）的原因：监听器归 [src/tunnel/forward-local.ts](src/tunnel/forward-local.ts) 持有，传输实例可以被替换。

**8b-2. raw TCP socket 的 error 监听器必须在任何 destroy 之前挂上。** [src/tunnel/forward-local.ts](src/tunnel/forward-local.ts) 的连接回调里第一件事就是 `socket.on('error', ...)`：无监听器的 socket 被带 error 参数 destroy 时，未处理 `error` 事件会**直接掀翻整个进程**（用户实测踩过：通道配额耗尽 → pipe 失败路径 destroy(Error) → CLI 崩溃）。失败路径只调用不带参数的 `socket.destroy()`。

**8b-3. forward 通道配额按浏览器稳态并发取，不能拍脑袋取小。** 浏览器对单一 web 主机常规保持 6 条以上 HTTP/1.1 keep-alive 连接（稳态占用，不释放），加 WebSocket 与 SSE，上限 5 在正常使用中就会耗满，之后每条新连接排队 30 秒再失败。direct-tcpip 通道没有等同于 sshd `MaxSessions` 的低值硬上限（`ssh -L` 的常规用法就是几十条并发），[src/transport/channel-pool.ts](src/transport/channel-pool.ts) 的 forward 默认上限取 64；admin 类（受 `MaxSessions` 约束）仍是 3。

**8c. 会话表主键是 `(sessionId, localPid)` 组合，不是 `sessionId` 单独。** 会话 id 是**远端**身份：同别名同目录的多个本机 CLI 会共享同一个远端 dsh（后来者探到既有进程即复用），它们是同一远端会话的多个本机视图，各自维持自己的隧道端口。只按 sessionId 去重会让后启动的 CLI 挤掉先前那条记录，于是 `status` 漏报一个仍在工作的隧道。`removeSession(id, localPid)` 删单个视图，`removeSession(id)` 删该会话全部视图（`kill` 用后者）。

**8d. 凭据路径：占位令牌 + 落盘材料 + 跨重连的代理。** 三件事必须一起成立，改任何一件都要读 [src/session/session-manager.ts](src/session/session-manager.ts) 的 open()：

- 远端进程环境里的 key 变量（`DEEPSEEK_API_KEY`、`ASTUDIO_API_KEY` 等）是**代理令牌**（随机值）不是真实 key——dsh 缺 key 会在请求发出前就报 `MISSING_CREDENTIAL`，代理根本收不到，所以必须有占位值。真实 key 只在本机进程（`process.env[keyEnv]` → [src/credential/tunnel-proxy.ts](src/credential/tunnel-proxy.ts) 注入）。
- **代理是多供应商路由表**：DeepSeek 原生通道走 `/anthropic` 前缀（patch 重定向），`llm-pi-ai` 供应商走 `/r/<名>` 前缀（路由自动从本机 `~/.dsh/settings.yaml` 的 `llm-pi-ai.providers` 提取，见 [src/credential/provider-routes.ts](src/credential/provider-routes.ts)）。转发时请求前缀替换成上游自身路径。每条路由的 keyEnv 各自检查，缺哪个只影响哪个供应商。
- **远端 settings 双写**（0.1.7 适配）：本机 settings.yaml 整体复制到会话 `DSH_HOME/settings.yaml`（dsh ≤0.1.6 运行时热读；0.1.7 起只在每次进程启动时一次性导入进 profile 的 cordis.patch.yml，导入后改名 `.imported`），**同时**把 pi-ai 供应商路由写进 home patch 层 `DSH_HOME/cordis.patch.yml`（0.1.6/0.1.7 都存在且受 hmr 热监听——供应商的持续热生效靠它，见 provider-routes 的 renderProviderTunnelPatch；patch `config` 是整块替换，必须携带完整 `llm-pi-ai` 段）。两份都仅重定向 provider baseURL。**只镜像 settings（凭据引用），绝不镜像 `.credentials.yaml`**（可能含真实密钥，落远端违背整个设计）。
- **代理令牌与反向端口随会话固定**，落盘远端 `.runtime/proxy-token`（600）与 `.runtime/reverse-port`。反向端口写进了 patch 的 `baseURL`，运行中的远端进程认它——复用、重连、换本机 CLI 必须读回同一组值，别在启动时重新生成。
- 代理实例（本机回环 http.Server）与正向监听器一样**跨重连存活**，重连只重挂 `forwardIn`。多视图共享会话时反向端口先到先得，挂不上是警告不是错误。

**8e. 本机 Node v24.14.0 的 fetch 拒绝一切流式请求体。** ReadableStream / 异步生成器 / `new Request` 实测全抛 `expected non-null body source`（字符串与 Buffer 正常）。所以代理的请求体整体缓冲后转发；流式要紧的响应侧（SSE）保持 pipe 直传。另：ssh2 的通道**不能**直接 `emit('connection')` 喂给 http.Server（缺 `setTimeout` 等 Socket 接口），代理走本机回环 TCP 对接。

**8f. 心跳是三层判据，一条命令拿全。** 进程存活（`kill -0`）+ 端口监听（`ss`/`netstat`）+ **HTTP 应用级**（带会话令牌 curl 根路径，任何非 000 状态码即健康）——第三层能发现"进程在、端口在、但 webserver 僵死"的故障，前两层探测不到。改 [src/session/heartbeat.ts](src/session/heartbeat.ts) 时保持单命令形态：每 5 秒一次心跳，拆成三次 exec 会在高延迟链路上占配额。

**9. 远端 Node 必须用 v24 系，且装完要做稳定性自检。** v22.23.2 在 aarch64 上起进程崩溃率 35%（V8 初始化 isolate 随机失败，报 OOM 但内存充足）。`npm install` 要起几十次 node，必然失败，且报错会误导到最后一个失败的包。[src/provision/probe.ts](src/provision/probe.ts) 的 `checkNodeStability()` 强制自检，容错次数为 0。

**10. 镜像测速在远端执行，必须带 `-L` 并校验响应内容。** 测的是远端到镜像的连通性，本机测没意义。阿里源对 `index.json` 返回 302，只测时间会把重定向页当成成功并选出错误的"最快"镜像。腾讯与华为镜像已从候选移除（DNS 解析失败）。

**11. 远端落盘隔离契约（对标 VS Code 的 `~/.vscode-server` 单根自治模型）。** 本工具在远端的一切落盘都在 `~/.dsh-remote-explorer/btsd321/` 内；远端 `~/.dsh`（官方 dsh 的家）、`~/.npm`（远端 npm 使用者共享的缓存）**从不被本工具写入**。完全卸载 = `rm -rf ~/.dsh-remote-explorer/btsd321`。为此做的三件事，改相关代码时别破坏：

- 装机的 npm 命令带 `npm_config_cache=~/.dsh-remote-explorer/btsd321/npm-cache`（[src/provision/dsh-installer.ts](src/provision/dsh-installer.ts) 的 `npmEnv`）——npm 的缓存与 `_logs` 一并收进我们的根
- runner 脚本给远端 dsh 设 `DSH_AGENTS_HOME=<会话目录>/agents`——dsh 的 skill-filesystem 默认会读机器全局 `~/.agents`，不设就加载了别人的 skills
- 每会话 `DSH_HOME` 本身就是最强的隔离：dsh 契约是「所有用户数据在一个根」，settings/凭据/附件/profiles 全随之走（源码逐一核实过；唯一例外是 `~/.agents`，已用 env 堵上）

已知低风险共享：远端 pnpm store（`~/.local/share/pnpm`）——仅当有人主动在远端跑 `dsh plugin` 才触及，内容寻址并发安全，文档说明即可，不做隔离。`doctor` 的「隔离检查」段会报告占用与官方 `~/.dsh` 的存在性。

**12. dsh 插件形态的硬约束（全部实测踩过，改 src/plugin*/ 前必读）。**

- **宿主产物必须是 ESM**（`lib/index.js`，esbuild `format: 'esm'`）。CJS 产物 `require()` ESM-only 的 `@deepseek-ai/dsh-tools` 会直接崩（Node 24 `ERR_INTERNAL_ASSERTION`）；peer 裸导入只有走 ESM 解析链才能命中 profile 的安装闭包供给位（`$DSH_HOME/profiles/node_modules`，cordis 单实例的命脉——0.1.6 是物理回退链接，0.1.7 起改为内存拦截层，位置与语义不变）。ssh2 的惰性 `require('net')` 用 createRequire banner 化解（`HOST_BANNER` 还补了 `__filename/__dirname`——ssh2 的 crypto.js 用 `__dirname` 定位资源，缺了初始化就崩）。
- **entry id 与插件名统一 `dsh-remote-explorer`，locale 命名空间 `dshRemoteExplorer`，全局面板 id `remote-sessions`**（main 槽 key 与 sidebar.panellist id 同值，branded `MainPanelId` 需断言）；cordis.patch.yml 的 entry id 不能叫 `dsh-remote`（第三方 flymysql 插件占用，同 profile 共存会被 loader 拒绝）。浏览器半的 `__ModuleLoader__.load({ id })` **必须等于包名**（graph 行以包名为键），由 build 脚本从 package.json 注入，别手写。
- **命令名必须匹配 `/^[a-z][a-z0-9_-]*$/`**——非法字符（尤其点号）会让整个 dsh 启动失败；**defineTool 的每个显式 `type:'object'` 节点必须写 `additionalProperties`**——缺失是 authorError，宿主启动即崩。这两条 `scripts/check-plugin.ts` 有静态护栏，发布前必跑。
- **面板路由只走 `connection.fetch.register` 的 `/api/dsh-remote-explorer/*` 已鉴权通道**，绝不注册裸 webServer 路由（无鉴权，宿主配 0.0.0.0 时会话元数据+写操作直接暴露）。冒烟判读：不带凭据 curl ping 得 **401** = 正常，404 = 插件没挂上，200 = 绕过了鉴权（安全回归）。
- **Config 必须用 schemastery**（zod 会被 loader 拒绝），3.18 无 enum/optional API——全字段给 default。**Config 里永远不加 password 字段**（随 patch 层落盘 = 明文写磁盘）；面板密码走 POST body → 进程内存 fixed 模式，agent 工具永不接受密码。
- 可选服务（commands/connection）一律 `ctx.get()` 或 `ctx.inject([...])` 反应式获取，绝不属性直取；一切注册走 `ctx.effect()` 返回清理函数。**dispose 语义**：宿主退出默认 `close({ stopRemote: true })`（用户拍板，对齐 CLI Ctrl-C），`keepRemoteOnDispose` 可保留。
- dev 沙箱（`scripts/dev-plugin.ts`）：Windows 上 pnpm 对 `file:` 依赖是**硬链接拷贝**（同 inode）——同步脚本按「同 inode 跳过」处理，别改成无脑 rm+cp（rm 会顺着链接删、cp 会因 src=dest 抛错）；组合脚本 URL 从 HTML 提取后要把 `&amp;` 还原成 `&`；带令牌首访首页是 **303 + set-cookie**（令牌换 Cookie），node fetch 要 `redirect:'manual'` 手动接力。
- **桌面壳（DeepSeek Harness Electron，反编译 app.asar 核实）是单 OS 窗口，网页拿不到"开新 OS 窗口"通道**：主窗口 `setWindowOpenHandler` 把一切 http/https 弹窗转 `shell.openExternal`，`will-navigate` 只放行 `dsh-app:` 协议与同 origin http——所以面板里的会话 URL 在桌面端既不能弹窗也不能当前窗口导航，两条路都落到外部浏览器。应用内承载远程页面的唯一合法通道是 **browser lease 桥**：preload 在应用文档暴露 `window.dshDesktop.browser`（`acquire(workspace)`/`release(lease)`/`onOpenRequested`），webview 必须以 `about:blank#<lease>` 创建并带 acquire 返回的 partition（主进程 `will-attach-webview` 校验，失败即 prevent），**首次 dom-ready 后才能 `loadURL`**，关闭必 `release`。整套封装在 [src/plugin-client/desktop-bridge.ts](src/plugin-client/desktop-bridge.ts) + [src/plugin-client/remote-window.tsx](src/plugin-client/remote-window.tsx)（整窗不透明覆盖浮层：点主机名回退、点关闭即断开+停止远端；桌面端不传 managerUrl——webview 策略拒绝导航回应用 origin，远端 handoff 菜单走既有只读降级）。环境判别 `isDesktopShell()`（网页形态无 preload 恒 false）；桌面路径**只能在真实桌面端验证**，dev-plugin 沙箱是网页形态测不到。

**13. 内部文件传输走池化 SFTP（P2 起），printf-over-exec 只是回退。** `transport/ssh-transport.ts` 维护每连接一条的池化 SFTP 会话（占 1 个 admin 配额，会话内 4 路并发不新开通道），带每操作超时与「死连接作废重试一次」（错误特征见 `STALE_SFTP_PATTERN`）。文本写入统一走 `transport/write-text.ts` 的 `writeRemoteTextFile`（SFTP 主路径，远端没开 sftp 子系统时回退 printf；`tolerant` 区分尽力而为/严格语义）。**二进制内容（图像等资源）没有回退路径**——shell 重定向过不了二进制，只能 SFTP。凭据材料（proxy-token 600 权限）刻意保留 exec+umask 077 单命令原子写，不切换。

**14. 远端窗口交接组件（handoff）是会话级合成包，按标记幂等安装。** 0.4.0 的「远端不装插件」红线经用户拍板解除——前提是每个会话的远端 dsh 跑在独立 `DSH_HOME`（`sessions/<id>/`），与远端他人的 `~/.dsh` 零交集。引导期把合成包 `dsh-remote-handoff`（宿主半 + 浏览器半 + 空 patch，产物经 define 内联进宿主半 bundle，单文件分发形态运行期没有相邻 lib/）写进会话 profile 的 node_modules 并登记 `dsh.profile.bundles`；远端已有包目录则一条 `test -f` 跳过。老会话补装时若远端进程仍存活复用，菜单要等下一次远端重启才出现（迟到但不缺席，降级期间远端页面零感知）。通道是三段鉴权链：远端页面 → 同源 `/api/dsh-remote-handoff/*`（远端 dsh Cookie 栅栏）→ 反向隧道 `127.0.0.1:<反向端口>/manage/*`（代理令牌闸门，与 LLM 路由同纪律）→ 本机监督器闭包。manage 响应只含状态/日志/元信息，不含凭据。**「关闭/停止并返回」必须是 navigate-then-act**：断开会立刻杀死经隧道服务的远端页面，所以远端菜单先同标签导航回管理页（带 `#handoff-disconnect=` / `#handoff-stop=` intent hash），由管理页加载后确认执行——VS Code「Close Remote Connection 后窗口重载回本地」的拓扑等价物。窗口形态对环境分流：桌面端单按钮开**整窗浮动桌面**（见第 12 条的桌面壳约束）；浏览器端对齐 VS Code 双入口——面板「在当前标签页连接」（就绪后 3 秒倒计时同标签切入，可取消）与「在新标签页连接」（弹窗拦截不允许无手势开标签，会话行按钮接管）。CLI 形态没有管理页，meta 的 managerUrl 缺省，远端菜单自动降级只读（桌面端同理不传）。

**15. 远端插件仓库是用户级（host × 远程 OS 用户），对标 VS Code `~/.vscode-server/extensions/`。** store 在 `base/plugins/`（pnpm 真目录 + manifest 唯一真源，[plugin-store.ts](src/provision/plugin-store.ts)）；**会话 profile 的 node_modules 是指向 store 的整体 symlink**——会话零包副本；profile 里同时写 `.npmrc` 把 `virtual-store-dir` 钉到 store 的 `.pnpm`（不钉则远端窗口原生 UI 在 profile 目录跑 pnpm 报 `ERR_PNPM_UNEXPECTED_VIRTUAL_STORE`，实测踩过）。peer 裸导入靠 store 内三条回退链接闭环（`@deepseek-ai/` 整目录、`cpu-features`、`nan` → dsh 安装树，走 Node 原生祖先链物理解析——插件 real path 在 store，不经 dsh 的解析干预；0.1.7 起 dsh 在 `$DSH_HOME/profiles/node_modules` 的物理回退链接已改为内存拦截层，对本布局零影响，也不删外部链接——`.dsh-module-fallback` 清理只认 0.1.5 遗留目录）；**不要改成按包 symlink 或 per-session 拷贝**（peer 父 walk 与占盘都退化）。生效语义（Reload 语义，不自动重启远端）：store 写操作后本机活会话立即合并 manifest（dsh hmr 热加载/卸载 bundle 层），其他用户的活会话下次连接同步；hmr 不可用的老远端 dsh 回退为重连/重启生效。并发：pnpm 对同目录自带锁 + 引导临界区另有 flock（[install-lock.ts](src/provision/install-lock.ts)）。引导期给远端装 pin 版 pnpm（[pnpm-installer.ts](src/provision/pnpm-installer.ts)，pin 10 系——11 系对未决策的 allowBuilds 致命报错而远端无人交互决策），远端窗口自己的 Settings 插件 UI 由此完全可用；本地面板「远端插件」区经会话既有 SSH 通道本地编排（store 内 pnpm add/remove + 改写 store manifest；**不加远端路由**，监督器复用 RemoteSession 的窄 exec/writeRemoteFile 委托，IO 抽象 ManifestIo 两处复用）。handoff 合成包也在 store（用户级，所有会话共享）。多用户：不同远程 OS 账号 = 完全隔离；**同远端账号 = 共享会话根与 store**（同 (host,目录) 即同会话、会话互见、凭据代理先到者——共享是预期行为，文档建议每人独立远程账号）。破坏性操作按 owner 指纹 scope（[owner-fingerprint.ts](src/util/owner-fingerprint.ts)，会话启动写 `.runtime/owner`，`DSH_OWNER_TAG` 可覆盖供测试）：`kill --all`/`clean` 默认只动自己指纹 + 死会话，`--include-others` 恢复旧全量行为；**store 永不被 clean 触碰**（用户级数据）。tmp 目录名含本机主机名段（异机 pid 可撞）。

## 已知问题

- **`npm run typecheck` 跑不起来。** `node_modules` 里的 typescript 版本缺 win32 平台包。用 `npx -y -p typescript@5.7.3 tsc --noEmit` 替代。
- **部分远端主机的内核未启用 landlock**（实测某台 aarch64 测试机的 LSM 列表不含 landlock），`node-addon-system` 的 `probe()` 会返回 `unusable`。这是主机内核配置问题，与本项目架构无关；`flock` 在同一台机器上可用。

## 约束

- 远端只支持 POSIX（Linux/macOS）；客户端支持 Windows/Linux/macOS，所以**不要引入依赖系统 `ssh` 命令的实现**——用纯 JS 的 ssh2 就是为了这个。代价是 ControlMaster 那类现成便利拿不到，通道配额要自己管（[src/transport/channel-pool.ts](src/transport/channel-pool.ts)）。
- 认证优先私钥文件路径引用，不在代码或配置里落明文密钥。日志与错误消息不打印密钥、令牌、口令内容。交互式输入的 SSH 密码与 `--password` 传入的密码**只存本进程内存**（会话/命令结束丢弃引用；JS 字符串无法清零是已知限制）；`--password` 是用户显式选择，CLI 以警告提示命令行/进程列表/shell 历史的泄露风险，但绝不把密码写进任何日志或错误消息。
- 远端 webserver **必须**绑 `127.0.0.1`，反向转发的远端监听地址也必须是 `127.0.0.1`。dsh webserver 的 `host` 只接受 `127.0.0.1` 与 `0.0.0.0`，且其自身不携带 TLS——绑 `0.0.0.0` 等于把 GUI 挂到网上。
- 本机 CLI 必须活满整个会话：反向隧道代理持有 LLM key，CLI 退出则远端模型调用全部失败。这是凭据方案的既定代价，不是缺陷。
- 对远端资源的批量操作默认**串行**；要并发必须确认通道配额能承受。
- 新增运行时依赖必须写进 `package.json`，版本锁定或用窄范围。
- **凡是接受远端 POSIX 路径的参数都要校验。** Git Bash（MSYS）会在参数到达程序前把 `/home/x` 改写成 `D:/SoftWare/Git/home/x`。这发生在 shell 层，程序无法阻止，只能识别并拒绝。放过它不只是路径错——远端目录参与会话 id 计算，同一逻辑会话会因调用方式不同得到不同 id，复用与 kill 都会失灵。校验逻辑在 [src/cli/main.ts](src/cli/main.ts) 的 `validateRemoteCwd`。

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

**W6. WSL 反向端口会撞上「幽灵端口」：netstat 查无监听 ≠ 可绑定，分配与绑定必须同进程。** Windows 侧 47xxx 段端口会被 VS Code / WSL relay 机制**静默保留**（幽灵端口）——netstat 查无监听，bind 却报 EADDRINUSE（实测复现）。旧流程在 WSL 命名空间内探测空闲端口、到 Windows 侧绑定：探测与绑定本就跨命名空间，绑定失败又只静默降级，于是会话照常建立、反向通道从未接通——handoff meta 回调 502、状态 pill 永不渲染、LLM 凭据代理同链路全断，用户只看到「pill 不显示」而没有任何告警。修复见 [src/tunnel/reverse-listener.ts](../src/tunnel/reverse-listener.ts) 的 ReverseListener「**分配即绑定**」：真实 `listen()` 成功的端口才写进会话材料；EADDRINUSE/EACCES（幽灵端口或权限拒绝）自动换候选（47000–48999 随机抽取，上限 20 次）；换端口且远端进程仍在复用时**显式告警**——旧进程的 baseURL 停在旧端口，凭据路径在远端重启（`--force-restart`）前不可用。后续实测（0.7.8）发现幽灵占用可升级为**整段吞噬**：VS Code 的输出扫描端口转发会把**终端输出里出现过的端口号**自动转发并保持占用——测试套件在终端打印过上百个随机候选端口后，20 次候选全部 EADDRINUSE（netsh 排除区查无记录，纯静默占用）。为此候选耗尽不再报错，改为**回退 OS 分配端口**（listen 传 0，操作系统在动态区给出保证可绑定的口），绑定对区间被整段占用免疫；相关单元测试的端口断言随之改环境无关（区间只是偏好，硬编码 47xxx 的「空闲口」在这类机器上必是假空闲，取空闲口要用 bind(0)→读回→关掉的探针）。三条结论：端口探测与绑定必须**同命名空间、同进程**（谁绑定谁分配）；绑定失败必须显式告警，不允许静默降级；**候选链的最后一级必须是操作系统本身**——人肉选口永远可以被环境吞掉。

**W7. WSL2 反向通道按网络模式分流：NAT 用默认路由网关（via 地址），mirrored 只绑回环；网关解析别信 resolv.conf。** NAT（WSL2 默认）下 WSL 的 `127.0.0.1` 是自己的 loopback，连不到 Windows 侧监听（localhost forwarding 只覆盖 Windows → WSL 单向，见 W3）。网关取法必须是默认路由法：WSL 内 `ip route show default` 的 `via` 地址（Windows 宿主在 vEthernet 适配器上的地址）；**resolv.conf 的 nameserver 法在 dnsTunneling（新版本默认开启）下失效**——nameserver 指向 dnsTunneling 的虚拟转发地址而非宿主地址，勿写进网关解析。实现见 [src/transport/wsl-network.ts](../src/transport/wsl-network.ts)（探测纯函数）与 [src/session/wsl-reverse.ts](../src/session/wsl-reverse.ts)（编排）：NAT 同端口绑 `127.0.0.1` + 网关 IP、回调地址写网关；mirrored 只绑 `127.0.0.1`——**mirrored 的默认路由网关是 LAN 路由器而非本机地址**，套网关方案必失败。模式用 `wslinfo --networking-mode` 探测；老发行版无 wslinfo 时用回环连通性自检兜底（bash `/dev/tcp` 连 Windows 侧监听：连通即 mirrored/WSL1，被拒即 NAT）。网关 IP 随 WSL 重启变化：每次连接/重连重探测并重写远端 `.runtime/reverse-host` 材料（回调地址参数化，文件缺失回落 `127.0.0.1`；SSH 会话不写该文件）。防火墙：Hyper-V 防火墙**默认放行** WSL 子网，但企业 GPO 可能拦 WSL 子网入站——NAT 下反向链路自检不通时优先往这查（需管理员放行）。

## 远端安装与引导

**2. 远端安装按版本入名，多版本并存，不做 hash 校验。** 路径形如 `~/.dsh-remote-explorer/btsd321/versions/dsh-<版本>/`、`~/.dsh-remote-explorer/btsd321/node/<版本>/`，存在性检查是直接执行 `<bin> --version` 成功即复用（Zed 的做法，完整性由 npm 自己兜底）。这是为了避免升级时原地覆盖——那正是"运行中的进程占着文件，写入报 Text file busy"的根因。

**3. 安装共享、会话状态隔离。** dsh 装在 `versions/` 下所有会话共享；每个会话有独立的 `DSH_HOME=~/.dsh-remote-explorer/btsd321/sessions/<会话 id>/`。这条成立是因为 dsh 的模块解析是双锚的（bundle 名先从 dsh 安装位置解析、再从 profile 目录解析），所以"装在哪"与"`DSH_HOME` 指向哪"解耦。`DSH_HOME` 只能走 `env` 前缀传，它是 bootstrap-only，任何 `.env` 都改不了它。

**4. 所有远端路径由 [src/provision/remote-paths.ts](../src/provision/remote-paths.ts) 统一提供**，任何模块不得自己拼。构造远端路径一律用 `/` 拼字符串，**不要用 `node:path` 的 `join`**——本机可能是 Windows，会产出反斜杠。

**6b. 远端安装与 dsh 版本必须显式指定，不要依赖 dist-tag。** registry 上 `@deepseek-ai/dsh` 的 `latest` 指向 0.1.5-rc.2，比 `rc` 的 0.1.7-rc.2 旧。[src/provision/provisioner.ts](../src/provision/provisioner.ts) 会先把标签解析成具体版本，安装命令里绝不出现标签。（此为历史结论；默认策略已更新为「已发布版本最大值 + 解析失败兜底地板」，见 6c）

**6c. dist-tag `latest` 滞后于已发布版本：默认 dsh 版本 = 已发布版本最大值 + 解析失败兜底地板。** 二次实测（0.6.x）：`@deepseek-ai/dsh` 的 dist-tags 是 `latest: 0.1.7-rc.2`、`next: 0.2.0-rc.2`、`alpha: 0.1.7-alpha.2`，而已发布版本的最大值是 **0.2.0-rc.2**——`latest` 比已发布最大值旧了一整个 minor 段，且滞后是持续性状态（6b 时旧一个 patch 段，如今旧一个 minor 段），任何标签都不可作为「最新」的判据。默认策略改为：未显式指定版本时远端跑 `npm view @deepseek-ai/dsh versions --json --registry=<url>` 拉全量版本列表，[dsh-installer.ts](../src/provision/dsh-installer.ts) 的 `maxPublishedVersion` 按 semver 完整优先级（数值段、prerelease 有无、点分标识符数值/字典序、前缀同长者大）取最大；解析失败（离线、registry 抖动）**不中断引导**——log.warn + 回退兜底地板 `DEFAULT_DSH_VERSION`（provisioner 维护、随已发布最大值手动抬高，当前 0.2.0-rc.2），远端 npm install 命中缓存的可能性得以保留。两个实现细节：`npm view --json` 的 stdout 可能带警告前缀行，解析先整段 JSON.parse、失败再截取首 `[` 到末 `]` 的切片重试；`next`/`alpha` 标签不代表时间序（alpha 可能比 latest 旧），「最大」只能按 semver 优先级算。显式 `--dsh-version <版本|标签>` 路径不变，安装命令里依旧绝不出现标签。

**9. 远端 Node 必须用 v24 系，且装完要做稳定性自检。** v22.23.2 在 aarch64 上起进程崩溃率 35%（V8 初始化 isolate 随机失败，报 OOM 但内存充足）。`npm install` 要起几十次 node，必然失败，且报错会误导到最后一个失败的包。[src/provision/probe.ts](../src/provision/probe.ts) 的 `checkNodeStability()` 强制自检，容错次数为 0。

**10. 镜像测速在远端执行，必须带 `-L` 并校验响应内容。** 测的是远端到镜像的连通性，本机测没意义。阿里源对 `index.json` 返回 302，只测时间会把重定向页当成成功并选出错误的"最快"镜像。腾讯与华为镜像已从候选移除（DNS 解析失败）。

**11. 远端落盘隔离契约（对标 VS Code 的 `~/.vscode-server` 单根自治模型）。** 本工具在远端的一切落盘都在 `~/.dsh-remote-explorer/btsd321/` 内；远端 `~/.dsh`（官方 dsh 的家）、`~/.npm`（远端 npm 使用者共享的缓存）**从不被本工具写入**。完全卸载 = `rm -rf ~/.dsh-remote-explorer/btsd321`。为此做的三件事，改相关代码时别破坏：

- 装机的 npm 命令带 `npm_config_cache=~/.dsh-remote-explorer/btsd321/npm-cache`（[src/provision/dsh-installer.ts](../src/provision/dsh-installer.ts) 的 `npmEnv`）——npm 的缓存与 `_logs` 一并收进我们的根
- runner 脚本给远端 dsh 设 `DSH_AGENTS_HOME=<base>/.agents`——dsh 的 skill-filesystem 默认会读机器全局 `~/.agents`，必须显式指到我们的根内，否则会加载远端别人放在 `~/.agents/skills` 的 skills（**注意：指到 base 下的机器级目录，不是会话目录——见第 22 条**）
- 每会话 `DSH_HOME` 是会话实例的隔离边界：dsh 契约是「所有用户数据在一个根」，对话历史/附件/缓存/.runtime 全随之走（源码逐一核实过；唯一例外 `~/.agents` 已用 env 接管，见第 22 条）

已知低风险共享：远端 pnpm store（`~/.local/share/pnpm`）——仅当有人主动在远端跑 `dsh plugin` 才触及，内容寻址并发安全，文档说明即可，不做隔离。`doctor` 的「隔离检查」段会报告占用与官方 `~/.dsh` 的存在性。

**17. `pnpm -v` 作远端版本探针不可靠（三重陷阱），版本探针读落盘 package.json。** ensurePnpm 旧版用 PATH 前缀后的 `pnpm -v` 判断复用，在用户的 WSL 机器上实测确诊两个独立陷阱叠加：① **interop 解析渗入**——管理版未装时，`pnpm` 经 WSL 的 Windows PATH 附加段解析到 `/mnt/c/<用户>/AppData/Roaming/npm/pnpm`（宿主机 Windows pnpm 11.7.0），版本检查读到的是宿主机的 pnpm，与管理目录无关；② **CWD 钉版自动切换**——wsl.exe 继承 Windows 进程 CWD，CLI 从本仓库根启动时 bash 的 CWD = `/mnt/d/...`（仓库 checkout），仓库 package.json 有 `"packageManager": "pnpm@11.7.0"`，pnpm 10 的 managePackageManagerVersions（10 系默认开启）发现后**自动切换到 11.7.0 执行**——`pnpm -v` 报告的是切换后版本，与管理目录实际安装的 10.33.0 无关；③ **CLI 从仓库根启动必踩**——①② 是叠加关系（探针可能读到宿主机的 pnpm，也可能读到钉版切换出来的版本），`--config.manage-package-manager-versions=false` 无法在 CLI 关闭它（实测）。结论：[pnpm-installer.ts](../src/provision/pnpm-installer.ts) 的 check/verify 一律 `cat <nodeDir>/lib/node_modules/pnpm/package.json` 后 JSON.parse 读 `version`（cat 不经 PATH 解析，不受渗入影响）——check 按主版本 ∈ {10,11,12} 复用、verify 期望精确等于 pin 版。顺带记远端 pnpm 升 11.7.0（对齐 dsh 官方 packageManager 钉版）的启用前提：引导在 host profile 的 pnpm-workspace.yaml 幂等补齐两段——`allowBuilds`（11 对未决策构建脚本致命报错，**这正是历史 pin 10 的原因**）+ `minimumReleaseAge: 0`（11 默认 24h 供应链门槛会拒装发布不满 24h 的包，远端插件安装场景必踩），见 [pnpm-profile.ts](../src/provision/pnpm-profile.ts)。补齐顺带实测出 dsh 的 profile 初始化行为：`--dump-config` 对**已存在的** pnpm-workspace.yaml 不覆盖（/tmp 隔离 DSH_HOME 预写标记文件后初始化，标记原样存活）——引导预写该文件会抑制 dsh 写模板，所以「文件不存在则创建」的最小骨架必须自带模板的 `packages`/`nodeLinker: hoisted`/`autoInstallPeers: false`，否则全新主机的 profile 会退回 pnpm 默认 nodeLinker（isolated），与 dsh 官方行为漂移。

**18. Node 下载必须走镜像候选链：测速选中 ≠ 该镜像有这个版本的文件。** 实测（0.7.x）：清华 nodejs-release 镜像**缺 v24.21.0 整个版本目录**（下载 404），而它对基址 `index.json` 正常响应——测速照常把它选为最快镜像，安装却必然失败。测速探的是镜像基址，不校验具体版本文件的存在性；镜像同步缺口是持续性风险（这次缺的是整个版本目录，不是单个文件）。修复语义（用户拍板）：单一镜像失败自动换下一源，**全部镜像与官方源都失败才报错**——[node-installer.ts](../src/provision/node-installer.ts) 的 `nodeMirrorChain` 按「首选镜像（测速/缓存选中）→ 其余镜像（候选列表序）→ 官方源垫底」构造去重候选链，逐源 `curl -fL` 下载，单源失败 log.warn 留痕（地址 + 原因）换下一源，成功时若发生过回退会 log.info 记录最终命中的源；全败才汇总各源失败原因上抛。两个实现细节：curl 加 `--connect-timeout 15`——不可达源在连接期 15 秒内失败，不吃满 10 分钟下载超时（链式重试的最大成本必须由快速失败兜住）；`mirrorBaseUrl` 为空（调用方跳过了测速）不再报错，直接用默认候选链自愈重装（原语义是「探测已装但二进制损坏」的显式报错，改为 warn + 重装更实用）。

## 隧道与网络

**8b. 本机监听器必须跨重连存活。** 重连时只换传输引用（`LocalForward.swapTransport`），本机端口不变——端口一变，用户已打开的浏览器标签全部失效。这正是传输接口提供 `openChannel`（只开一条通道）而非 `forwardOut`（本机监听 + 转发一体）的原因：监听器归 [src/tunnel/forward-local.ts](../src/tunnel/forward-local.ts) 持有，传输实例可以被替换。

**8b-2. raw TCP socket 的 error 监听器必须在任何 destroy 之前挂上。** [src/tunnel/forward-local.ts](../src/tunnel/forward-local.ts) 的连接回调里第一件事就是 `socket.on('error', ...)`：无监听器的 socket 被带 error 参数 destroy 时，未处理 `error` 事件会**直接掀翻整个进程**（用户实测踩过：通道配额耗尽 → pipe 失败路径 destroy(Error) → CLI 崩溃）。失败路径只调用不带参数的 `socket.destroy()`。

**8b-3. forward 通道配额按浏览器稳态并发取，不能拍脑袋取小。** 浏览器对单一 web 主机常规保持 6 条以上 HTTP/1.1 keep-alive 连接（稳态占用，不释放），加 WebSocket 与 SSE，上限 5 在正常使用中就会耗满，之后每条新连接排队 30 秒再失败。direct-tcpip 通道没有等同于 sshd `MaxSessions` 的低值硬上限（`ssh -L` 的常规用法就是几十条并发），[src/transport/channel-pool.ts](../src/transport/channel-pool.ts) 的 forward 默认上限取 64；admin 类（受 `MaxSessions` 约束）仍是 3。

## 会话管理

**8c. 会话表主键是 `(sessionId, localPid)` 组合，不是 `sessionId` 单独。** 会话 id 是**远端**身份：同别名同目录的多个本机 CLI 会共享同一个远端 dsh（后来者探到既有进程即复用），它们是同一远端会话的多个本机视图，各自维持自己的隧道端口。只按 sessionId 去重会让后启动的 CLI 挤掉先前那条记录，于是 `status` 漏报一个仍在工作的隧道。`removeSession(id, localPid)` 删单个视图，`removeSession(id)` 删该会话全部视图（`kill` 用后者）。

**8f. 心跳是三层判据，一条命令拿全。** 进程存活（`kill -0`）+ 端口监听（`ss`/`netstat`）+ **HTTP 应用级**（带会话令牌 curl 根路径，任何非 000 状态码即健康）——第三层能发现"进程在、端口在、但 webserver 僵死"的故障，前两层探测不到。改 [src/session/heartbeat.ts](../src/session/heartbeat.ts) 时保持单命令形态：每 5 秒一次心跳，拆成三次 exec 会在高延迟链路上占配额。

## 环境变量注入

**16. 远端 dsh 的代理与用户 env 是三层合并，env 键名是命令注入面。** SSH(22) 通 ≠ HTTPS(443) 通：dsh 装 `github:` 插件前用 `git ls-remote https://github.com/...` 探测连通性（探测默认 5 秒超时），无公网主机裸连必超时；dsh 的 `scrubbedParentEnv` 会保留代理变量并注入 `NODE_USE_ENV_PROXY=1`，链路本身完好，缺的只是「dsh 进程自己的环境里有代理变量」——由 `startRemoteDsh` 的 extraEnv 口注入，合并优先级**凭据占位 > per-host 用户 env > `DSH_REMOTE_PROXY` 兜底**（[src/session/proxy-env.ts](../src/session/proxy-env.ts)）。凭据键（`DEEPSEEK_API_KEY` 等）必须最后合并，被用户 env 挤掉会导致远端报 `MISSING_CREDENTIAL`、代理根本收不到请求。三条硬约束：

- **env 键名不经 `quote()` 直接插值进启动命令**（remote-process.ts 的 `envAssignments` 是 `${key}=${quote(value)}`，只有值有转义）——用户 env 键名必须过 `/^[A-Za-z_][A-Za-z0-9_]*$/`，写入（路由+store 双拦截）、读取（防手工编辑文件）、launch（session 层最后防线）三处校验（`assertSafeEnvKeys`）；保留键 `DSH_HOME`/`DSH_AGENTS_HOME`/`PATH` 禁止用户配置——前两个在 envAssignments 里**先于** extraEnv 赋值，用户值会覆盖远端落盘隔离契约（见第 11 条），PATH 由启动器管理。校验集合单一来源在 session 层（plugin 层向下 import，不许反向）
- **注入只发生在启动远端进程时**：`probeExistingSession` 命中复用不补注入（与凭据占位同语义），要生效用 forceRestart；重连重启路径（reconnectOnce → launch）同样透传 extraEnv
- per-host 配置（面板齿轮）落盘 `~/.dsh/remote-host-env.json`（原子写、0o600——值可能含代理认证信息，Windows 上 mode 位无效靠目录 ACL）；日志与错误消息**只打键名不打值**；路由 `GET/POST /api/dsh-remote-explorer/host-env` 走 connection 已鉴权通道

## 凭据与安全

**7. 远端 dsh 已内置令牌认证。** 启动输出形如 `dsh web: http://127.0.0.1:<端口>/?token=<43 字符>`，无令牌访问返回 401，令牌换 `HttpOnly` + `SameSite=Strict` cookie。**令牌不落盘**，只在启动输出首行——所以启动日志文件既是诊断来源也是令牌唯一来源，不能丢。

**8d. 凭据路径：占位令牌 + 落盘材料 + 跨重连的代理。** 三件事必须一起成立。凭据材料读写已下沉到 [src/credential/proxy-secret.ts](../src/credential/proxy-secret.ts)；会话编排见 [src/session/session-manager.ts](../src/session/session-manager.ts) 的 `open()`（已拆分为 `prepareTransport`/`probeAndReadCredentials`/`provisionAndConfigure`/`probeOrStartRemote`/`setupTunnels` 五个阶段方法）：

- 远端进程环境里的 key 变量（`DEEPSEEK_API_KEY`等）是**代理令牌**（随机值）不是真实 key——dsh 缺 key 会在请求发出前就报 `MISSING_CREDENTIAL`，代理根本收不到，所以必须有占位值。真实 key 只在本机进程（`process.env[keyEnv]` → [src/credential/tunnel-proxy.ts](../src/credential/tunnel-proxy.ts) 注入）。
- **代理是多供应商路由表**：DeepSeek 原生通道走 `/anthropic` 前缀（patch 重定向），`llm-pi-ai` 供应商走 `/r/<名>` 前缀（路由自动从本机 `~/.dsh/settings.yaml` 的 `llm-pi-ai.providers` 提取，见 [src/credential/provider-routes.ts](../src/credential/provider-routes.ts)）。转发时请求前缀替换成上游自身路径。每条路由的 keyEnv 各自检查，缺哪个只影响哪个供应商。
- **远端 settings 双写**（0.1.7 适配）：本机 settings.yaml 整体复制到会话 `DSH_HOME/settings.yaml`（dsh ≤0.1.6 运行时热读；0.1.7 起只在每次进程启动时一次性导入进 profile 的 cordis.patch.yml，导入后改名 `.imported`），**同时**把 pi-ai 供应商路由写进 home patch 层 `DSH_HOME/cordis.patch.yml`（0.1.6/0.1.7 都存在且受 hmr 热监听——供应商的持续热生效靠它，见 provider-routes 的 renderProviderTunnelPatch；patch `config` 是整块替换，必须携带完整 `llm-pi-ai` 段）。两份都仅重定向 provider baseURL。**只镜像 settings（凭据引用），绝不镜像 `.credentials.yaml`**（可能含真实密钥，落远端违背整个设计）。
- **代理令牌与反向端口随会话固定**，落盘远端 `.runtime/proxy-token`（600）与 `.runtime/reverse-port`。反向端口写进了 patch 的 `baseURL`，运行中的远端进程认它——复用、重连、换本机 CLI 必须读回同一组值，别在启动时重新生成。
- 代理实例（本机回环 http.Server）与正向监听器一样**跨重连存活**，重连只重挂 `forwardIn`。多视图共享会话时反向端口先到先得，挂不上是警告不是错误。

**8e. 本机 Node v24.14.0 的 fetch 拒绝一切流式请求体。** ReadableStream / 异步生成器 / `new Request` 实测全抛 `expected non-null body source`（字符串与 Buffer 正常）。所以代理的请求体整体缓冲后转发；流式要紧的响应侧（SSE）保持 pipe 直传。另：ssh2 的通道**不能**直接 `emit('connection')` 喂给 http.Server（缺 `setTimeout` 等 Socket 接口），代理走本机回环 TCP 对接。

**23. DeepSeek 账号通道是三道契约门的串联，缺一道都表现为「没登录」——但各有不同的症状。** dsh 侧（`deepseek-account-platform` 插件）对账号凭据的校验全在**请求侧**而非登录流程，本工具的占位 grant 方案（远端存代理令牌 + 本机代理换真 token）必须同时过三道门：

- **issuer 门**：`Service.init` 校验占位 grant 的 `issuer === platformOrigin`（patch 后即隧道代理地址），不匹配直接删 record。所以占位凭据的 issuer、patch 的 `platformOrigin`、patch 的 `inferenceOrigin` 三者必须同为 `http://<reverseHost>:<reversePort>`（[src/session/open-pipeline/provision.ts](../src/session/open-pipeline/provision.ts) 与 [src/credential/tunnel-proxy.ts](../src/credential/tunnel-proxy.ts) 的 remotePatches）。
- **inferenceOrigin 门**：`llm-deepseek-account` 适配器每次请求调 `resolveToken(connection.baseURL)`，要求「请求目标 origin === 插件配置的 inferenceOrigin」（默认 `https://api.deepseek.com`）。baseURL 被 patch 指向隧道而不 patch inferenceOrigin 时 origin 不匹配 → resolveToken 返回 undefined → **账号模型从远端模型选择器整组消失**（discoverModels 把 sign-in-required 折叠为空列表）。
- **认证头门**：账号通道与平台路由**只**带 `x-dsh-auth-token` 头（不带 `authorization`/`x-api-key`）。代理的 extractToken 漏认这个头 → 401 → dsh 把「带 x-dsh-auth-token 却收到 401」判定为账号认证被拒 → 删 record、发退出登录事件 → **运行中任务报「已因退出 DeepSeek 登录而停止」**。三种头（`authorization: Bearer`/`x-api-key`/`x-dsh-auth-token`）都必须认。
- 附带两条边界事实：① dsh 的账号 UI（头像 pill/登录对话框）只在官方桌面端渲染器注册（`ui-settings-account` 检测 `dshDesktop` 桥），**web 前端一律不渲染**——远端界面没有登录入口是常态不是故障；② dsh 原生支持「SSH `-L` 转发下在远端直接登录」（`loginOrigin` 接受任意转发回环端口），但那是「真实 token 落远端」的路线，与本工具「凭据不出本机」冲突，隧道代理对登录流程的未认证请求（auth_init 无认证头）一律 401——远端登录就该不可达，账号过期在本机重登再重连（重连会重写占位凭据自动恢复登录态）。

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

**15. 远端插件仓库是用户级（host × 远程 OS 用户），对标 VS Code `~/.vscode-server/extensions/`。** store 在 `base/plugins/`（pnpm 真目录 + manifest 唯一真源，[plugin-store.ts](../src/provision/plugin-store.ts)）；**会话 profile 的 node_modules 是指向 store 的整体 symlink**——会话零包副本；profile 里同时写 `.npmrc` 把 `virtual-store-dir` 钉到 store 的 `.pnpm`（不钉则远端窗口原生 UI 在 profile 目录跑 pnpm 报 `ERR_PNPM_UNEXPECTED_VIRTUAL_STORE`，实测踩过）。peer 裸导入靠 store 内三条回退链接闭环（`@deepseek-ai/` 整目录、`cpu-features`、`nan` → dsh 安装树，走 Node 原生祖先链物理解析——插件 real path 在 store，不经 dsh 的解析干预；0.1.7 起 dsh 在 `$DSH_HOME/profiles/node_modules` 的物理回退链接已改为内存拦截层，对本布局零影响，也不删外部链接——`.dsh-module-fallback` 清理只认 0.1.5 遗留目录）；**不要改成按包 symlink 或 per-session 拷贝**（peer 父 walk 与占盘都退化）。生效语义（Reload 语义，不自动重启远端）：store 写操作后本机活会话立即合并 manifest（dsh hmr 热加载/卸载 bundle 层），其他用户的活会话下次连接同步；hmr 不可用的老远端 dsh 回退为重连/重启生效。manifest 合并是**双向自愈**（[plugin-store.ts](../src/provision/plugin-store.ts) `syncSessionManifest`）：deps 从 store nm 扫描收编；**bundles 从「会话 manifest 里、store nm 中真实存在」的项收编进 store**——远端原生 UI 启用插件只写会话 bundles，不收编则下次 sync 用 store bundles 整体覆盖会话时会把它关掉、面板列表也显示未启用；收编只增不删（handoff/TEMPLATE 不在扫描集内，不会误删）。并发：pnpm 对同目录自带锁 + 引导临界区另有 flock（[install-lock.ts](../src/provision/install-lock.ts)）。引导期给远端装 pin 版 pnpm（[pnpm-installer.ts](../src/provision/pnpm-installer.ts)，pin 10 系——11 系对未决策的 allowBuilds 致命报错而远端无人交互决策；此为历史事实，策略已更新：pin 11.7.0 对齐 dsh + 主版本 10/11/12 兼容复用，11 系前提由引导在 profile 的 pnpm-workspace.yaml 幂等补齐——见第 17 条），远端窗口自己的 Settings 插件 UI 由此完全可用——**它与远端终端的 `dsh plugin` 是插件管理的全部入口**。本地面板曾有一个「远端插件」区（经会话既有 SSH 通道本地编排 store 内的 pnpm add/remove 与 manifest 改写），已删除：连接成功后浏览器就切到远端 dsh 界面，本地管理页不在用户视野内，那个区实际上没人看得见；留着它等于多维护一条远端写路径。别再加回来——要管插件就在远端那边管。handoff 合成包也在 store（用户级，所有会话共享）。多用户：不同远程 OS 账号 = 完全隔离；**同远端账号 = 共享会话根与 store**（同 (host,目录) 即同会话、会话互见、凭据代理先到者——共享是预期行为，文档建议每人独立远程账号）。破坏性操作按 owner 指纹 scope（[owner-fingerprint.ts](../src/util/owner-fingerprint.ts)，会话启动写 `.runtime/owner`，`DSH_OWNER_TAG` 可覆盖供测试）：`kill --all`/`clean` 默认只动自己指纹 + 死会话，`--include-others` 恢复旧全量行为；**store 永不被 clean 触碰**（用户级数据）。tmp 目录名含本机主机名段（异机 pid 可撞）。

**16. pnpm 11 构建审批门撞上 dsh CLI 的半提交重试坑（本地装插件三连环，0.1.7-rc.1/rc.2 同行为）。** 第 15 条只挡了**远端**（pin pnpm 10），本地侧同坑在 0.1.7-rc.2 冒烟时炸出来：① `dsh plugin add`（对 pnpm 的原样转发）在 pnpm 11.7 下对未决策构建脚本**退出 1**（`ERR_PNPM_IGNORED_BUILDS`），本包依赖树自带三个（ssh2、cpu-features、经 tsx 的 esbuild）——与安装源无关，README 旧注解「无 prepare 即免配置」只覆盖了**本包自身**脚本，盖不住**依赖**的；插件运行期不需要它们的构建产物（lib/ 预构建、ssh2 纯 JS 回落），决策一律 `false`。② dsh CLI 的 add 失败路径**不回滚 profile package.json**——pnpm 退出 1 前已把依赖写进 manifest，而激活进 `dsh.profile.bundles` 的 reconcile 只在成功路径跑；直接重试时 dsh 按「before 已有该依赖」判旧跳过激活，**重试退出 0 但插件根本没进组合**（宿主半路由带 Cookie 404、引导图缺行）。Web UI 的 installBundle 有 spec 名兜底没有此坑，CLI 没有——[dev-plugin.ts](../scripts/dev-plugin.ts) 的解法：审批（占位值→false）+ 撤掉半提交依赖 + 重试，即官方 Web UI approve-and-retry 的 CLI 等价物。③ 探针盲区：**无凭据 401 不是注册证据**——/api 鉴权门对未注册路由同样 401（实测），带会话 Cookie 的 200 才是；组合脚本 URL 在首页里是**文档相对形式（无前导斜杠）**且分多批，验证要取**含本包**的那条 URL。0.1.7-rc.2 兼容性结论一并记录：`llm-deepseek` 拆包（entry id 不变、指向 dsh-llm-deepseek-api-key，Config 继承 baseURL + apiKeyEnv 默认 DEEPSEEK_API_KEY，解析顺序 credentials 服务优先且 credentials-local 是「继承环境 > 凭据库」）——baseURL patch + 远端 env 令牌注入的凭据闭环原样成立，无需改代码。

## agent 能力（技能）

**22. agent 能力目录按机器共享，不按会话——`DSH_AGENTS_HOME=<base>/.agents`（这是对第 11 条早期做法的**有意反转**）。** 早期版本把它指向 `sessions/<id>/agents` 换取「不读别人的 skills」，代价是同一台远端换个工作目录开会话就等于一台新机器，技能要重装一遍——用户诉求正是「不要反复配置」。判据来自 dsh 源码：skill-filesystem 的六个根里，`<agentsHome>/skills` 是 **`user-agents` 源、rank 500**，语义是「这台机器的使用者」，和 `<dshHome>/skills`（rank 400）同属用户级；项目级 `.dsh/skills`（100）与 `.agents/skills`（200）优先级更高且随仓库走，**不该也不能**接到机器级（会污染用户仓库、且破坏项目覆盖机器的既定语义）。共享边界 = 远端账号：本工具的根就在该账号家目录下，持有者本就共享这棵树里的 node、dsh、host profile，技能单独做指纹隔离会与同目录其他资源的粒度不一致。三个配套，改相关代码时别破坏：

- **目录名用 `.agents` 而非 `shared/agents`**：与本机 `~/.agents` 同形，且避开两个坑——`resolveDshHome` 不解析软链而 `canonicalizeWatchPath` 取 realpath，走 symlink 接法时两者可能比对不上（表现为「装完技能要重开会话才可见」）；`user-dsh` 根会跳过 `.system` 子目录而 `user-agents` 根不会，走 `.agents` 落在不受该规则影响的桶里
- **启动前预建 `.agents/skills`**（[remote-process.ts](../src/session/remote-process.ts)）：skill-filesystem 对**不存在**的根只能用 `fs.watchFile` 逐个路径段轮询等它出现，预建好则 Chokidar 直接附加，装完技能当即进入下一次目录
- **写临界区用 flock**（[agents-lock.ts](../src/provision/agents-lock.ts)，锁 `.agents/.lock`）：共享后新增的风险是技能安装器的 `.skill-lock.json` 为**目录级单文件整写**，并发装技能后者覆盖前者。超时取 90s（护的是秒级目录操作，不是第 11 条引导锁的分钟级下载）。**能力边界：只锁本工具发起的写入**，第三方安装器不读我们的锁——不做拦截任意进程写入的全局串行化，文档说明即可

**不做老会话技能迁移（有意决策，别再补回来）。** 曾实现过一版 `agents-migrate.ts`：首连时把 `sessions/<id>/agents/` 并入 `.agents`，同名保留机器级版本、迁完改名留痕、幂等、失败不抛错。用户否决，理由是这样没用——该目录承载的是**上一代的会话级技能副本**，而本机 `~/.agents` 才是用户实际维护技能的地方（带 `.skill-lock.json` 的来源与 hash 记录）；搬过来的是一批陈旧且无人维护的副本，远不如让用户在新位置重装一次干净。真要保留旧技能的场合，手工 `mv` 的成本远低于为此维护一条幂等迁移路径（还得处理同名裁决、留痕、并发锁、部分失败五种情形）。旧目录**不删也不读**：不删是为了不擅自处置用户数据，不读是因为 `DSH_AGENTS_HOME` 已不再指向它；它随 `clean` 清理死会话目录时自然消失。

与第 15 条的 store 相反，**`.agents` 会被 `clean` 整个清除**（[clean.ts](../src/cli/commands/clean.ts)）：它是单一目录没有「保留最新 N 个」的概念，技能属可重装资源；也不按 owner 指纹 scope、不按活会话保护——活会话读同一目录，删掉只影响它后续**发现**到的技能（skill-filesystem 的根缺失属于有效空状态，不会让进程崩）。顺带一处语义更正：保留键 `DSH_AGENTS_HOME` 禁止用户配置的理由从「护会话隔离契约」变成「护技能共享契约」——被改走会让该会话看不到机器上已装的技能，还把新技能装到下次就找不到的地方。

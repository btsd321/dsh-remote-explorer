# dsh-remote-explorer

[English](README.md) | **[中文](README.cn.md)**

远程开发启动器：把 [dsh](https://www.npmjs.com/package/@deepseek-ai/dsh) 装到远程主机上运行，本机只留浏览器。LLM 凭据不离开本机。

参照 VS Code Remote-SSH、Zed、JetBrains Gateway 的做法——**代码与会话都在远端，本机只做呈现**。

## 支持的环境

- **本机（客户端）**：Windows / Linux / macOS。Node.js v20.19+ 或 v22+ 仅**源码运行方式**需要；release 包自带 Node 运行时。
- **远端主机**：Linux 或 macOS（POSIX）；aarch64（arm64）与 x86_64 均可。远端无需预装 Node——工具会自动安装并自检。
- **WSL（Windows Subsystem for Linux）**：Windows 平台额外支持 WSL2 发行版作为远程目标。在 WSL 内自动安装 dsh，通过 localhost forwarding 建立隧道，无需 SSH 配置。点击面板中的「WSL 会话」卡片即可使用；非 Windows 平台自动隐藏此入口。
- **SSH 认证**：私钥（`IdentityFile`，推荐）；无私钥时在交互式终端提示输入密码（不回显）；也可 `--password` 明文传入（有泄露风险，CLI 会警告）。
- 主机来自 `~/.ssh/config` 的 `Host` 条目，或 `user@host[:port]` 直连（IPv6 需写进 config）。

## 安装与运行

CLI 有两种运行方式（命令与参数完全一致）；本机已在用 dsh 的用户还可以直接装成 **dsh 插件**（方式三）。

### 方式一：源码运行

本仓库无构建步骤，源码以 `.ts` 形式经 tsx 直接执行。取到源码后：

```bash
npm install
npx tsx src/cli/bin.ts list
```

### 方式二：release 包运行

从发布处下载对应平台的压缩包（由 [打包](#打包)脚本产出，命名 `dsh-remote-explorer-<版本>-<平台>.<zip|tar.gz>`），解压后直接运行——目标机无需 Node、npm 与网络：

| 平台 | 包格式 | 解压后的运行方式 |
|---|---|---|
| win32-x64 | `.zip` | `dsh-remote-explorer.cmd <命令>` |
| linux-x64 / linux-arm64 | `.tar.gz` | `./dsh-remote-explorer <命令>` |
| darwin-x64 / darwin-arm64 | `.tar.gz` | `./dsh-remote-explorer <命令>` |

包内自带官方 Node 二进制（下载时经 SHASUMS256 校验）与单文件 CLI `dsh-remote-explorer.cjs`（全部依赖已打进单文件）。下载后建议按发布处公布的 sha256 校验压缩包完整性。

### 方式三：作为 dsh 插件安装

本机已经在用 dsh（Web/Desktop）时，可把本工具装进 dsh，用设置面板、slash 命令与 agent 工具管理远程会话：

```bash
# 前置：PATH 上有 pnpm（dsh plugin 命令是对 pnpm 的原样转发）
dsh plugin --profile web add dsh-remote-explorer
# dsh 不在 PATH 时：
npx --yes @deepseek-ai/dsh plugin --profile web add dsh-remote-explorer
# 本地源码安装（先构建插件产物）：
npm run build:plugin && dsh plugin --profile web add /path/to/repo
```

装完重启 `dsh web`。插件提供三个入口：

- **左导航「远程 SSH 会话」全局面板**：选主机、连接（桌面端单按钮弹整窗浮动桌面 webview——打开即隐藏主桌面、远程 web 界面铺满整窗、返回/关闭/停止走远端侧栏状态 pill；浏览器端当前标签切入 / 新标签双入口）、断开、远端插件管理、实时进度日志；远端窗口侧栏有状态 pill，可返回管理页或关闭/停止连接
- **slash 命令** `/remote-ssh`：`hosts | connect <别名> [远端目录] | status | disconnect <别名|会话id> [--keep-remote]`
- **agent 工具** `remote_hosts_list / remote_connect / remote_status / remote_kill`（受 dsh 的工具审批门槛约束）

插件与 CLI 共享同一套会话编排与远端落盘（`~/.dsh-remote-explorer/btsd321/`），会话表互通：`dsh-remote-explorer status` 能看到插件维持的会话，插件面板也能看到 CLI 维持的会话（标记「外部」只读）。两点差异：**会话生命周期挂在宿主 dsh 进程上**——dsh 退出默认连远端一起停（profile patch 里 `keepRemoteOnDispose: true` 可保留）；LLM key 取自启动 dsh 的进程环境。详见[使用指南](docs/usage-cn.md)。

## 快速开始

> 下文示例统一以**源码方式**书写；用 release 包时把 `npx tsx src/cli/bin.ts` 替换为 `./dsh-remote-explorer`（Windows 为 `dsh-remote-explorer.cmd`），参数完全一致。

```bash
# 列出 ~/.ssh/config 中的主机
npx tsx src/cli/bin.ts list

# 诊断某台主机的引导条件（myhost 换成你的主机别名或 user@host[:port]）
npx tsx src/cli/bin.ts doctor myhost
npx tsx src/cli/bin.ts doctor myhost --refresh-mirrors   # 强制重测镜像

# 主命令：引导 → 起远端 dsh → 建隧道 → 开浏览器（进程常驻）
# 用哪个供应商就把哪个 key 放进本机环境（供应商清单来自 ~/.dsh/settings.yaml）
DEEPSEEK_API_KEY=sk-xxx ASTUDIO_API_KEY=sk-xxx npx tsx src/cli/bin.ts connect myhost --cwd //home/youruser

# 查看本机维持的所有会话
npx tsx src/cli/bin.ts status

# 停止远端 dsh
npx tsx src/cli/bin.ts kill myhost --all

# 清理远端陈旧资源（旧版本、死会话目录；运行中会话使用的版本受保护）
npx tsx src/cli/bin.ts clean myhost
npx tsx src/cli/bin.ts clean myhost --keep 2   # 每个类别保留 2 个版本

# 只做引导，不起服务（幂等，重复执行会复用已装版本）
npx tsx src/cli/bin.ts provision myhost --cwd //home/youruser

# 通用参数：改用其他 ssh config 文件
npx tsx src/cli/bin.ts list --ssh-config /path/to/config
```

`connect` 之后本进程必须保持运行——正向隧道的本机监听器与 LLM 代理都活在其中。**Ctrl-C 会连远端 dsh 一起停止**（断开即干净）；要断开但保留远端进程供下次复用，加 `--keep-remote`。会话因故障进入终结态时远端进程也会保留。

各命令的详细用法与完整参数说明见 [docs/usage-cn.md](docs/usage-cn.md)。

## 凭据如何工作

模型调用不经公网直连，而是走反向隧道。**多供应商**：代理按路径前缀路由——DeepSeek 原生通道用 `/anthropic`，`~/.dsh/settings.yaml` 里 `llm-pi-ai.providers` 段配置的供应商（如 AStudio、qwen、iflytek）各自走 `/r/<供应商名>`，路由自动提取，无需手动配置：

```
远端 dsh ──(占位令牌)──▶ 远端 127.0.0.1:<反向端口>/r/<供应商> ──SSH 反向通道──▶ 本机代理
                                                                     ├─ /anthropic → api.deepseek.com
                                                                     └─ /r/astudio → maas-api.cn-huabei-1.xf-yun.com
                                                                        （按路由注入对应真实 key）
```

- 各供应商的真实 key（`DEEPSEEK_API_KEY`、`ASTUDIO_API_KEY` 等）**只存在于本机进程**，不落远端磁盘、不进远端环境。远端进程环境里放的是代理令牌（随机值）。
- 本机 `~/.dsh/settings.yaml` 会**整体镜像**到会话的 `DSH_HOME/settings.yaml`（`agent-default-model` 等键随之镜像，远端默认模型与本机一致），仅供应商的 `baseURL` 重定向进隧道。**只镜像 settings（凭据引用，无密钥），绝不镜像 `.credentials.yaml`**（可能含真实密钥）。
- 缺哪个供应商的 key 只影响该供应商（502 带明确指引），其余照常。
- 代理令牌与反向端口随会话固定，落盘远端 `.runtime/`（令牌 600 权限），重连与复用读回同一组值。
- 同一会话的多个本机 CLI 共享凭据路径（反向端口先到先得，后来的视图自动让位）。
- 已知残余风险：远端同权限用户可借你的通道消耗额度（拿不到 key 本身）。多用户远端主机上请知悉：代理以每会话令牌、限速与路径白名单提高借用门槛，但无法完全阻断同权限用户。

## 远端落盘隔离

对标 VS Code `~/.vscode-server` 的单根自治模型：本工具在远端的一切落盘都在 `~/.dsh-remote-explorer/btsd321/` 内（安装、每会话状态、npm 缓存、临时文件），**从不写入**远端 `~/.dsh`（官方 dsh 的家）与 `~/.npm`（远端 npm 使用者共享的缓存）。远端 dsh 的 skill 目录也重定向到会话内（`DSH_AGENTS_HOME`），不读机器全局的 `~/.agents`。

- 同机跑官方 dsh 的其他人不受任何影响；`doctor` 的「隔离检查」段会报告占用。
- 完全卸载 = `rm -rf ~/.dsh-remote-explorer/btsd321`，一个命令走干净。
- 已知低风险共享：远端 pnpm store——仅当有人主动在远端跑 `dsh plugin` 才触及，内容寻址并发安全。

**在 Git Bash 里写远端路径要用双斜杠**（`--cwd //home/xxx`）或先设 `MSYS_NO_PATHCONV=1`。MSYS 会把 `/home/xxx` 改写成 `D:/SoftWare/Git/home/xxx`，这发生在参数到达程序之前，程序只能识别并拒绝。

`doctor` 会检查连接、平台、基础命令、磁盘余量、已装运行时、**Node 运行时稳定性**与各镜像实测延迟。它是排查远程环境问题的首选手段——远程开发的故障大多出在环境而非代码。

## 多用户与远端插件管理

多用户模型对齐 VS Code Remote-SSH：

- **不同远程 OS 账号**连接同一主机 = 完全隔离（各自的远端根目录、会话与插件）
- **同一远程账号** = 共享会话根：同 (主机, 远端目录) 即同一个远端会话（多人多视图），会话内容互见、LLM 凭据代理归先到者——这是预期行为（VS Code 同账号共享 server 亦然）。每人独立远程账号可获得完全隔离
- `kill --all` 与 `clean` 默认只作用于**本机发起的会话**（owner 指纹，会话启动时写入远端 `.runtime/owner`）与无活进程的残留；他人会话跳过并列明，`--include-others` 恢复全量行为

远端插件管理双表面（VS Code「连着就能管」），插件仓库为**用户级**（该远程账号一份，所有会话共享，对标 `~/.vscode-server/extensions/`；会话 profile 经 symlink 接入，零副本）：

- **远端窗口内**：远端 dsh 自带的 Settings 插件 UI 完全可用（引导期已为远端装好 pnpm）
- **本地管理页**：远程会话面板的「远端插件」区可做清单 / 安装 / 启停 / 卸载；操作后**本会话立即 hmr 热生效**，其他会话在下次连接时同步（VS Code 的 Reload Required 等价语义，不自动重启远端）

## 架构

```
本机 (Windows/Linux/macOS)                      远端 (Linux/macOS)
┌────────────────────────────────┐              ┌──────────────────────────────┐
│ 浏览器                          │              │ dsh（完整 npm 安装）          │
│ 127.0.0.1:<本地端口>            │              │ webserver 127.0.0.1:<端口>    │
└───────────────┬────────────────┘              │                              │
                │ HTTP / WS + 会话令牌           │  ├ session / agent           │
┌───────────────▼────────────────┐  正向转发     │  ├ fs / subprocess           │
│ dsh-remote-explorer CLI（常驻）          │══════════════▶│  ├ terminal / lsp            │
│ ├ transport  ssh2 连接与转发     │              │  └ sandbox                   │
│ ├ provision  装 Node 与 dsh      │              │                              │
│ ├ tunnel     端口转发            │  反向转发     │                              │
│ ├ session    心跳与重连          │◀═════════════│  baseURL → 127.0.0.1:<反向>  │
│ └ credential LLM 代理            │              │                              │
│   ▲ DEEPSEEK_API_KEY 只在这里    │              └──────────────────────────────┘
└───┼────────────────────────────┘
    │
真实 LLM API（本机直连出网）
```

依赖方向严格单向向下，下层不得 import 上层：

```
入口层      cli/
编排层      session/
能力层      provision/   tunnel/   credential/
传输层      transport/
基础层      hosts/   util/
```

| 模块 | 职责 |
|---|---|
| [src/util/](src/util/) | shell 转义、错误类型、交互式密码提示（不回显） |
| [src/hosts/ssh-config-parser.ts](src/hosts/ssh-config-parser.ts) | 主机配置的**唯一**来源：解析 ssh config（含 `user@host[:port]` 直连），递归解析 ProxyJump，应用认证覆盖 |
| [src/transport/types.ts](src/transport/types.ts) | 传输抽象接口（按多传输设计，日后可加 Docker / WSL） |
| [src/transport/ssh-transport.ts](src/transport/ssh-transport.ts) | ssh2 实现：跳板机链、命令执行、SFTP、正反向转发、密码认证（被拒重试，最多 3 次） |
| [src/transport/channel-pool.ts](src/transport/channel-pool.ts) | SSH 通道配额，避免超 `MaxSessions` |
| [src/provision/probe.ts](src/provision/probe.ts) | 远端探测 + **Node 稳定性自检** |
| [src/provision/mirror-selector.ts](src/provision/mirror-selector.ts) | 在远端实测镜像延迟并自适应选取 |
| [src/provision/remote-paths.ts](src/provision/remote-paths.ts) | 远端路径规则的唯一真源 |
| [src/provision/node-installer.ts](src/provision/node-installer.ts) | 装 Node，版本隔离，装完自检 |
| [src/provision/dsh-installer.ts](src/provision/dsh-installer.ts) | 装 dsh，版本显式指定不依赖 dist-tag |
| [src/provision/profile-writer.ts](src/provision/profile-writer.ts) | 每会话独立 `DSH_HOME` 与 profile、patch 生成 |
| [src/provision/provisioner.ts](src/provision/provisioner.ts) | 引导流程编排，各步均幂等 |
| [src/util/session-id.ts](src/util/session-id.ts) | 由主机别名 + 远端目录算确定性会话 id |
| [src/tunnel/port-allocator.ts](src/tunnel/port-allocator.ts) | 远端端口分配与监听确认 |
| [src/tunnel/forward-local.ts](src/tunnel/forward-local.ts) | 正向转发，**监听器跨重连存活** |
| [src/session/remote-process.ts](src/session/remote-process.ts) | 远端 dsh 的 detach 启动、令牌捕获、安全停止 |
| [src/session/lifecycle-state.ts](src/session/lifecycle-state.ts) | 会话状态机，纯函数 |
| [src/session/heartbeat.ts](src/session/heartbeat.ts) | 心跳探活：进程 + 端口 + HTTP 应用级，一条命令 |
| [src/session/reconnect.ts](src/session/reconnect.ts) | 有限次指数退避 |
| [src/session/session-registry.ts](src/session/session-registry.ts) | 本机会话表，锁文件 + 原子替换 |
| [src/session/session-manager.ts](src/session/session-manager.ts) | 会话编排：打开、凭据接线、重连、关闭 |
| [src/credential/tunnel-proxy.ts](src/credential/tunnel-proxy.ts) | 反向隧道 LLM 代理（多供应商路由），注入真实 key |
| [src/credential/provider-routes.ts](src/credential/provider-routes.ts) | 从本机 settings.yaml 提取供应商路由，产出远端镜像 |
| [src/credential/token.ts](src/credential/token.ts) | 代理令牌：生成与常数时间比较 |
| [src/cli/](src/cli/) | 命令分派、参数解析、终端输出、命令级认证装配 |

## 开发

```bash
# 类型检查（本地 tsc 不可用，原因见 CLAUDE.md）
npx -y -p typescript@5.7.3 tsc --noEmit
```

代码规范见 [docs/type_script_style.md](docs/type_script_style.md)，写任何代码前先读。

## 打包

产出 release 分发包（见[安装与运行](#方式二release-包运行)）：esbuild 把 CLI 与全部运行时依赖打进单个 `dsh-remote-explorer.cjs`，再按目标平台打入官方 Node 二进制，组装启动器与文档后压缩。产物在 `dist/`（已 gitignore），**不改变源码的 tsx 运行方式**。

```bash
npx tsx scripts/package.ts                        # 打当前运行平台
npx tsx scripts/package.ts --all                  # 五平台全矩阵
npx tsx scripts/package.ts --os linux --arch arm64
```

| 参数 | 说明 |
|---|---|
| `--os <os>` | 目标平台：`win32` / `linux` / `darwin`（默认当前平台） |
| `--arch <arch>` | 目标架构：`x64` / `arm64`（默认当前架构） |
| `--all` | 打全部五平台矩阵，忽略 `--os` / `--arch` |
| `--node-version <版本>` | 打入的 Node 版本（默认 `v24.11.1`） |
| `--mirror <镜像>` | Node 下载源：`npmmirror`（默认，国内可达）/ `official` / 自定义 URL 前缀 |
| `--out-dir <目录>` | 产物目录（默认 `dist`） |
| `--minify` | 压缩产物体积（默认关闭，保留可读堆栈） |

Node 发行包下载时按 SHASUMS256 校验，缓存在 `dist/.node-cache`，重复打包不重新下载。打包完会打印每个产物的路径、体积与 sha256。

## 许可

Apache License 2.0，详见 [LICENSE](LICENSE)。

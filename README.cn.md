# dsh-remote

[English](README.md) | **[中文](README.cn.md)**

远程开发启动器：把 [dsh](https://www.npmjs.com/package/@deepseek-ai/dsh) 装到远程主机上运行，本机只留浏览器。LLM 凭据不离开本机。

参照 VS Code Remote-SSH、Zed、JetBrains Gateway 的做法——**代码与会话都在远端，本机只做呈现**。完整架构依据、调研来源与实测数据见 [PLAN.md](PLAN.md)。

## 支持的环境

- **本机（客户端）**：Windows / Linux / macOS，Node.js v20.19+ 或 v22+（运行 tsx）。
- **远端主机**：Linux 或 macOS（POSIX）；aarch64（arm64）与 x86_64 均可。远端无需预装 Node——工具会自动安装并自检。
- **SSH 认证**：私钥（`IdentityFile`，推荐）；无私钥时在交互式终端提示输入密码（不回显）；也可 `--password` 明文传入（有泄露风险，CLI 会警告）。
- 主机来自 `~/.ssh/config` 的 `Host` 条目，或 `user@host[:port]` 直连（IPv6 需写进 config）。

## 安装

无构建步骤——源码以 `.ts` 形式经 tsx 直接运行。

```bash
npm install
```

## 快速开始

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
- 已知残余风险：远端同权限用户可借你的通道消耗额度（拿不到 key 本身）。多用户远端主机上请知悉，详见 [PLAN.md](PLAN.md) 4.5 节。

## 远端落盘隔离

对标 VS Code `~/.vscode-server` 的单根自治模型：本工具在远端的一切落盘都在 `~/.dsh-remote/` 内（安装、每会话状态、npm 缓存、临时文件），**从不写入**远端 `~/.dsh`（官方 dsh 的家）与 `~/.npm`（远端 npm 使用者共享的缓存）。远端 dsh 的 skill 目录也重定向到会话内（`DSH_AGENTS_HOME`），不读机器全局的 `~/.agents`。

- 同机跑官方 dsh 的其他人不受任何影响；`doctor` 的「隔离检查」段会报告占用。
- 完全卸载 = `rm -rf ~/.dsh-remote`，一个命令走干净。
- 已知低风险共享：远端 pnpm store——仅当有人主动在远端跑 `dsh plugin` 才触及，内容寻址并发安全。

**在 Git Bash 里写远端路径要用双斜杠**（`--cwd //home/xxx`）或先设 `MSYS_NO_PATHCONV=1`。MSYS 会把 `/home/xxx` 改写成 `D:/SoftWare/Git/home/xxx`，这发生在参数到达程序之前，程序只能识别并拒绝。

`doctor` 会检查连接、平台、基础命令、磁盘余量、已装运行时、**Node 运行时稳定性**与各镜像实测延迟。它是排查远程环境问题的首选手段——远程开发的故障大多出在环境而非代码。

## 架构

```
本机 (Windows/Linux/macOS)                      远端 (Linux/macOS)
┌────────────────────────────────┐              ┌──────────────────────────────┐
│ 浏览器                          │              │ dsh（完整 npm 安装）          │
│ 127.0.0.1:<本地端口>            │              │ webserver 127.0.0.1:<端口>    │
└───────────────┬────────────────┘              │                              │
                │ HTTP / WS + 会话令牌           │  ├ session / agent           │
┌───────────────▼────────────────┐  正向转发     │  ├ fs / subprocess           │
│ dsh-remote CLI（常驻）          │══════════════▶│  ├ terminal / lsp            │
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

# 打分发包：单文件 CLI + 目标平台 Node 二进制，目标机解压即用（产物在 dist/）
npx tsx scripts/package.ts --all          # 五平台矩阵
npx tsx scripts/package.ts --os linux --arch arm64
```

代码规范见 [docs/type_script_style.md](docs/type_script_style.md)，写任何代码前先读。

## 许可

Apache License 2.0，详见 [LICENSE](LICENSE)。

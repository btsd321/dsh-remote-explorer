# dsh-remote-explorer 使用指南（中文）

[English](usage-en.md) | **[中文](usage-cn.md)**

本文档详细介绍 `dsh-remote-explorer` 的每个命令、参数及常见工作流。

> 示例统一以源码方式（`pnpm exec tsx src/cli/bin.ts <命令>`，开发环境默认 pnpm）书写；用 release 分发包时把它替换为 `./dsh-remote-explorer <命令>`（Windows 为 `dsh-remote-explorer.cmd <命令>`），命令与参数完全一致。

## 目录

- [前置条件](#前置条件)
- [认证与主机指定](#认证与主机指定)
- [命令总览](#命令总览)
- [list — 列出 SSH 主机](#list--列出-ssh-主机)
- [doctor — 诊断主机](#doctor--诊断主机)
- [provision — 配置远端环境](#provision--配置远端环境)
- [connect — 启动完整会话](#connect--启动完整会话)
- [status — 查看活跃会话](#status--查看活跃会话)
- [kill — 停止远端 dsh](#kill--停止远端-dsh)
- [clean — 清理陈旧远端资源](#clean--清理陈旧远端资源)
- [help — 显示帮助](#help--显示帮助)
- [常见工作流](#常见工作流)
- [退出码](#退出码)
- [Git Bash 路径注意事项](#git-bash-路径注意事项)
- [以 dsh 插件形式使用](#以-dsh-插件形式使用)

---

## 前置条件

- **Node.js** v20.19+ 或 v22+（本机运行 tsx 用）。
- 一台可 SSH 登录的远端主机：写进 `~/.ssh/config` 的 `Host` 条目，或用 `user@host[:port]` 直连（IPv6 需写进 config）。认证支持私钥（`IdentityFile`，可用 `--private-key` 覆盖）；未配置私钥且在交互式终端时，会提示输入密码（不回显，只存内存不落盘）；也可用 `--password <密码>` 明文传入——**有泄露风险**（命令行、进程列表与 shell 历史都能看到），CLI 会打印警告，建议仅作临时手段。
- 远端主机必须是 **Linux 或 macOS**（POSIX）。本机客户端支持 Windows、Linux 和 macOS。
- 使用哪个 LLM 供应商，就将其 **API key** 作为环境变量导出（如 `DEEPSEEK_API_KEY`），在运行 `dsh-remote-explorer connect` 的 shell 中设置。

## 认证与主机指定

所有需要连接远端的命令（`doctor` / `provision` / `connect` / `kill` / `clean`）共用同一套认证规则。

### 主机参数

命令中的 `<别名>` 有两种写法：

- **ssh config 别名**：`~/.ssh/config` 中的 `Host` 条目（自动合并 `Host *` 默认值、递归解析 `ProxyJump` 跳板机链）。config 里有同名条目时始终优先。
- **直连语法** `user@host[:port]`：不写 config 也能连。端口省略时为 22；IPv6 字面量因与端口后缀冲突不支持内联，需写进 config。直连主机没有跳板机。

### 认证方式与优先级

```
--private-key  >  --password  >  config IdentityFile  >  交互式密码提示
```

- **`--private-key <路径>`**：私钥文件路径，优先于 config 里的 `IdentityFile`。支持 `~/` 前缀。
- **`--password <密码>`**：明文密码，显式走密码认证（config 里有私钥也优先用密码）。**有泄露风险**——密码会出现在命令行、进程列表与 shell 历史中，CLI 会打印警告。被拒后不重试。仅作临时手段，推荐私钥或交互输入。
- **`--private-key` 与 `--password` 同给**：密钥优先，`--password` 被忽略（有提示）。
- **交互式密码提示**：主机（含跳板机）没有配置 `IdentityFile` 且终端可交互时，连接过程中提示输入密码——**不回显**，输错会重新提示，最多 3 次。密码只存本进程内存，不落盘、不进日志。非交互终端（管道/CI）下不提示，直接报「缺少 IdentityFile」。

### 跳板机规则

`--private-key` / `--password` **只作用于目标主机**；跳板机的认证仍来自 config（无私钥且终端可交互时，逐级提示输密码）。

### 重连时的密码

会话自动重连是无人值守的：**不会弹密码提示**，只复用本次连接输入/传入的密码。密码在远端被改后，重连会立即终止并提示重新 `connect`，而不是反复失败或挂住等输入。

## 命令总览

```
dsh-remote-explorer <命令> [参数]
```

| 命令 | 说明 |
|---|---|
| `connect <别名>` | 主命令：引导 → 起远端 dsh → 建隧道 → 开浏览器（常驻） |
| `status` | 列出本机正在维持的所有会话 |
| `kill <别名>` | 停止远端 dsh 进程 |
| `clean <别名>` | 清理远端陈旧资源（旧版本、死会话目录） |
| `list` | 列出 ~/.ssh/config 中的主机 |
| `doctor <别名>` | 诊断某台主机的引导条件 |
| `provision <别名>` | 只做引导，不起服务（幂等） |
| `help` | 显示帮助 |

本项目无构建步骤，通过 tsx 直接运行：

```bash
pnpm exec tsx src/cli/bin.ts <命令> [参数]
```

---

## list — 列出 SSH 主机

列出 `~/.ssh/config` 中的所有 `Host` 条目。纯本地操作，不连接任何主机。

```bash
pnpm exec tsx src/cli/bin.ts list
```

**参数：**

| 参数 | 说明 |
|---|---|
| `--ssh-config <路径>` | 使用指定的 ssh config 文件，而非默认的 `~/.ssh/config` |

**输出：** 表格显示每台主机的别名、地址、用户、端口和跳板机。

---

## doctor — 诊断主机

对主机的引导条件进行全面诊断。这是**排查远端问题的首选手段**——远程开发的故障大多出在环境而非代码。

```bash
pnpm exec tsx src/cli/bin.ts doctor <别名>
```

**参数：**

| 参数 | 说明 |
|---|---|
| `--refresh-mirrors` | 强制重测镜像延迟，忽略缓存 |
| `--ssh-config <路径>` | 使用指定的 ssh config 文件 |
| `--private-key <路径>` | 私钥路径，优先于 config 的 IdentityFile（见[认证与主机指定](#认证与主机指定)） |
| `--password <密码>` | 明文密码认证（有泄露风险，见[认证与主机指定](#认证与主机指定)） |

**检查内容：**

1. **SSH 配置** — 验证别名可解析，显示连接目标和跳板机链。
2. **连接与平台** — 建立 SSH 连接，报告 OS/架构。
3. **基础命令** — 检查 `curl`/`wget`、`tar`、`xz` 是否存在。
4. **磁盘余量** — 验证家目录至少有 ~1.5 GB 可用空间（引导需约 0.7 GB）。
5. **已装运行时** — 列出本工具已安装的 Node 和 dsh 版本。
6. **Node 稳定性** — 对每个已装的 Node 版本做稳定性自检（多次启动进程；aarch64 上 v22 的已知问题）。
7. **镜像延迟** — 从远端主机（而非本机）测 Node 发行版和 npm registry 镜像延迟。
8. **SSH 通道使用** — 报告当前通道池使用情况。
9. **隔离检查** — 报告本工具在远端的磁盘占用，确认 `~/.dsh`（官方 dsh 的家）未被写入。

**退出码：** 全部通过或仅有警告返回 `0`；存在致命问题返回 `1`。

---

## provision — 配置远端环境

在远端主机上安装 Node 和 dsh，直到 `dsh --version` 输出正确版本。不启动服务、不建隧道。**幂等**——重复执行相同版本会复用已装版本。

```bash
pnpm exec tsx src/cli/bin.ts provision <别名> --cwd //home/user
```

**参数：**

| 参数 | 说明 |
|---|---|
| `--cwd <路径>` | 远端工作目录（参与会话 id 计算） |
| `--node-version <版本>` | 目标 Node 版本（默认 v24 系） |
| `--dsh-version <版本>` | 目标 dsh 版本或 dist-tag |
| `--refresh-mirrors` | 强制重测镜像延迟 |
| `--ssh-config <路径>` | 使用指定的 ssh config 文件 |
| `--private-key <路径>` | 私钥路径，优先于 config 的 IdentityFile（见[认证与主机指定](#认证与主机指定)） |
| `--password <密码>` | 明文密码认证（有泄露风险，见[认证与主机指定](#认证与主机指定)） |

**为什么单独成命令：** 引导是最慢也最容易失败的一步（全新安装约 75 秒）。独立出来便于单独重试与诊断。

**版本隔离：** 每个 Node 和 dsh 版本装在各自目录（如 `~/.dsh-remote-explorer/btsd321/node/v24.21.0/`、`~/.dsh-remote-explorer/btsd321/versions/dsh-0.1.6-alpha.2/`）。升级从不原地覆盖——这避免了"运行中进程占着文件，写入报 Text file busy"的故障。

**输出：** 表格显示远端根目录、Node 版本、dsh 版本、dsh 入口路径和会话 `DSH_HOME`。

---

## connect — 启动完整会话

主命令。编排完整流程：引导 → 起远端 dsh → 建正向隧道 → 开浏览器 → 维持会话（常驻）。

```bash
DEEPSEEK_API_KEY=sk-xxx pnpm exec tsx src/cli/bin.ts connect <别名> --cwd //home/user
```

**参数：**

| 参数 | 说明 |
|---|---|
| `--cwd <路径>` | 远端工作目录（参与会话 id 计算） |
| `--local-port <端口>` | 本机监听端口（默认由系统分配） |
| `--no-open` | 不自动打开浏览器 |
| `--force-restart` | 即便远端已有可用会话也重新启动 |
| `--keep-remote` | Ctrl-C 断开时保留远端 dsh（默认连它一起停止） |
| `--node-version <版本>` | 目标 Node 版本（默认 v24 系） |
| `--dsh-version <版本>` | 目标 dsh 版本或 dist-tag |
| `--refresh-mirrors` | 强制重测镜像延迟 |
| `--ssh-config <路径>` | 使用指定的 ssh config 文件 |
| `--private-key <路径>` | 私钥路径，优先于 config 的 IdentityFile（见[认证与主机指定](#认证与主机指定)） |
| `--password <密码>` | 明文密码认证（有泄露风险，见[认证与主机指定](#认证与主机指定)） |

**connect 过程：**

1. **引导** — 在远端安装 Node 和 dsh（已装则跳过），并安装 pnpm、确保用户级插件仓库骨架。
2. **接入插件仓库** — 会话 profile 的 node_modules 整体 symlink 到用户级插件仓库并同步清单（hmr 热生效）。
3. **启动远端 dsh** — 以 detach 模式启动 dsh，使用每会话独立的 `DSH_HOME` 和环境变量。
3. **建正向隧道** — 将远端 dsh webserver 端口转发到本机端口，使浏览器可访问。
4. **凭据接线** — 启动反向隧道代理，向远端环境注入占位令牌，镜像本机 `settings.yaml`（供应商 baseURL 重定向进隧道）。
5. **打开浏览器** — 用会话 URL（含访问令牌）启动默认浏览器。
6. **保持运行** — 进程阻塞，维持隧道和代理。心跳每 5 秒执行一次。

**环境变量：**

- `DEEPSEEK_API_KEY` 等 LLM key：在启动 `connect` 的 shell 中导出（用哪个供应商导哪个，清单来自 `~/.dsh/settings.yaml`）。
- `DSH_REMOTE_PROXY`：无公网主机的代理兜底。远端 dsh 装 GitHub 插件走 HTTPS（`git ls-remote https://github.com/...`），**SSH(22) 能通不代表 HTTPS(443) 能通**。设了它，启动器把 `http_proxy`/`https_proxy`/`ALL_PROXY`（大小写共六个键）注入远端 dsh 进程，值指向 SSH 反向隧道在远端回环暴露的代理端口（如 `http://127.0.0.1:18890`）；dsh 会把这些变量透传给它拉起的 `git`/`pnpm` 子进程。不设则不注入任何变量，直连主机零影响。
- 注入发生在**启动远端进程时**：复用已运行的会话不会补注入，需 `--force-restart`。插件形态的 per-host 齿轮配置优先于本变量（见[以 dsh 插件形式使用](#以-dsh-插件形式使用)）。

**会话复用：** 用相同别名和 `--cwd` 再次 `connect`，会探到已运行的远端 dsh 并复用。新 CLI 获得自己的本机隧道端口。多个 CLI 可共享一个远端会话。

**Ctrl-C 行为：**

- 默认：同时停止本机进程和远端 dsh（断开即干净）。
- `--keep-remote`：只停本机进程；远端 dsh 继续运行，下次 `connect` 复用。
- 会话因故障进入终结态（如重连耗尽）时，远端进程保留。

**输出：** 表格显示访问 URL、本机/远端端口、远端 pid、Node/dsh 版本、会话 id 和凭据代理状态（路由数、缺失的 key）。

---

## status — 查看活跃会话

列出本机当前维持的所有远端会话。纯本地操作——只读会话表，不连接任何主机。

```bash
pnpm exec tsx src/cli/bin.ts status
```

陈旧条目（维持会话的本机 CLI 已退出）会自动清理。

**输出：** 表格显示主机别名、远端目录、本机访问 URL、远端端口、远端 pid 和启动时间。

**注意：** 访问 URL 需要令牌。请使用 `connect` 输出的完整 URL（含 `?token=...`）；`status` 只显示不含令牌的基础 URL。

---

## kill — 停止远端 dsh

停止远端 dsh 进程。当远端进程状态异常（配置改了没生效、端口被占、进程卡死）时使用。

```bash
# 停止指定会话
pnpm exec tsx src/cli/bin.ts kill <别名> --cwd //home/user

# 停止该主机上的全部会话（含孤儿进程）
pnpm exec tsx src/cli/bin.ts kill <别名> --all
```

**参数：**

| 参数 | 说明 |
|---|---|
| `--cwd <路径>` | 指定要停止的会话（与 `--all` 互斥） |
| `--all` | 停止该主机上的全部**本机发起的**会话（含孤儿） |
| `--include-others` | `--all` 时连他人指纹的会话一起停止（默认跳过并列明） |
| `--ssh-config <路径>` | 使用指定的 ssh config 文件 |
| `--private-key <路径>` | 私钥路径，优先于 config 的 IdentityFile（见[认证与主机指定](#认证与主机指定)） |
| `--password <密码>` | 明文密码认证（有泄露风险，见[认证与主机指定](#认证与主机指定)） |

**安全机制：** 进程定位用 pid 文件或监听端口——**绝不用 `pkill -f`**，那会杀掉执行命令自身的 SSH 会话。

**多用户 scope：** 每个会话目录在启动时写入 owner 指纹（本机主机名 + OS 用户）。`--all` 默认只停止**指纹匹配本机的会话**与无活进程的残留；他人指纹的活会话跳过并在输出中列明，`--include-others` 恢复旧的全量行为。多人连同一远端账号时避免误杀他人会话。

安装目录与会话 profile 在 kill 后保留。用 `connect` 可再次启动。

---

## clean — 清理陈旧远端资源

删除远端的陈旧会话目录、旧版 Node 和旧版 dsh。这是版本入名 + 每会话目录策略的必要配套——两者都会累积。

```bash
# 默认各保留最新 1 个版本
pnpm exec tsx src/cli/bin.ts clean <别名>

# 每个类别保留 2 个版本
pnpm exec tsx src/cli/bin.ts clean <别名> --keep 2
```

**参数：**

| 参数 | 说明 |
|---|---|
| `--keep <数量>` | 每个类别保留的最新版本数（默认 1） |
| `--include-others` | 连他人指纹的陈旧会话目录一起删除（默认跳过并列明） |
| `--ssh-config <路径>` | 使用指定的 ssh config 文件 |
| `--private-key <路径>` | 私钥路径，优先于 config 的 IdentityFile（见[认证与主机指定](#认证与主机指定)） |
| `--password <密码>` | 明文密码认证（有泄露风险，见[认证与主机指定](#认证与主机指定)） |

**保护机制：** 活会话的 runner 脚本（`.runtime/start.sh`）记录着正在使用的 dsh 与 Node 路径。删除前先收集所有活会话引用的路径；被引用的版本即使旧于保留线也不删——删掉正在运行的安装，进程下次重启就找不到了。

**清理内容：**

- **陈旧会话目录** — pid 文件指向的进程已不在的会话；他人指纹的目录默认跳过（`--include-others` 可包含）。
- **旧版 dsh** — 保留最新 N 个，其余删除（受保护的除外）。
- **旧版 Node** — 同上。

用户级插件仓库（`plugins/`）是共享数据，**永不被 clean 触碰**。

**输出：** 报告释放的空间、删除的会话/版本以及受保护跳过的版本。

---

## help — 显示帮助

```bash
pnpm exec tsx src/cli/bin.ts help
# 或
pnpm exec tsx src/cli/bin.ts --help
# 或
pnpm exec tsx src/cli/bin.ts -h
```

版本号：

```bash
pnpm exec tsx src/cli/bin.ts --version
# 或
pnpm exec tsx src/cli/bin.ts -V
```

---

## 常见工作流

### 首次设置

```bash
# 1. 安装依赖（开发环境默认 pnpm）
pnpm install

# 2. 列出可用主机
pnpm exec tsx src/cli/bin.ts list

# 3. 诊断目标主机
pnpm exec tsx src/cli/bin.ts doctor my-server

# 4. 引导（可选——connect 会自动做）
pnpm exec tsx src/cli/bin.ts provision my-server --cwd //home/user

# 5. 连接
DEEPSEEK_API_KEY=sk-xxx pnpm exec tsx src/cli/bin.ts connect my-server --cwd //home/user
```

### 密码登录（未配置私钥的主机）

```bash
# 直连语法 + 交互式输密码（不回显，输错可重试，最多 3 次）
pnpm exec tsx src/cli/bin.ts doctor user@192.168.0.10

# connect 时同理；密码只存本进程内存，重连时静默复用
DEEPSEEK_API_KEY=sk-xxx pnpm exec tsx src/cli/bin.ts connect user@192.168.0.10 --cwd //home/user

# 临时脚本场景可用明文（有泄露风险，CLI 会警告）
DEEPSEEK_API_KEY=sk-xxx pnpm exec tsx src/cli/bin.ts connect user@192.168.0.10 --cwd //home/user --password 'xxx'

# 显式指定私钥（优先于 config 的 IdentityFile）
pnpm exec tsx src/cli/bin.ts connect my-server --cwd //home/user --private-key ~/.ssh/id_ed25519
```

### 无公网主机经代理装插件

远端 dsh 装插件（如 `github:btsd321/...`）走 HTTPS；主机无公网时裸连超时，dsh 里报「连接 GitHub 超时」。把本机代理经 SSH 反向隧道借到远端回环后，让启动器注入代理变量：

```bash
# 假设反向隧道把本机代理暴露在远端 127.0.0.1:18890
DSH_REMOTE_PROXY=http://127.0.0.1:18890 DEEPSEEK_API_KEY=sk-xxx \
  pnpm exec tsx src/cli/bin.ts connect my-server --cwd //home/user
```

验证方法：连接输出里的远端 pid，在远端跑 `cat /proc/<pid>/environ | tr '\0' '\n' | grep -i proxy` 应看到代理变量；`https_proxy=http://127.0.0.1:18890 git ls-remote https://github.com/<仓库> HEAD` 应返回 commit hash（这就是 dsh 装插件前的探测命令）。插件形态改用面板的每主机 ⚙ 齿轮按钮配置（代理快捷项一键填入，下次连接生效）。

### 重连到已有会话

```bash
# 如果上次断开时用了 --keep-remote（或会话从故障中存活）
DEEPSEEK_API_KEY=sk-xxx pnpm exec tsx src/cli/bin.ts connect my-server --cwd //home/user
```

工具会探到正在运行的远端 dsh 并复用。你获得一个新的本机隧道端口。

### 完整清理

```bash
# 停止远端 dsh
pnpm exec tsx src/cli/bin.ts kill my-server --all

# 清理旧版本和死会话
pnpm exec tsx src/cli/bin.ts clean my-server

# 远端完整卸载（在远端主机上执行）
rm -rf ~/.dsh-remote-explorer/btsd321
```

### 强制重启卡住的会话

```bash
DEEPSEEK_API_KEY=sk-xxx pnpm exec tsx src/cli/bin.ts connect my-server --cwd //home/user --force-restart
```

### 不自动打开浏览器

```bash
DEEPSEEK_API_KEY=sk-xxx pnpm exec tsx src/cli/bin.ts connect my-server --cwd //home/user --no-open
```

访问 URL（含令牌）会打印在终端中，手动打开即可。

---

## 退出码

| 码 | 含义 |
|---|---|
| 0 | 成功 |
| 1 | 未预期的错误（内部缺陷） |
| 2 | 主机未找到或配置无效 |
| 3 | 连接失败 |
| 4 | 远端命令执行失败 |
| 5 | 平台不受支持 |
| 6 | Node 运行时不稳定 |
| 7 | 所有镜像不可达 |
| 8 | 缺少必要的远端工具 |
| 64 | 参数无效 |
| 130 | 中断（Ctrl-C） |

---

## Git Bash 路径注意事项

在 Windows 上使用 Git Bash（MSYS）时，写远端路径如 `--cwd /home/user` 会被 MSYS 在参数到达程序**之前**改写为类似 `D:/SoftWare/Git/home/user` 的形式。CLI 能检测并拒绝 Windows 风格的路径，但要避免此问题：

- 使用**双斜杠**：`--cwd //home/user`
- 或设置环境变量：`MSYS_NO_PATHCONV=1`

CLI 内部会将 `//home/user` 归一化为 `/home/user`，保证两种写法的会话 id 一致。

（插件形态不受此影响：面板与聊天框输入不经过 shell，`/home/user` 直接写即可。）

---

## 以 dsh 插件形式使用

0.6.0 起本工具同时是合法的 dsh 插件包：装进本机 dsh 的 profile 后，远程会话管理出现在左导航全局面板、slash 命令与 agent 工具三个入口里。**插件与 CLI 共享同一套会话编排、远端引导与会话表**——不是精简版，而是同一引擎换了驾驶舱。

### 安装

前置条件：本机已有 dsh（`@deepseek-ai/dsh` ≥ 0.1.5-rc.2），且 **PATH 上有 pnpm**（`dsh plugin` 命令是对 pnpm 的原样转发，缺失时报 exit 127）。

```bash
# 从 npm 安装（装进 web profile 并自动激活）
dsh plugin --profile web add dsh-remote-explorer

# dsh 不在 PATH 时
npx --yes @deepseek-ai/dsh plugin --profile web add dsh-remote-explorer

# 本地源码安装（开发）：先构建插件产物再装
pnpm run build:plugin
dsh plugin --profile web add /path/to/repo

# 开发沙箱（隔离 DSH_HOME，绝不碰 ~/.dsh；含启动冒烟）
pnpm exec tsx scripts/dev-plugin.ts          # 常驻，Ctrl-C 停
pnpm exec tsx scripts/dev-plugin.ts --smoke  # 探针跑完即杀（CI）
pnpm exec tsx scripts/dev-plugin.ts --sync   # 只同步产物进沙箱
```

装完重启 `dsh web`（dsh 契约：包替换需重启进程才加载新代码）。卸载：`dsh plugin --profile web remove dsh-remote-explorer`。

> **pnpm 11.7+ 构建脚本审批门**：pnpm 11.7 把「带安装脚本的依赖未决策」当致命错误，本包依赖树里的 `cpu-features`/`esbuild`/`ssh2` 会让首次 `dsh plugin add` 报 `ERR_PNPM_IGNORED_BUILDS` 失败（与安装源无关）。插件运行期不需要它们的构建产物（产物预构建、ssh2 回落纯 JS）。**推荐在 dsh 网页版插件管理页安装**（自带批准并重试）；CLI 路径见下方故障排查「add 报 ERR_PNPM_IGNORED_BUILDS」。

### 三个入口

**左导航「远程 SSH 会话」**（全局面板，与「插件」按钮平级；0.6.x 起从 Settings 迁出——设置页只放偏好，工作流面板独立成面）：

- 连接表单：主机（下拉来自 `~/.ssh/config`，也可直填 `user@host[:port]`）、远端目录（按主机记忆上次值）、高级选项（本机端口 / 强制重启 / 重测镜像 / Node 与 dsh 版本 / 私钥路径）、SSH 密码框、**⚙ 环境变量按钮**（按主机配置自定义环境变量：key-value 行编辑 + 代理快捷项，存宿主侧 `~/.dsh/remote-host-env.json`，不写 ssh config；连接时注入远端 dsh 进程，`DSH_HOME`/`DSH_AGENTS_HOME`/`PATH` 为保留键禁配）。会话行也有同款齿轮（「外部」会话除外）。**窗口形态按钮按环境分流**：
  - **桌面端（DeepSeek Harness）**：单按钮「在新窗口连接」——就绪后弹**整窗浮动桌面**（桌面壳是单 OS 窗口，http/https 弹窗与跨 origin 导航全被甩给系统浏览器，应用内唯一通道是 webview；浮层不透明铺满窗口 = 打开即隐藏主桌面及其标题栏按钮，收起即还原，窗口最小化/全屏整体一起动）。**不叠加自建顶栏**：远程 dsh 的 web 界面铺满整窗，它没有桌面壳标题栏（web 形态本就不渲染「应用/编辑」菜单条），返回/关闭/停止一律走远程侧栏底部那枚状态 pill（见[远端窗口交接](#远端窗口交接handoff)）；加载阶段（webview 未夺焦）Esc 也可收起。应用重载后浮层不自动恢复，从面板重开即可
  - **浏览器端**：双入口（对标 VS Code）——「在当前标签页连接」= 就绪后 3 秒倒计时同标签切入远端窗口（可取消）；「在新标签页连接」= 本页留守管理，会话行按钮开远端新标签
- 会话表：状态点、本机端口、行内入口（桌面端「新窗口打开」= 整窗浮动桌面；浏览器端「进入（当前标签）」与「新标签打开 ↗」，新页 = **隧道转发后的远端 dsh 界面**）、「断开」按钮（默认勾选「同时停止远端 dsh」）；其他本机进程维持的会话标「外部」只读
- 远端插件区：选中会话后管理其远端 profile 的用户级插件仓库（清单 / 安装 / 启停 / 卸载，见[远端插件管理](#远端插件管理)）
- 进度日志：选中会话后实时增量滚动（引导阶段、状态迁移、错误全在这里）

**slash 命令**（聊天输入框）：

```
/remote-ssh hosts                             列出 ssh config 主机
/remote-ssh connect <别名> [远端目录]          后台发起连接（立即返回）
/remote-ssh status                            会话列表与状态
/remote-ssh disconnect <别名|会话id> [--keep-remote]
```

**agent 工具**（模型可调用，受 dsh 的工具审批门槛约束）：`remote_hosts_list`、`remote_connect`、`remote_status`、`remote_kill`。全部非阻塞语义：connect 立即返回会话 id，模型用 status 轮询进度。**工具永不接受密码参数**——需要密码认证的主机走面板或 CLI。

### 远端窗口交接（handoff）

远端窗口（桌面端的整窗浮动桌面、浏览器端「新标签打开」或倒计时切入的远端 dsh 界面）侧栏底部有一枚**状态 pill**（主机别名 + 状态点），点开是本机连接管理菜单：连接状态、进度日志尾、三个动作——**返回本地管理页** / **关闭远程连接并返回** / **停止远端 dsh 并返回**。后两者是 navigate-then-act：先同标签导航回本地管理页（地址栏带 intent hash），管理页加载后弹出横幅确认才执行——断开会立刻杀死经隧道服务的远端页面，动作必须由存活方执行（VS Code「Close Remote Connection 后窗口重载回本地」的等价物）。CLI 形态没有管理页，远端菜单自动降级为只读。**桌面端（整窗浮动桌面）传的是一个假意图 origin 而非真实管理页地址**：webview 策略拒绝导航回应用 origin，真实地址传了也是死链；改用假 origin 后，「返回本地管理页」的 `window.open` 被桌面壳 deny 并转发给浮层（= 收起浮层回主窗口），「关闭/停止并返回」的 `location.href` 被浮层监听 webview `will-navigate` 截获（= 执行断开/停止后收起）——handoff 组件零改动、菜单不再只读，浮层也无需自建顶栏。

### 远端插件管理

远端插件仓库是**用户级**的（每个远程 OS 账号一份：`~/.dsh-remote-explorer/btsd321/plugins/`，对标 VS Code 的 `~/.vscode-server/extensions/`）；该账号所有会话的 profile 经 symlink 接入，零副本。两个表面操作同一份仓库：

- **本地管理页**：面板「远端插件」区——清单 / 安装（包名或 `包名@版本`，交给远端 pnpm）/ 启停 / 卸载。操作后**本机活会话立即经 hmr 热生效**，其他用户的活会话在其下次连接时同步
- **远端窗口内**：远端 dsh 自带的 Settings 插件 UI（引导期已为远端装好 pnpm）

安装/卸载对老于 hmr 的远端 dsh 回退为「重连或重启后生效」。并发安装由 pnpm 自身目录锁与引导临界区 flock 串行化。会话 profile 里写有 `.npmrc`（`virtual-store-dir` 钉到 store 的 `.pnpm`）——profile 的 node_modules 是指向 store 的 symlink，不钉的话远端窗口原生 UI 在 profile 目录跑 pnpm 会报 `ERR_PNPM_UNEXPECTED_VIRTUAL_STORE`。

### 多用户与会话归属

对齐 VS Code 模型：**不同远程 OS 账号 = 完全隔离**（各自的远端根、会话与插件仓库）；**同远程账号 = 共享会话根与插件仓库**——同 (主机, 远端目录) 即同一会话，多人多视图，会话内容互见、LLM 凭据代理归先到者。共享是预期行为（VS Code 同账号共享 server 亦然）；要完全隔离请每人使用独立远程账号。破坏性操作（`kill --all` / `clean`）按 owner 指纹 scope，见各自章节；指纹可用环境变量 `DSH_OWNER_TAG` 覆盖（测试钩子）。

### 配置（profile patch 层）

在 profile 的 `cordis.patch.yml` 里按 entry id 覆盖：

```yaml
- id: dsh-remote-explorer
  config:
    host: myhost              # 默认主机别名
    cwd: /home/youruser       # 默认远端目录
    keepRemoteOnDispose: false # 宿主退出时是否保留远端 dsh
    localPort: 0              # 本机端口（0 = 自动分配）
    nodeVersion: ""           # 空 = provisioner 默认
    dshVersion: ""            # 空 = provisioner 默认
    forceRestart: false
    refreshMirrors: false
    panel: true               # false = 不注册面板路由，只留命令与工具
```

**没有 password 字段**——Config 会随 patch 落盘，密码进配置等于明文写磁盘。

### 生命周期与凭据（与 CLI 的差异）

| | CLI | 插件 |
|---|---|---|
| 会话挂在哪个进程 | `connect` 的常驻 CLI 进程 | 宿主 dsh 进程 |
| 进程退出时 | Ctrl-C 默认停远端（`--keep-remote` 保留） | dispose 默认停远端（`keepRemoteOnDispose: true` 保留） |
| 被 SIGKILL | 远端 detach 存活，`kill` 命令兜底 | 同左 |
| LLM key 来源 | 启动 CLI 的 shell 环境 | 启动 dsh 的进程环境 |
| settings 镜像来源 | `~/.dsh/settings.yaml` | `$DSH_HOME/settings.yaml`（宿主真正在用的那份） |

会话表（`~/.dsh/remote-sessions.json`）两形态互见：插件面板显示 CLI 维持的会话（「外部」只读），`status` 命令显示插件维持的会话。

### 故障排查

- **装完面板没出现**：确认重启了 dsh；`curl http://127.0.0.1:<端口>/api/dsh-remote-explorer/ping` **带会话 Cookie** 应得 200（这才是路由注册的证据）；不带凭据的 401 只证明 `/api` 鉴权门在工作、对未注册路由同样返回，不能当挂载证据；带 Cookie 仍 404 = 插件没激活（查 profile `package.json` 的 `dsh.profile.bundles` 是否含本包）
- **`add` 报 ERR_PNPM_IGNORED_BUILDS（pnpm 11.7+）**：`cpu-features`/`esbuild`/`ssh2` 三个构建脚本待决策，插件运行期不需要它们的构建产物。处理：① 编辑 `~/.dsh/profiles/web/pnpm-workspace.yaml`，把三个待决策的 `allowBuilds` 项改成 `false`；② 删掉 `~/.dsh/profiles/web/package.json` 里 `dependencies` 中半提交的 `dsh-remote-explorer` 条目（失败后残留；不删直接重试会退出 0 但不激活——dsh CLI 在 0.1.7-rc.1/rc.2 都有此行为）；③ 重跑 add。或直接在 dsh 网页版插件管理页安装（自带批准并重试）
- **pnpm 未找到（exit 127）**：`npm i -g pnpm`
- **peer 依赖警告**：`autoInstallPeers: false` 下属预期，运行时经 profile 安装回退链接共享宿主实例，不影响使用
- **连接一直卡在引导**：面板日志区看阶段输出；远端首次引导要下载 Node 与 dsh（数分钟），`doctor` 可先诊断
- **远端窗口没有状态 pill**：确认会话在 0.6.x 后连接过（老会话重连时补装组件，存活复用的远端进程要下次重启才出现）；带 Cookie 访问远端 `/api/dsh-remote-handoff/meta` 应得 200，503 = 会话运行时材料缺失
- **远端插件安装失败**：面板日志看 pnpm 报错；registry 由引导测速缓存决定；同一远端账号并发引导/安装时后者等 flock，超时 15 分钟报「另一引导正在进行」
- **远端装 GitHub 插件报「连接 GitHub 超时」**：dsh 装 `github:` 插件走 HTTPS（`git ls-remote`），SSH(22) 通不代表 HTTPS(443) 通。给启动器配代理：CLI 设 `DSH_REMOTE_PROXY`（见[常见工作流](#常见工作流)），插件面板用主机输入框旁或会话行的 ⚙ 齿轮按主机配置（代理快捷项可一键填入）。配置在**下一次连接**生效——已运行的会话需断开（勾选「同时停止远端 dsh」）后重连才会注入

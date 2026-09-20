# dsh-remote 使用指南（中文）

[English](usage-en.md) | **[中文](usage-cn.md)**

本文档详细介绍 `dsh-remote` 的每个命令、参数及常见工作流。

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

---

## 前置条件

- **Node.js** v20.19+ 或 v22+（本机运行 tsx 用）。
- 一台可 SSH 登录的远端主机：写进 `~/.ssh/config` 的 `Host` 条目，或用 `user@host[:port]` 直连（IPv6 需写进 config）。认证支持私钥（`IdentityFile`，可用 `--private-key` 覆盖）；未配置私钥且在交互式终端时，会提示输入密码（不回显，只存内存不落盘）；也可用 `--password <密码>` 明文传入——**有泄露风险**（命令行、进程列表与 shell 历史都能看到），CLI 会打印警告，建议仅作临时手段。
- 远端主机必须是 **Linux 或 macOS**（POSIX）。本机客户端支持 Windows、Linux 和 macOS。
- 使用哪个 LLM 供应商，就将其 **API key** 作为环境变量导出（如 `DEEPSEEK_API_KEY`、`ASTUDIO_API_KEY`），在运行 `dsh-remote connect` 的 shell 中设置。

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
dsh-remote <命令> [参数]
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
npx tsx src/cli/bin.ts <命令> [参数]
```

---

## list — 列出 SSH 主机

列出 `~/.ssh/config` 中的所有 `Host` 条目。纯本地操作，不连接任何主机。

```bash
npx tsx src/cli/bin.ts list
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
npx tsx src/cli/bin.ts doctor <别名>
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
npx tsx src/cli/bin.ts provision <别名> --cwd //home/user
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

**版本隔离：** 每个 Node 和 dsh 版本装在各自目录（如 `~/.dsh-remote/node/v24.11.1/`、`~/.dsh-remote/versions/dsh-0.1.6-alpha.2/`）。升级从不原地覆盖——这避免了"运行中进程占着文件，写入报 Text file busy"的故障。

**输出：** 表格显示远端根目录、Node 版本、dsh 版本、dsh 入口路径和会话 `DSH_HOME`。

---

## connect — 启动完整会话

主命令。编排完整流程：引导 → 起远端 dsh → 建正向隧道 → 开浏览器 → 维持会话（常驻）。

```bash
DEEPSEEK_API_KEY=sk-xxx ASTUDIO_API_KEY=sk-xxx \
  npx tsx src/cli/bin.ts connect <别名> --cwd //home/user
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

1. **引导** — 在远端安装 Node 和 dsh（已装则跳过）。
2. **启动远端 dsh** — 以 detach 模式启动 dsh，使用每会话独立的 `DSH_HOME` 和环境变量。
3. **建正向隧道** — 将远端 dsh webserver 端口转发到本机端口，使浏览器可访问。
4. **凭据接线** — 启动反向隧道代理，向远端环境注入占位令牌，镜像本机 `settings.yaml`（供应商 baseURL 重定向进隧道）。
5. **打开浏览器** — 用会话 URL（含访问令牌）启动默认浏览器。
6. **保持运行** — 进程阻塞，维持隧道和代理。心跳每 5 秒执行一次。

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
npx tsx src/cli/bin.ts status
```

陈旧条目（维持会话的本机 CLI 已退出）会自动清理。

**输出：** 表格显示主机别名、远端目录、本机访问 URL、远端端口、远端 pid 和启动时间。

**注意：** 访问 URL 需要令牌。请使用 `connect` 输出的完整 URL（含 `?token=...`）；`status` 只显示不含令牌的基础 URL。

---

## kill — 停止远端 dsh

停止远端 dsh 进程。当远端进程状态异常（配置改了没生效、端口被占、进程卡死）时使用。

```bash
# 停止指定会话
npx tsx src/cli/bin.ts kill <别名> --cwd //home/user

# 停止该主机上的全部会话（含孤儿进程）
npx tsx src/cli/bin.ts kill <别名> --all
```

**参数：**

| 参数 | 说明 |
|---|---|
| `--cwd <路径>` | 指定要停止的会话（与 `--all` 互斥） |
| `--all` | 停止该主机上的全部会话（含孤儿） |
| `--ssh-config <路径>` | 使用指定的 ssh config 文件 |
| `--private-key <路径>` | 私钥路径，优先于 config 的 IdentityFile（见[认证与主机指定](#认证与主机指定)） |
| `--password <密码>` | 明文密码认证（有泄露风险，见[认证与主机指定](#认证与主机指定)） |

**安全机制：** 进程定位用 pid 文件或监听端口——**绝不用 `pkill -f`**，那会杀掉执行命令自身的 SSH 会话。

安装目录与会话 profile 在 kill 后保留。用 `connect` 可再次启动。

---

## clean — 清理陈旧远端资源

删除远端的陈旧会话目录、旧版 Node 和旧版 dsh。这是版本入名 + 每会话目录策略的必要配套——两者都会累积。

```bash
# 默认各保留最新 1 个版本
npx tsx src/cli/bin.ts clean <别名>

# 每个类别保留 2 个版本
npx tsx src/cli/bin.ts clean <别名> --keep 2
```

**参数：**

| 参数 | 说明 |
|---|---|
| `--keep <数量>` | 每个类别保留的最新版本数（默认 1） |
| `--ssh-config <路径>` | 使用指定的 ssh config 文件 |
| `--private-key <路径>` | 私钥路径，优先于 config 的 IdentityFile（见[认证与主机指定](#认证与主机指定)） |
| `--password <密码>` | 明文密码认证（有泄露风险，见[认证与主机指定](#认证与主机指定)） |

**保护机制：** 活会话的 runner 脚本（`.runtime/start.sh`）记录着正在使用的 dsh 与 Node 路径。删除前先收集所有活会话引用的路径；被引用的版本即使旧于保留线也不删——删掉正在运行的安装，进程下次重启就找不到了。

**清理内容：**

- **陈旧会话目录** — pid 文件指向的进程已不在的会话。
- **旧版 dsh** — 保留最新 N 个，其余删除（受保护的除外）。
- **旧版 Node** — 同上。

**输出：** 报告释放的空间、删除的会话/版本以及受保护跳过的版本。

---

## help — 显示帮助

```bash
npx tsx src/cli/bin.ts help
# 或
npx tsx src/cli/bin.ts --help
# 或
npx tsx src/cli/bin.ts -h
```

版本号：

```bash
npx tsx src/cli/bin.ts --version
# 或
npx tsx src/cli/bin.ts -V
```

---

## 常见工作流

### 首次设置

```bash
# 1. 安装依赖
npm install

# 2. 列出可用主机
npx tsx src/cli/bin.ts list

# 3. 诊断目标主机
npx tsx src/cli/bin.ts doctor my-server

# 4. 引导（可选——connect 会自动做）
npx tsx src/cli/bin.ts provision my-server --cwd //home/user

# 5. 连接
DEEPSEEK_API_KEY=sk-xxx npx tsx src/cli/bin.ts connect my-server --cwd //home/user
```

### 密码登录（未配置私钥的主机）

```bash
# 直连语法 + 交互式输密码（不回显，输错可重试，最多 3 次）
npx tsx src/cli/bin.ts doctor user@192.168.0.10

# connect 时同理；密码只存本进程内存，重连时静默复用
DEEPSEEK_API_KEY=sk-xxx npx tsx src/cli/bin.ts connect user@192.168.0.10 --cwd //home/user

# 临时脚本场景可用明文（有泄露风险，CLI 会警告）
DEEPSEEK_API_KEY=sk-xxx npx tsx src/cli/bin.ts connect user@192.168.0.10 --cwd //home/user --password 'xxx'

# 显式指定私钥（优先于 config 的 IdentityFile）
npx tsx src/cli/bin.ts connect my-server --cwd //home/user --private-key ~/.ssh/id_ed25519
```

### 重连到已有会话

```bash
# 如果上次断开时用了 --keep-remote（或会话从故障中存活）
DEEPSEEK_API_KEY=sk-xxx npx tsx src/cli/bin.ts connect my-server --cwd //home/user
```

工具会探到正在运行的远端 dsh 并复用。你获得一个新的本机隧道端口。

### 完整清理

```bash
# 停止远端 dsh
npx tsx src/cli/bin.ts kill my-server --all

# 清理旧版本和死会话
npx tsx src/cli/bin.ts clean my-server

# 远端完整卸载（在远端主机上执行）
rm -rf ~/.dsh-remote
```

### 强制重启卡住的会话

```bash
DEEPSEEK_API_KEY=sk-xxx npx tsx src/cli/bin.ts connect my-server --cwd //home/user --force-restart
```

### 不自动打开浏览器

```bash
DEEPSEEK_API_KEY=sk-xxx npx tsx src/cli/bin.ts connect my-server --cwd //home/user --no-open
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

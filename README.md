# dsh-remote

远程开发启动器：把 dsh 装到远程主机上运行，本机只留浏览器。LLM 凭据不离开本机。

参照 VS Code Remote-SSH、Zed、JetBrains Gateway 的做法——**代码与会话都在远端，本机只做呈现**。
完整架构依据、调研来源与实测数据见 [PLAN.md](PLAN.md)。

## 与旧版的区别

0.3.x 是 Cordis 插件：dsh 跑在本机，用 helper RPC 把文件系统操作逐个转到远端。
这条路线要为 dsh 每个碰文件系统的功能补一个 shim，且远端原生模块只能用 no-op 桩替换
（landlock 沙箱与 flock 因此失效）。

0.4.0 起改为独立 CLI：远端装完整 dsh，本机不跑 dsh。约 2000 行 shim 随之删除，
远端拿到真实的预编译原生模块。

## 当前状态

按 [PLAN.md](PLAN.md) 的里程碑推进中。

| 阶段 | 内容 | 状态 |
|---|---|---|
| P0 | 可行性验证（手动全流程） | ✅ 五步通过 |
| P1 | 连接闭环：传输层、主机解析、探测、镜像测速 | ✅ `list` / `doctor` 可用 |
| P2 | 引导闭环：装 Node 与 dsh、生成会话 profile | ✅ `provision` 可用 |
| P3 | 会话闭环：隧道、心跳重连、多主机并行 | 未开始 |
| P4 | 凭据闭环：反向隧道代理 | 未开始 |
| P5 | `dsh-remote-guard` 远端插件与打磨 | 未开始 |

## 安装与使用

无构建步骤——源码以 `.ts` 形式经 tsx 直接运行。

```bash
npm install

# 列出 ~/.ssh/config 中的主机
npx tsx src/cli/bin.ts list

# 诊断某台主机的引导条件
npx tsx src/cli/bin.ts doctor OrangePI
npx tsx src/cli/bin.ts doctor OrangePI --refresh-mirrors   # 强制重测镜像

# 把远端环境装到可用状态（幂等，重复执行会复用已装版本）
npx tsx src/cli/bin.ts provision OrangePI --cwd /home/xlli67

# 通用参数：改用其他 ssh config 文件
npx tsx src/cli/bin.ts list --ssh-config /path/to/config
```

`doctor` 会检查连接、平台、基础命令、磁盘余量、已装运行时、**Node 运行时稳定性**
与各镜像实测延迟。它是排查远程环境问题的首选手段——远程开发的故障大多出在环境而非代码。

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
| [src/util/](src/util/) | shell 转义、错误类型 |
| [src/hosts/ssh-config-parser.ts](src/hosts/ssh-config-parser.ts) | 主机配置的**唯一**来源：解析 ssh config，递归解析 ProxyJump |
| [src/transport/types.ts](src/transport/types.ts) | 传输抽象接口（按多传输设计，日后可加 Docker / WSL） |
| [src/transport/ssh-transport.ts](src/transport/ssh-transport.ts) | ssh2 实现：跳板机链、命令执行、SFTP、正反向转发 |
| [src/transport/channel-pool.ts](src/transport/channel-pool.ts) | SSH 通道配额，避免超 `MaxSessions` |
| [src/provision/probe.ts](src/provision/probe.ts) | 远端探测 + **Node 稳定性自检** |
| [src/provision/mirror-selector.ts](src/provision/mirror-selector.ts) | 在远端实测镜像延迟并自适应选取 |
| [src/provision/remote-paths.ts](src/provision/remote-paths.ts) | 远端路径规则的唯一真源 |
| [src/provision/node-installer.ts](src/provision/node-installer.ts) | 装 Node，版本隔离，装完自检 |
| [src/provision/dsh-installer.ts](src/provision/dsh-installer.ts) | 装 dsh，版本显式指定不依赖 dist-tag |
| [src/provision/profile-writer.ts](src/provision/profile-writer.ts) | 每会话独立 `DSH_HOME` 与 profile、patch 生成 |
| [src/provision/provisioner.ts](src/provision/provisioner.ts) | 引导流程编排，各步均幂等 |
| [src/util/session-id.ts](src/util/session-id.ts) | 由主机别名 + 远端目录算确定性会话 id |
| [src/cli/](src/cli/) | 命令分派与终端输出 |

## 几件容易踩的事

这些都是实测踩出来的，改代码时别踩回去（详见 [PLAN.md](PLAN.md) 第十一章）：

- **远端 Node 必须用 v24 系。** v22.23.2 在 aarch64 上起进程崩溃率 35%，
  表现为 V8 报 OOM 但机器内存充足。`npm install` 要起几十次 node，必然失败，
  且报错会误导到最后一个失败的包。`probe.ts` 因此强制做稳定性自检。
- **镜像测速必须带 `-L` 并校验响应内容。** 阿里源对 `index.json` 返回 302，
  只测时间会把重定向页当成成功，并选出错误的"最快"镜像。
- **远端命令统一经 `sh -c` 包裹。** ssh exec 用的是用户登录 shell；zsh 遇到
  未匹配的 glob 会直接报错中止，bash 则保留字面量。不锁定 POSIX 语义，
  同一段脚本在不同用户机器上行为不同。
- **要在 PATH 前面加目录，用 `exec` 的 `pathPrefix` 选项，不要走 `env`。**
  `env: { PATH: '<新>:$PATH' }` 里的 `$PATH` 会被 `quote()` 转成字面量，
  远端 PATH 只剩一个目录，连 `rm`、`mkdir` 都找不到。
- **拼远端脚本时多行用 `\n` 连接，不能用空格。**
  `head=$(...) if [ ... ]` 是语法错误，整段在解析期就失败，
  表现为所有探测"无输出"——很容易误判成网络问题。
- **停远端进程不能用 `pkill -f <模式>`。** 承载命令的 shell 其命令行也含该模式，
  会把自己的 SSH 会话一起杀掉。用 pid 文件或按监听端口定位。
- **构造远端路径一律用 `/` 拼字符串**，不要用 `node:path` 的 `join`——
  本机可能是 Windows，会产出反斜杠。

## 开发

```bash
# 类型检查（本地 tsc 不可用，原因见 CLAUDE.md）
npx -y -p typescript@5.7.3 tsc --noEmit
```

代码规范见 [docs/type_script_style.md](docs/type_script_style.md)，写任何代码前先读。
交流、注释、提交信息一律用中文。

## 验证环境

OrangePI（aarch64 Linux, 192.168.1.82, Ubuntu glibc 2.35, 内核 5.10.0+），客户端 Windows 11。

P0 实测：装 Node v24.11.1 + dsh 0.1.6-alpha.2 约 75 秒 / 700M；
`ssh -L` 隧道取到完整 GUI 页面；`ssh -R` 凭据回打通，远端环境无任何 API key。

一个已知的环境限制：该主机内核未启用 landlock（LSM 列表为 `capability,yama,kbox_capability`），
所以 `node-addon-system` 的 `probe()` 返回 `unusable`。这取决于远端内核配置，与架构无关；
`flock` 在同一台机器上可用。

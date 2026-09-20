# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 语言要求

本仓库的所有交流、代码注释、提交信息、文档一律使用**中文**。代码规范见 [docs/type_script_style.md](docs/type_script_style.md)，写任何代码前先读它。

## 这是什么

`@deepseek-ai/dsh-remote` 是一个**独立 CLI**（不是 Cordis 插件）：把 dsh 装到远程主机上运行，本机只留浏览器，LLM 凭据不离开本机。

参照 VS Code Remote-SSH / Zed / JetBrains Gateway 的做法——代码与会话都在远端，本机只做呈现。完整架构依据、调研来源、实测数据见 [PLAN.md](PLAN.md)。

**没有构建步骤。** `tsconfig.json` 是 `noEmit: true` + `allowImportingTsExtensions: true`，源码以 `.ts` 形式经 tsx 直接运行。不要添加打包产物或 `outDir` 流程。

### 重要：0.4.0 是架构重写

0.3.x 是 Cordis 插件形态（dsh 跑本机 + helper RPC 把文件操作转到远端）。那套代码**已全部删除**：helper RPC、TLS-PSK 流、依赖收集器、native stub、三个 workspace shim、注入式 Web 面板、WebSocket 桥接。

如果你在 git 历史或旧文档里看到 `Ssh2Connection`、`RemoteHostController`、`RemoteWorkspaceAdapter`、`installRemoteDirectoryPicker`、`collectHelperDependencies`、`cordis.patch.yml`——那些都是旧架构，不要参考，不要恢复。

## 常用命令

```bash
# 类型检查（见下方"已知问题"，本地 tsc 跑不起来，用这条替代）
npx -y -p typescript@5.7.3 tsc --noEmit

# 列出 ~/.ssh/config 中的主机（纯本地，不连接）
npx tsx src/cli/bin.ts list

# 诊断某台主机的引导条件（P1 唯一的端到端验证手段）
npx tsx src/cli/bin.ts doctor OrangePI
npx tsx src/cli/bin.ts doctor OrangePI --refresh-mirrors
```

**改动传输层或引导逻辑后，必须跑一次真实 `doctor`**。类型检查通过不等于连得上——远端 shell 差异、脚本拼接错误这类问题只有实跑才暴露。

测试主机：别名 `OrangePI`（aarch64 Linux, 192.168.1.82），从 `~/.ssh/config` 解析。

## 架构

五层，依赖严格单向向下，下层不得 import 上层：

```
入口层      cli/          命令分派、参数解析、终端输出
编排层      session/      会话生命周期、心跳、重连、多会话簿记        [P3]
能力层      provision/    装 Node 与 dsh、镜像测速、生成会话 profile
            tunnel/       正反向端口转发                             [P3]
            credential/   LLM 凭据代理                               [P4]
传输层      transport/    ssh2 连接、命令执行、SFTP、转发、通道配额
基础层      hosts/        ssh config 解析（主机配置唯一来源）
            util/         shell 转义、错误类型
```

另有第二个交付物 `dsh-remote-guard`——装在**远端**的 Cordis 插件，只负责补一个免认证探活端点（P5）。

## 必须知道的几件事

**1. 主机配置来自 `~/.ssh/config`，不做持久化。** `listHosts()` / `resolveHost(alias)` 用 `ssh-config` 库的 `compute()` 合并 `Host *` 默认值并递归解析 `ProxyJump` 跳板机链。解析结果带模块级缓存，改了 config 文件必须调 `refreshConfig()`。认证只支持私钥（`IdentityFile`），不接受明文密码。

**2. 远端安装按版本入名，多版本并存，不做 hash 校验。** 路径形如 `~/.dsh-remote/versions/dsh-<版本>/`、`~/.dsh-remote/node/<版本>/`，存在性检查是直接执行 `<bin> --version` 成功即复用（Zed 的做法，完整性由 npm 自己兜底）。这是为了避免升级时原地覆盖——那正是"运行中的进程占着文件，写入报 Text file busy"的根因。

**3. 安装共享、会话状态隔离。** dsh 装在 `versions/` 下所有会话共享；每个会话有独立的 `DSH_HOME=~/.dsh-remote/sessions/<会话 id>/`。这条成立是因为 dsh 的模块解析是双锚的（bundle 名先从 dsh 安装位置解析、再从 profile 目录解析），所以"装在哪"与"`DSH_HOME` 指向哪"解耦。`DSH_HOME` 只能走 `env` 前缀传，它是 bootstrap-only，任何 `.env` 都改不了它。

**4. 所有远端路径由 [src/provision/remote-paths.ts](src/provision/remote-paths.ts) 统一提供**，任何模块不得自己拼。构造远端路径一律用 `/` 拼字符串，**不要用 `node:path` 的 `join`**——本机可能是 Windows，会产出反斜杠。

**5. 远端命令统一经 `sh -c` 包裹。** `SshTransport.exec()` 已做这件事。ssh exec 用的是用户登录 shell，而各 shell 行为有实质差异：zsh 遇到未匹配的 glob 会直接报 `no matches found` 并中止，bash 则保留字面量。写远端脚本时还要注意**多行命令用 `\n` 连接，不能用空格**——`head=$(...) if [ ... ]` 是语法错误，整段脚本在解析期就失败，表现为所有探测"无输出"。

**6. 拼进远端命令的任何动态值必须过 [src/util/shell-quote.ts](src/util/shell-quote.ts) 的 `quote()`。** 不要用模板字符串直接插值，那等于命令注入。注意 `quote('$HOME/x')` 会阻止 shell 展开 `$HOME`——需要展开时写 `"$HOME"/${quote(名字)}`。

**7. 远端 dsh 已内置令牌认证。** 启动输出形如 `dsh web: http://127.0.0.1:<端口>/?token=<43 字符>`，无令牌访问返回 401，令牌换 `HttpOnly` + `SameSite=Strict` cookie。**令牌不落盘**，只在启动输出首行——所以启动日志文件既是诊断来源也是令牌唯一来源，不能丢。

**8. 停远端进程不能用 `pkill -f <模式>`。** 承载命令的 shell 其命令行也含该模式，会把自己的 SSH 会话一起杀掉（实测踩过）。用会话目录下的 pid 文件，或按监听端口定位。

**9. 远端 Node 必须用 v24 系，且装完要做稳定性自检。** v22.23.2 在 aarch64 上起进程崩溃率 35%（V8 初始化 isolate 随机失败，报 OOM 但内存充足）。`npm install` 要起几十次 node，必然失败，且报错会误导到最后一个失败的包。[src/provision/probe.ts](src/provision/probe.ts) 的 `checkNodeStability()` 强制自检，容错次数为 0。

**10. 镜像测速在远端执行，必须带 `-L` 并校验响应内容。** 测的是远端到镜像的连通性，本机测没意义。阿里源对 `index.json` 返回 302，只测时间会把重定向页当成成功并选出错误的"最快"镜像。腾讯与华为镜像已从候选移除（DNS 解析失败）。

## 已知问题

- **`npm run typecheck` 跑不起来。** `node_modules` 里的 typescript 版本缺 win32 平台包。用 `npx -y -p typescript@5.7.3 tsc --noEmit` 替代。
- **远端主机 OrangePI 的内核未启用 landlock**（LSM 列表 `capability,yama,kbox_capability`），`node-addon-system` 的 `probe()` 返回 `unusable`。这是该主机的内核配置问题，与本项目架构无关；`flock` 在同一台机器上可用。
- 远端遗留一个陈旧的 18903 反向端口监听（P0 测试残留，已不可连接，随 sshd 回收）。

## 约束

- 远端只支持 POSIX（Linux/macOS）；客户端支持 Windows/Linux/macOS，所以**不要引入依赖系统 `ssh` 命令的实现**——用纯 JS 的 ssh2 就是为了这个。代价是 ControlMaster 那类现成便利拿不到，通道配额要自己管（[src/transport/channel-pool.ts](src/transport/channel-pool.ts)）。
- 认证只用私钥文件路径引用，不在代码或配置里落明文密钥。日志与错误消息不打印密钥、令牌、口令内容。
- 远端 webserver **必须**绑 `127.0.0.1`，反向转发的远端监听地址也必须是 `127.0.0.1`。dsh webserver 的 `host` 只接受 `127.0.0.1` 与 `0.0.0.0`，且其自身不携带 TLS——绑 `0.0.0.0` 等于把 GUI 挂到网上。
- 本机 CLI 必须活满整个会话：反向隧道代理持有 LLM key，CLI 退出则远端模型调用全部失败。这是凭据方案的既定代价，不是缺陷。
- 对远端资源的批量操作默认**串行**；要并发必须确认通道配额能承受。
- 新增运行时依赖必须写进 `package.json`，版本锁定或用窄范围。

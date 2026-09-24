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

**本机开发默认 pnpm 11.7.0**（与 dsh 官方仓库对齐，`package.json` 的 `packageManager` 钉版本）：装依赖用 `pnpm install`（会顺带跑 `prepare` 构建插件产物），跑本地二进制用 `pnpm exec`。不要用 npm——dsh 各包的 peer 钉死具体版本，npm 在残留旧树上做增量解析必报 ERESOLVE。pnpm 11 的三个坑已处理进 [pnpm-workspace.yaml](pnpm-workspace.yaml)：包管理器设置迁到了这里（package.json 的 `pnpm` 字段已废弃）；构建脚本改用 `allowBuilds` 映射逐包放行（ssh2/cpu-features 的原生加密绑定、esbuild 平台二进制校验）；`minimumReleaseAge` 默认 24h 会拦截当天发布的 dsh RC，故显式置 0。放行构建脚本后机器上会出现 `sshcrypto.node`——两个打包脚本（build-plugin/package）的 esbuild 调用都加了 `.node: empty` loader（单文件 bundle 带不走原生件，empty 让 ssh2 的 try/catch 回落纯 JS；没这个 loader 时打包直接报「No loader is configured for .node files」）。**远端分工不变**：dsh 本体 npm、插件 store pnpm 10 系——与官方 dsh 语义一致（官方对已发布包的消费入口是 `npx @deepseek-ai/dsh`，运行期插件/profile 管理才走 pnpm；远端 pin 10 系是因为 11 系对未决策的 allowBuilds 致命报错而远端无人交互），不要把远端 dsh 本体改成 pnpm 安装。

```bash
# 类型检查
pnpm run typecheck

# 列出 ~/.ssh/config 中的主机（纯本地，不连接）
pnpm exec tsx src/cli/bin.ts list

# 诊断某台主机的引导条件（排查远端问题的首选手段）
pnpm exec tsx src/cli/bin.ts doctor myhost
pnpm exec tsx src/cli/bin.ts doctor myhost --refresh-mirrors

# 引导远端环境（幂等；改动 provision/ 后用它验证）
pnpm exec tsx src/cli/bin.ts provision myhost --cwd //home/youruser
# 验证全新安装路径（复用路径会跳过下载与 npm install，测不到真正易错的代码）
pnpm exec tsx src/cli/bin.ts provision myhost --node-version v24.20.0

# 完整会话（常驻进程；改动 session/、tunnel/ 或 credential/ 后用它验证）
# Ctrl-C 默认连远端 dsh 一起停；--keep-remote 保留远端进程。行为验证脚本：
# pnpm exec tsx tests/stop-remote-on-close.ts myhost（Windows 收不到合成 SIGINT，
# 脚本直接走 Ctrl-C 处理器的同一条 close 路径）
DEEPSEEK_API_KEY=sk-xxx pnpm exec tsx src/cli/bin.ts connect myhost --cwd //home/youruser --local-port 18950 --no-open
pnpm exec tsx src/cli/bin.ts status
pnpm exec tsx src/cli/bin.ts kill myhost --all
# kill 不带 --cwd 时按默认目录算会话 id——停不到用非默认 --cwd 启动的会话
# （实测踩过：connect 用了 --cwd //home/xxx，kill 忘带同值只报「没有正在运行
# 的远端 dsh」）。要停非默认 cwd 的会话必须带相同的 --cwd，或用 --all
# （按 owner 指纹 scope 扫远端全部会话目录）。

# 清理远端陈旧资源（改动 clean.ts 后用它验证）
pnpm exec tsx src/cli/bin.ts clean myhost

# 分发包打包（esbuild 单文件 + 目标平台 Node 二进制，产物在 dist/，gitignored）
# 开发流程仍无构建——本命令只服务分发。--all 打五平台矩阵；默认打当前平台
pnpm exec tsx scripts/package.ts --all

# dsh 插件形态（改动 src/plugin/、src/plugin-client/ 后必须跑）
pnpm exec tsx scripts/build-plugin.ts        # esbuild 双入口 → lib/index.js + lib/client.js
pnpm exec tsx scripts/check-plugin.ts        # 护栏：命令名/工具名/schema/路由前缀/版本一致
pnpm exec tsx scripts/dev-plugin.ts --smoke  # 隔离 DSH_HOME 沙箱：安装→启动→探针（ping 401）
pnpm exec tsx scripts/dev-plugin.ts          # 常驻沙箱，打印带令牌的 URL 供浏览器联调
pnpm exec tsx scripts/dev-plugin.ts --sync   # 产物同步进沙箱（宿主半重启生效，浏览器半刷新生效）
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

## 经验教训与硬约束

完整的经验教训列表见 [docs/lessons.md](docs/lessons.md)，改相关代码前必读。以下是最高频踩坑的精简提醒：

- **远端路径**：统一由 `src/provision/remote-paths.ts` 提供，用 `/` 拼接，不用 `node:path.join`
- **远端命令**：动态值必须过 `quote()`；PATH 前缀用 `pathPrefix` 选项，不走 `env`
- **停进程**：不能用 `pkill -f`，用 pid 文件或端口定位
- **socket error**：必须在 destroy 之前挂 error 监听器，否则进程崩溃
- **凭据**：远端 key 变量是代理令牌不是真实 key；令牌只在启动日志首行
- **插件形态**：宿主产物必须 ESM；命令名匹配 `/^[a-z][a-z0-9_-]*$/`；defineTool 的 object 节点必须写 `additionalProperties`；路由只走已鉴权通道
- **WSL**：detach 用 PowerShell `Start-Process -WindowStyle Hidden`，不能用 `setsid nohup &`；localhost forwarding 默认开启，openChannel 用 127.0.0.1 即可

## 已知问题

- **部分远端主机的内核未启用 landlock**（实测某台 aarch64 测试机的 LSM 列表不含 landlock），`node-addon-system` 的 `probe()` 会返回 `unusable`。这是主机内核配置问题，与本项目架构无关；`flock` 在同一台机器上可用。

## 约束

- 远端只支持 POSIX（Linux/macOS）；客户端支持 Windows/Linux/macOS，所以**不要引入依赖系统 `ssh` 命令的实现**——用纯 JS 的 ssh2 就是为了这个。代价是 ControlMaster 那类现成便利拿不到，通道配额要自己管（[src/transport/channel-pool.ts](src/transport/channel-pool.ts)）。
- 认证优先私钥文件路径引用，不在代码或配置里落明文密钥。日志与错误消息不打印密钥、令牌、口令内容。交互式输入的 SSH 密码与 `--password` 传入的密码**只存本进程内存**（会话/命令结束丢弃引用；JS 字符串无法清零是已知限制）；`--password` 是用户显式选择，CLI 以警告提示命令行/进程列表/shell 历史的泄露风险，但绝不把密码写进任何日志或错误消息。
- 远端 webserver **必须**绑 `127.0.0.1`，反向转发的远端监听地址也必须是 `127.0.0.1`。dsh webserver 的 `host` 只接受 `127.0.0.1` 与 `0.0.0.0`，且其自身不携带 TLS——绑 `0.0.0.0` 等于把 GUI 挂到网上。
- 本机 CLI 必须活满整个会话：反向隧道代理持有 LLM key，CLI 退出则远端模型调用全部失败。这是凭据方案的既定代价，不是缺陷。
- 对远端资源的批量操作默认**串行**；要并发必须确认通道配额能承受。
- 新增运行时依赖必须写进 `package.json`，版本锁定或用窄范围。
- **凡是接受远端 POSIX 路径的参数都要校验。** Git Bash（MSYS）会在参数到达程序前把 `/home/x` 改写成 `D:/SoftWare/Git/home/x`。这发生在 shell 层，程序无法阻止，只能识别并拒绝。放过它不只是路径错——远端目录参与会话 id 计算，同一逻辑会话会因调用方式不同得到不同 id，复用与 kill 都会失灵。校验逻辑在 [src/cli/main.ts](src/cli/main.ts) 的 `validateRemoteCwd`。

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
| P3 | 会话闭环：隧道、心跳重连、多主机并行 | ✅ `connect` / `status` / `kill` 可用 |
| P4 | 凭据闭环：反向隧道代理 | ✅ key 全程不出本机（已实测链路） |
| P5 | 打磨：三层心跳探活、`clean` 命令 | ✅ 完成（guard 由更轻机制替代，见 PLAN P5） |

## 安装与使用

无构建步骤——源码以 `.ts` 形式经 tsx 直接运行。

```bash
npm install

# 列出 ~/.ssh/config 中的主机
npx tsx src/cli/bin.ts list

# 诊断某台主机的引导条件
npx tsx src/cli/bin.ts doctor OrangePI
npx tsx src/cli/bin.ts doctor OrangePI --refresh-mirrors   # 强制重测镜像

# 主命令：引导 → 起远端 dsh → 建隧道 → 开浏览器（进程常驻）
# 用哪个供应商就把哪个 key 放进本机环境（供应商清单来自 ~/.dsh/settings.yaml）
DEEPSEEK_API_KEY=sk-xxx ASTUDIO_API_KEY=sk-xxx npx tsx src/cli/bin.ts connect OrangePI --cwd //home/xlli67

# 查看本机维持的所有会话
npx tsx src/cli/bin.ts status

# 停止远端 dsh
npx tsx src/cli/bin.ts kill OrangePI --all

# 清理远端陈旧资源（旧版本、死会话目录；运行中会话使用的版本受保护）
npx tsx src/cli/bin.ts clean OrangePI
npx tsx src/cli/bin.ts clean OrangePI --keep 2   # 每个类别保留 2 个版本

# 只做引导，不起服务（幂等，重复执行会复用已装版本）
npx tsx src/cli/bin.ts provision OrangePI --cwd //home/xlli67

# 通用参数：改用其他 ssh config 文件
npx tsx src/cli/bin.ts list --ssh-config /path/to/config
```

`connect` 之后本进程必须保持运行——正向隧道的本机监听器与 LLM 代理都活在其中。
远端 dsh 是 detach 的，CLI 退出后仍在跑，下次 `connect` 会探到并复用；要真正停掉用 `kill`。

## 凭据如何工作

模型调用不经公网直连，而是走反向隧道。**多供应商**：代理按路径前缀路由——
DeepSeek 原生通道用 `/anthropic`，`~/.dsh/settings.yaml` 里 `llm-pi-ai.providers`
段配置的供应商（如 AStudio、qwen、iflytek）各自走 `/r/<供应商名>`，
路由自动提取，无需手动配置：

```
远端 dsh ──(占位令牌)──▶ 远端 127.0.0.1:<反向端口>/r/<供应商> ──SSH 反向通道──▶ 本机代理
                                                                    ├─ /anthropic → api.deepseek.com
                                                                    └─ /r/astudio → maas-api.cn-huabei-1.xf-yun.com
                                                                       （按路由注入对应真实 key）
```

- 各供应商的真实 key（`DEEPSEEK_API_KEY`、`ASTUDIO_API_KEY` 等）**只存在于本机
  进程**，不落远端磁盘、不进远端环境。远端进程环境里放的是代理令牌（随机值）。
- 本机 `~/.dsh/settings.yaml` 会**整体镜像**到会话的 `DSH_HOME/settings.yaml`
  （`agent-default-model` 等键随之镜像，远端默认模型与本机一致），仅供应商的
  `baseURL` 重定向进隧道。**只镜像 settings（凭据引用，无密钥），
  绝不镜像 `.credentials.yaml`**（可能含真实密钥）。
- 缺哪个供应商的 key 只影响该供应商（502 带明确指引），其余照常。
- 代理令牌与反向端口随会话固定，落盘远端 `.runtime/`（令牌 600 权限），
  重连与复用读回同一组值。
- 同一会话的多个本机 CLI 共享凭据路径（反向端口先到先得，后来的视图自动让位）。
- 已知残余风险：远端同权限用户可借你的通道消耗额度（拿不到 key 本身）。多用户
  远端主机上请知悉，详见 [PLAN.md](PLAN.md) 4.5 节。

**在 Git Bash 里写远端路径要用双斜杠**（`--cwd //home/xxx`）或先设
`MSYS_NO_PATHCONV=1`。MSYS 会把 `/home/xxx` 改写成 `D:/SoftWare/Git/home/xxx`，
这发生在参数到达程序之前，程序只能识别并拒绝。

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
- **会话表主键是 `(sessionId, localPid)` 组合。** 会话 id 是远端身份；
  同别名同目录的多个本机 CLI 会共享同一个远端 dsh，是同一远端会话的多个本机视图。
  只按 sessionId 去重会让后启动的 CLI 挤掉先前记录，`status` 漏报仍在工作的隧道。
- **本机监听器必须跨重连存活。** 重连只换传输引用，本机端口不变——
  端口一变，用户已打开的浏览器标签全部失效。这也是传输接口提供
  `openChannel`（只开通道）而非 `forwardOut`（监听+转发一体）的原因。
- **本机 Node v24.14.0 的 fetch 拒绝一切流式请求体**（ReadableStream /
  异步生成器都抛 `expected non-null body source`，字符串与 Buffer 正常）。
  所以 LLM 代理的请求体是整体缓冲后转发的；流式要紧的响应侧（SSE）保持直传。
- **ssh2 的通道不能直接喂给 http.Server**（缺 `setTimeout` 等 Socket 接口）。
  代理在本机回环起真实 http.Server，通道与一条本机 TCP 连接对接。

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

# dsh 远程开发方案（重写版）

> 本方案取代 `deepseek-harness/plugin-plans/remote-dev/PLAN.md`，不沿用其任何假设。
> 架构依据来自对 Zed（直接读源码）、VS Code Remote-SSH、JetBrains Gateway、Coder（官方文档）的调研，
> 每处借用的机制都标注了来源，便于日后回查。

---

## 一、背景与转向理由

### 1.1 当前架构的结构性问题

现有实现（约 4900 行）把 dsh **留在本机**，通过 helper RPC 把文件系统、目录选择、工作区注册逐个替换成远端实现。dsh 自己的文档对这条路线有明确判断：

> 假定可访问主机文件系统的 Web 工作区界面需要单独集成；**仅替换提供方并不会使这些视图支持远端**。
> —— `deepseek-harness/docs/subsystems/ssh.zh.md`

"单独集成"在实践中表现为一条 shim 跑步机：dsh 每新增一个碰文件系统的功能，本仓库就要补一个 shim。现有的 `remote-workspace.ts`、`remote-workspace-bridge.ts`、`remote-directory-picker.ts`（原地改写 `ctx.directoryPicker.list`）、`webgui-integration.ts`（脚本内联注入主页面）都是这条跑步机上的产物。约 25 个类型错误、一个已完全失效的 `api/websocket-bridge.ts`，是这个结构性压力的症状。

附带的能力损失是硬的：`native-stub.ts` 把 `@deepseek-ai/node-addon-system` 替换成 no-op 桩，导致远端 **landlock 沙箱与 flock 全部失效**——这不是可以后补的细节，是安全能力的空洞。

### 1.2 转向后的形态

把 dsh 整体装到远端，本机只留一个瘦启动器 + 浏览器。三个成熟项目一致走这条路：

| 项目 | 远端装什么 | 本机剩什么 |
|---|---|---|
| Zed | `zed-remote-server` 二进制 | UI，protobuf RPC over SSH |
| VS Code | VS Code Server（独立于本地安装） | UI，随机 key 认证 + 隧道 |
| JetBrains | **完整 IntelliJ 平台 IDE**（无 UI 服务形态） | JetBrains Client 瘦客户端 |

dsh 已发布到 npm（`@deepseek-ai/dsh`，`publishConfig.access: public`），走 JetBrains 那种"装整个产品"的路线在分发上是通的。收益：

- 原生模块变真的——远端 `npm i` 会拉到 `@deepseek-ai/node-addon-system-linux-arm64` 的**真实预编译 `.node` 二进制**，不再是 no-op 桩
  （**P0 修正**：真实加载已验证，`flock` 可用；但 landlock 能否生效取决于**远端内核**是否启用该 LSM，与架构无关。
  验证机的 5.10.0+ 内核（aarch64）LSM 列表为 `capability,yama,kbox_capability`，`probe()` 返回 `unusable`。
  所以准确说法是"桩被消除、flock 可用、landlock 取决于内核"，而非"沙箱一定在工作"。详见第十二章）
- 每次 `stat` 不再是一次 SSH 往返，而是本地 syscall
- Windows 客户端不再是难题——本机只剩浏览器

---

## 二、已定决策

| # | 决策 | 选择 |
|---|---|---|
| 1 | 本机形态 | **薄启动器**（JetBrains Gateway 式）。本机不跑 dsh |
| 2 | LLM 凭据 | **反向隧道代理**。key 只留本机，远端 `baseURL` 指向隧道 |
| 3 | 远端安装来源 | **远端自装**。装前测软件源连通性，自适应选最快镜像 |
| 4 | 现有代码 | **绿地重写**，复用清单见第八章 |
| 5 | `dsh-remote-guard` | **要做**。P1 起预留接口边界，实现放 P5。**P0 后已重新界定职责**，见 4.6 |
| 6 | 远端 profile 管理 | 按成熟项目做：**共享版本化安装 + 每会话独立 `DSH_HOME`**。P0 已实测成立 |
| 7 | 首次安装耗时 | **可接受**，不为此转预构建 tarball。P0 实测：Node 7s + dsh 60s |
| 8 | 远端产物校验 | **版本入名，不做 hash 校验**（Zed 模式） |
| 9 | 多主机并行 | **要做**，设计见第六章 |
| 10 | 远端 Node 版本 | **锁定 v24 系**。P0 实测 v22 在 aarch64 上崩溃率 35%，见 11.2 |
| 11 | 远端落盘隔离 | **单根自治**（对标 VS Code `~/.vscode-server`）：一切落盘在 `~/.dsh-remote/`，从不写入远端 `~/.dsh` 与 `~/.npm` |

### 2.1 决策 1 与 2 的耦合（必须先接受）

反向隧道代理要求本机常驻一个持有 key 的 HTTP 代理进程。因此：

- **CLI 不是"开完浏览器就退出"的启动器，它必须活满整个会话。**
- **放弃"关掉客户端、远端会话继续跑"。** 本机 CLI 退出 ⇒ 反向隧道断 ⇒ 远端模型调用全部失败。
- 远端 dsh 进程本身可以留着复用（见 4.4），但它在本机 CLI 不在时无法调模型。

这是决策 2 的直接代价，不是实现缺陷。若日后要支持离线续跑，只能换成"远端专用 key"方案（Coder 口中的 BYOK 模式），届时凭据层的 `CredentialStrategy` 接口预留了扩展位（见 4.5）。

---

## 三、架构总览

```
本机 (Windows/Linux/macOS)                      远端 (Linux/macOS)
┌────────────────────────────────┐              ┌──────────────────────────────┐
│ 浏览器                          │              │ dsh（完整 npm 安装）          │
│ 127.0.0.1:<本地端口>            │              │ ┌──────────────────────────┐ │
└───────────────┬────────────────┘              │ │ webserver                │ │
                │ HTTP / WebSocket              │ │ 127.0.0.1:<远端端口>      │ │
                │ + 会话令牌                     │ │ + dsh-remote-guard 认证   │ │
┌───────────────▼────────────────┐              │ └──────────────────────────┘ │
│ dsh-remote CLI（常驻）          │  正向转发     │  ├ session / agent           │
│ ├ 传输层 (ssh2)  ══════════════╪══════════════▶│  ├ fs / subprocess           │
│ ├ 引导层（装 Node + dsh）        │              │  ├ terminal / lsp            │
│ ├ 隧道层                        │              │  └ sandbox（landlock 可用）   │
│ ├ 会话编排（心跳/重连）           │  反向转发     │                              │
│ └ LLM 代理  ◀══════════════════╪══════════════╪─ baseURL → 127.0.0.1:<反向>  │
│   ▲ DEEPSEEK_API_KEY 只在这里    │              │                              │
└───┼────────────────────────────┘              └──────────────────────────────┘
    │
真实 LLM API（本机直连出网）
```

数据路径：浏览器 → 本地转发端口 → SSH 通道 → 远端 dsh。会话内容不经本机 dsh 中转（本机没有 dsh）。
凭据路径：远端 dsh → 远端 `127.0.0.1:<反向端口>` → SSH 反向通道 → 本机 LLM 代理 → 注入 key → 真实 API。

---

## 四、模块设计

依赖方向严格单向向下，下层不得 import 上层：

```
入口层      cli/
编排层      session/
能力层      provision/   tunnel/   credential/
传输层      transport/
基础层      hosts/   util/
```

### 4.1 `transport/` 传输抽象层

**设计依据：** Zed 的 `crates/remote/src/remote_client.rs:1618` 定义 `trait RemoteConnection`，SSH / WSL / Docker 三个实现并列（`transport/ssh.rs`、`wsl.rs`、`docker.rs`）。首版只做 SSH，但接口按多传输设计，日后加 Docker / WSL 不动上层。

```
transport/
  types.ts            RemoteTransport 接口 + RemoteTarget 联合类型
  ssh-transport.ts    ssh2 实现（连接、exec、SFTP、正反向转发）
  channel-pool.ts     通道配额管理
```

`RemoteTransport` 最小接口：

| 方法 | 职责 |
|---|---|
| `connect()` / `dispose()` | 建立与释放底层连接 |
| `exec(cmd, opts)` | 执行远端命令，返回 stdout/stderr/exitCode |
| `uploadFile(local, remote)` | SFTP 单文件上传（回退路径用） |
| `forwardOut(localPort, remoteHost, remotePort)` | 正向转发 |
| `forwardIn(remotePort)` | 反向转发，返回连接事件流 |
| `platform` | 探测到的 os / arch / shell 类型 |

**`channel-pool.ts` 的必要性：** 本仓库现有代码已踩过这个坑——"上传全部走单个 SFTP 会话串行执行，并发会超 SSH 通道上限"。这次把配额管理提成独立模块，正向转发、反向转发、exec、SFTP 共用一个配额池，避免再次撞上限。多主机并行（决策 9）时每台主机一个独立传输实例，各自持有配额池。

**为什么继续用 ssh2 而不是系统 `ssh`：** Zed 全程用系统 `ssh` 并靠 `ControlMaster` 复用连接，代价在源码注释里写得很清楚——Windows 上 `ControlMaster` 不支持（`ssh.rs:236`），且传不了环境变量（`ssh.rs:2001`：`"Windows OpenSSH has an 8K character limit for command lines"`）。本仓库要支持 Windows 客户端，继续用 ssh2 是对的。代价是 ControlMaster 那类现成便利拿不到，得用 ssh2 的多通道自己实现等价能力（正是 `channel-pool.ts` 的职责）。

### 4.2 `provision/` 引导层

**远端路径按版本入名，多版本并存，不做 hash 校验（决策 8）。**

依据 Zed 源码 `transport/ssh.rs:844`：

```rust
let binary_name = format!("zed-remote-server-{}-{}{}",
    release_channel.dev_name(), version_str, ...);
```

存在性检查是**直接执行** `<binary> version` 成功即复用，全程无 hash 校验。VS Code 同样按 commit 分目录（`~/.vscode-server/bin/<commit>/`）。完整性由 npm 自己的校验兜底。

对本仓库的直接好处：现有固定路径 `~/.dsh/helper/` 要求升级时原地覆盖，这正是记忆里那条 **"运行中的 dsh 占着远端 helper，引导会报 Text file busy"** 的根因。版本入名从根上消掉这个故障类别，也是多会话并存（决策 9）的前提。

```
provision/
  provisioner.ts      引导总流程编排
  probe.ts            远端探测：os / arch / node 版本 / 已装 dsh 版本
  mirror-selector.ts  镜像连通性测速与自适应选取
  node-installer.ts   安装 Node
  dsh-installer.ts    安装 dsh（远端自装 + 本地打包回退）
  remote-paths.ts     路径规则（唯一真源）
  profile-writer.ts   生成每会话 DSH_HOME 与 profile
```

远端布局：

```
~/.dsh-remote/
  versions/
    dsh-0.1.6-alpha.2/            ← 共享安装，版本入名，多版本并存
      node_modules/.bin/dsh
  node/
    v22.19.0/bin/node             ← Node 也按版本隔离
  sessions/
    <会话 id>/                     ← 每会话独立 DSH_HOME（见 4.2.3）
      profiles/remote/
        package.json
        cordis.patch.yml
      .runtime/{port,pid,token}
  tmp/
    install-<pid>-<随机>/          ← 临时目录带 pid，避免并发撞车
  mirror-cache.json
```

临时目录带 pid 这条来自 Zed（`ssh.rs:879`：`format!("download-{}-{}", std::process::id(), ...)`）。

#### 4.2.1 `mirror-selector.ts` 镜像自适应选取

**关键设计：测速必须在远端执行，不是本机。** 测的是远端到镜像的连通性，本机测出来的结果无意义。

两类镜像分别测，互不相干（候选清单已按 P0 实测修正）：

| 用途 | 候选 |
|---|---|
| Node 发行版 | `nodejs.org/dist`、`npmmirror.com/mirrors/node`、`mirrors.tuna.tsinghua.edu.cn/nodejs-release`、`mirrors.ustc.edu.cn/node` |
| npm registry | `registry.npmjs.org`、`registry.npmmirror.com` |

**腾讯 `mirrors.cloud.tencent.com` 与华为 `repo.huaweicloud.com` 从候选中移除**——P0 实测两者 DNS 均解析失败（`Could not resolve host`）。保留它们只会在每次测速里白等超时。

流程：

1. 远端并发发轻量探测请求，对每个候选取最小延迟
2. 全部不可达 ⇒ 抛带诊断的错误（列出每个候选的失败原因），不静默回落
3. 结果写 `~/.dsh-remote/mirror-cache.json`，带 TTL 与远端主机指纹；命中缓存跳过测速
4. `dsh-remote doctor` 强制重测并打印全部延迟

**探测命令必须带 `-L` 并校验响应内容，这是 P0 抓到的真问题。** 第一次测速用的是 `curl -fsS -m 5 -o /dev/null -w '%{time_total}'`，得到阿里 0.25s、官方 1.27s，看起来阿里快 5 倍。但阿里镜像对 `index.json` 返回 **302 重定向**，而 `-fsS` 不跟随重定向——那 0.25s 测的是 nginx 的 302 页面，不是真实内容。加上 `-L` 并校验响应首字符是 `[`（JSON 数组）后，排名完全变了：

| 镜像 | 不带 `-L`（错误） | 带 `-L` 且校验内容（正确） |
|---|---|---|
| `mirrors.ustc.edu.cn/node` | 0.512s | **0.471s（最快）** |
| `npmmirror.com/mirrors/node` | 0.252s（302 页面） | 0.494s |
| `mirrors.tuna.tsinghua.edu.cn` | 0.564s | 0.543s |
| `nodejs.org/dist` | 1.273s | 1.140s |

所以实现上：`curl -fsSL` + 校验返回体是预期格式，两者都不能省。只测时间会把重定向页当成成功，并选出错误的"最快"镜像。

**记忆里"官方 Node 源被墙"那条已不再成立**——P0 实测官方源可达（1.14s），只是比镜像慢。这恰好证明自适应测速比硬编码选阿里更对：网络状况会变，硬编码会过时。探测超时仍要短（建议 3~5 秒），因为被墙的表现是卡住而非快速失败。

#### 4.2.2 `dsh-installer.ts`

决策 3 定的是**只做远端自装**。但 Zed 与 VS Code 都保留了本地上传回退，Zed 源码注释：

> `"Failed to download binary on server, attempting to download locally and then upload it the server"`

本方案按决策执行：主路径远端自装，**本地打包上传作为显式可选回退**（`--upload-fallback` 开关，默认关闭）。理由是接口上留好位置比日后补便宜，且完全离线的远端是真实存在的场景。不默认开启，符合决策 3。

装完立即验证：执行 `<路径>/dsh --version`，输出与期望版本匹配才算成功。对标 Zed 的 `binary_exists_on_server` 检查。P0 实测该命令正确输出 `0.1.6-alpha.2`。

**安装命令（P0 实测可用）：**

```sh
env PATH=<node bin>:$PATH npm install --registry=<测速选出的镜像> \
    --no-audit --no-fund @deepseek-ai/dsh@<版本>
```

**P0 实测数据**（验证机：aarch64，3 核，15G 内存）：

| 阶段 | 耗时 | 产物 |
|---|---|---|
| 镜像测速（4 个 Node 源 + 2 个 registry） | ~5s | — |
| 下载 Node v24 tarball（29M） | 2.9s | — |
| 解包 Node | 4.2s | 201M |
| `npm install @deepseek-ai/dsh` | **60s，490 个包** | 500M |
| 合计 | **约 75 秒** | **约 700M** |

比预估乐观得多（决策 7 担心的是"几分钟"）。占用 700M 磁盘需要在 `doctor` 里提示。

`npm` 必须在 `PATH` 含 node bin 的前提下调用，否则 `npm -v` 直接报 `env: 'node': No such file or directory`——npm 自身的 shebang 依赖它。

**发布通道注意**：`@deepseek-ai/dsh` 的 `dist-tags` 是 `latest: 0.1.5-rc.2`、`alpha: 0.1.6-alpha.2`。默认装 `latest` 会拿到比本地 monorepo 旧的版本，所以**版本号必须显式指定**，不能依赖 `latest`。

耗时可见化仍要做：分阶段进度（测速 / 装 Node / 装 dsh / 起服务），每阶段打印实测秒数。

#### 4.2.3 `profile-writer.ts` — 每会话 `DSH_HOME`

这是决策 6 的落点。三个源码级事实决定了做法：

1. `resolveDshHome()` 优先取环境变量 `DSH_HOME`，非空则用它，否则回落 `~/.dsh`
   （`packages/util/home-paths/src/index.ts:87-91`）
2. `DSH_HOME` **只能来自继承的进程环境**——源码注释明确写了它是 bootstrap-only，任何 `.env` 都无法改它
   （`packages/boot/app-boot/src/index.ts:136-143`）
3. profile 是 `$DSH_HOME/profiles/<名字>/` 下的 `package.json`（含 `dsh.profile.bundles`）+ `cordis.patch.yml`；
   patch 层序为 **bundle 层 → profile 自身 patch → 启动器层（`--patch`）**
   （`packages/boot/app-boot/src/profile.ts:50-53` 及文件头注释）

第 4 个事实让"共享安装 + 每会话 `DSH_HOME`"成立：模块解析是**双锚**的——bundle 名先从 dsh 安装位置解析，再从 profile 目录解析。也就是说 **dsh 装在哪与 `DSH_HOME` 指向哪是解耦的**。所以：

- **安装**：`~/.dsh-remote/versions/dsh-<版本>/`，所有会话共享，装一次
- **会话状态**：`DSH_HOME=~/.dsh-remote/sessions/<会话 id>/`，每会话独立

这同时对应了成熟项目的两层划分——Zed 是"共享版本化二进制 + `proxy --identifier <唯一标识>`"（`ssh.rs:465-548`），VS Code 是"共享 per-commit server + 独立数据目录"。

**P0 已实测成立。** 在 `DSH_HOME=<会话目录>` 下执行 `dsh --profile remote --from-default-profile web --dump-config`，profile 正确生成在会话目录内，而 dsh 本体仍在共享的 `versions/` 下：

```
sessions/<会话 id>/profiles/remote/
  cordis.yml           package.json
  cordis.patch.yml     pnpm-workspace.yaml
```

启动命令形态（P0 实测可用）：

```sh
env DSH_HOME=~/.dsh-remote/sessions/<会话 id> \
    <安装目录>/node_modules/.bin/dsh --profile remote \
    --host 127.0.0.1 --port <启动器分配> --no-open
```

三点实测要求：

- `DSH_HOME` 必须走 `env` 前缀传（事实 2），不能靠远端 shell 配置
- **`PATH` 必须含 node 的 bin 目录**。dsh 与 npm 的 shebang 是 `#!/usr/bin/env node`，不加 PATH 会直接 `env: 'node': No such file or directory`
- **host/port 用命令行参数，不写 patch**。见下

**P0 纠正一：host/port 不需要 patch。** web 应用自带 `--host` / `--port` / `--no-open` / `--trusted-host` 参数。webserver 的 bundle 层配置是 `host: !!js ctx.webStartup.host ?? '127.0.0.1'`、`port: !!js ctx.webStartup.port ?? 3080`，即**命令行 flag 经 `webStartup` 服务覆盖默认值**（`packages/boot/cmdline/src/index.ts:14` 注释明确写了"a flag beats the value written..."）。这比写 patch 简单且更稳。

**P0 纠正二：patch 条目必须用 `id`，不是 `name`。** 用 `name` 会被拒：

```
dsh: [<patch 路径>] patch: id is required for non-insert patches
```

所以 patch 模板应为（仅在确实需要改配置时才用，host/port 已由 flag 接管）：

```yaml
# 正确：用 id 定位已有条目
- id: llm-deepseek
  config:
    baseURL: 'http://127.0.0.1:<反向端口>'
```

`id` 取值要从 `--dump-config` 的输出里读（如 webserver 的 id 就是 `webserver`），不能猜。

首次创建 profile 用 `--from-default-profile web` 从内置模板初始化，再叠自己的 patch 层。

远端端口仍用显式值而非 `port: 0`：启动器需要提前知道端口才能建转发。P0 实测启动输出形如
`dsh web: http://127.0.0.1:18931/?token=<43 字符>`，**令牌必须从这行捕获**（见 4.6），所以无论如何都要解析首行输出——但端口仍不建议靠它反查，因为解析失败时端口错了比令牌错了更难诊断。

### 4.3 `tunnel/` 隧道层

```
tunnel/
  forward-local.ts    本机监听 → 远端 dsh（浏览器路径）
  forward-reverse.ts  远端监听 → 本机 LLM 代理（凭据路径）
  port-allocator.ts   两端端口分配与冲突处理
```

- 正向：本机起 `net.Server`，每个入站连接用 ssh2 `forwardOut` 开一条通道
- 反向：ssh2 `forwardIn(remoteAddr, remotePort)`，`'tcp connection'` 事件承载回打的连接

**远端端口分配有个固有竞态**：patch 必须在启动前写好，所以端口得提前定，但"探到空闲"与"实际绑定"之间存在窗口。做法是探测（远端 `ss -ltn` 或 bind 试探）→ 写 patch → 启动 → `/healthz` 验证，失败则换端口重试有限次。多会话并行（决策 9）会放大这个竞态，所以重试是必需的，不是可选优化。

安全约束（写死在代码里，不做成配置）：

- 远端 webserver **必须** `127.0.0.1`。dsh webserver 的 `host` 只接受 `127.0.0.1` 与 `0.0.0.0` 两个值，且其文档明说"服务器自身不携带 TLS、认证或来源策略"——绑 `0.0.0.0` 等于把无认证的 GUI 挂到网上。
- 反向转发的远端监听地址**必须** `127.0.0.1`。依赖 sshd 的 `GatewayPorts no` 默认值，同时在代码里显式传 `127.0.0.1` 双重保险。

### 4.4 `session/` 会话编排层

**自动重连，参数直接对标 Zed。** dsh-ssh README 那句"不提供重连"是**传输层**的边界；产品层补重连是三个项目的一致做法。Zed 源码 `remote_client.rs:160`：

```rust
const MAX_MISSED_HEARTBEATS: usize = 5;
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(5);
const HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(5);
pub const MAX_RECONNECT_ATTEMPTS: usize = 3;
```

现有 `remote-connection.ts` 默认重连 3 次，与 Zed 一致，这个选择是对的，直接沿用。其退避参数照搬（该文件已在 P1 删除，参数记录在此以免 P3 去翻 git 历史）：

```
enabled: true, maxAttempts: 3, initialDelayMs: 1000, backoffMultiplier: 2, maxDelayMs: 10_000
```

状态机同样借 Zed 的枚举（`remote_client.rs:175-205`），比现有 7 状态更能区分故障阶段：

```
Connecting → Connected → HeartbeatMissed(n) → Reconnecting
                              ↓                    ↓
                         (恢复) Connected    ReconnectFailed → ReconnectExhausted
```

```
session/
  session-manager.ts   单会话编排：引导 → 起远端 → 建隧道 → 开浏览器 → 守护
  session-registry.ts  多会话簿记（决策 9，见第六章）
  lifecycle-state.ts   状态机（纯函数状态转移，便于单测）
  heartbeat.ts         心跳
  reconnect.ts         指数退避重连
  remote-process.ts    远端 dsh 进程生命周期
```

**`remote-process.ts` 的存活判定借 Zed 的退出码语义。** Zed 的 `remote_server` 有专门的 `proxy` 子命令，其退出码被客户端用来判断 server 是否已死、要不要重新拉起——源码里有注释专门说明：

> `"The client reads the exit code to determine if the server process has died when trying to reconnect, signaling that it needs to try spawning a new server"`

dsh 没有等价的 `proxy` 子命令，所以本方案用组合判据：会话目录下的 pid 文件 + 探活。Zed 还用 `--reconnect` 标志区分"新起"与"重连已有"（`ssh.rs:499`），本方案等价做法是：探到既有会话且探活通 ⇒ 直接复用，跳过引导。

**P0 实测的三条硬约束：**

**1. 远端启动必须 detach，且必须捕获首行输出。** 实测用 `setsid nohup ... > <日志> 2>&1 < /dev/null &`，否则 SSH 通道关闭会带走进程。而令牌只在首行输出里（`dsh web: http://127.0.0.1:<端口>/?token=<43 字符>`），所以日志文件不能丢——它既是诊断来源也是令牌来源。

**2. 停进程绝不能用 `pkill -f <模式>`。** P0 清理时用了 `pkill -f "dsh --profile remote"`，结果**把执行该命令的 SSH 会话自己杀掉了**——因为承载命令的 shell 其命令行里也含这个模式字符串，被自己匹配到。正确做法按优先级：

```sh
# 首选：pid 文件
kill $(cat <会话目录>/.runtime/pid)
# 次选：按监听端口定位（P0 验证可用）
kill $(ss -ltnp | grep <端口> | grep -o 'pid=[0-9]*' | cut -d= -f2 | head -1)
```

**3. 探活端点需要 guard 提供。** P0 实测 `/healthz`、`/version`、`/health` **全部 404**，且 `/` 与 `/api` 在无令牌时返回 401。所以 P1–P4 期间探活只能靠 pid 文件 + 端口 TCP 连通性；真正的 HTTP 探活要等 guard（见 4.6）。注意 `/api` 在**带有效 cookie** 时返回 404 而非 401——404 说明认证已过、只是该路径非 GET 端点，这个区别可用于区分"认证失败"与"服务已起"。

### 4.5 `credential/` 凭据层

```
credential/
  types.ts          CredentialStrategy 接口
  tunnel-proxy.ts   反向隧道代理实现（首版唯一实现）
  token.ts          会话令牌生成与常量时间比较
```

接口留扩展位是为了日后可能的"远端专用 key"，但**首版只实现隧道代理**，不做第二种实现（决策 2）。

`tunnel-proxy.ts` 职责：本机起一个最小 HTTP 服务器，接收远端回打的请求，注入 `Authorization` 头后转发到真实 API，响应流式回传。多会话并行时**每会话一个独立代理实例与独立令牌**，避免 A 主机的远端借用 B 主机的通道。

**残余风险，必须写明：** 远端同主机的其他用户（或 root）可以直连那个反向端口，把它当开放中继用你的额度。这一点比环境变量方案好在——**key 本身从不落到远端**，被入侵的远端只能在连接期间借用中继，拿不到可离线复用的凭据。但"借用额度"这个风险是真实存在的，不能说成没有。

缓解手段：代理要求 Bearer 令牌（令牌只在会话目录里，与远端 dsh 同权限）；代理记录并限制请求速率；只放行 dsh 实际需要的路径与方法。这几条都挡不住同权限用户，只提高门槛。多用户远端主机上，这是必须让使用者知情的取舍。

业界共识也支持凭据代理方向：agent 环境里的 key 会进入 context window，prompt 注入或 verbose 日志都能泄出去（Coder AI Gateway、Christian Posta 的 CB4A 系列）。

### 4.6 `dsh-remote-guard` 远端侧 dsh 插件（第二个交付物）

**决策 5：要做。但 P0 实测后职责已大幅缩小——认证这块 dsh 自己已经做了。**

原本的判断是"dsh webserver 声明不提供认证，所以这层必须由我们补"。P0 实测证明这个判断对 webserver 包本身成立，但对 **web 应用组合**不成立：

| 实测 | 结果 |
|---|---|
| 启动输出 | `dsh web: http://127.0.0.1:18931/?token=<43 字符>` |
| 无令牌访问 `/` | **401** |
| 错误令牌 | **401** |
| 正确令牌 | 303，`Set-Cookie: ...; Max-Age=2592000; HttpOnly; SameSite=Strict` |
| 401 响应体 | `dsh web authentication required; reopen the URL printed by dsh web.` |

也就是说 dsh 已经实现了与 VS Code 等价的机制——随机令牌 + 换 cookie，且 `HttpOnly` + `SameSite=Strict` 比 VS Code 文档描述的更严。**令牌不落盘**（在会话目录里搜不到），只在启动输出里，这点也与 VS Code 不同（后者把 key 写在远端磁盘）。

因此 guard **不再需要实现认证**。剩下的职责只有两项：

| 职责 | 为什么仍然需要 |
|---|---|
| 免认证 `/healthz` | P0 实测 `/healthz`、`/version`、`/health` **全部 404**。dsh 没有免认证探活端点，而带令牌探活会让 `remote-process.ts` 依赖令牌解析，耦合过深 |
| `baseURL` 指向反向隧道 | 凭据路径需要，见 4.5 |

第二项能否用原生手段完成待查（`--patch` 改 `llm-deepseek` 的 `baseURL` 可能够用，见 4.2.3 的 patch 语法）。若够用，guard 就只剩 `/healthz` 一件事，可以做得极小。

**P1 起的接口预留**（相比 P0 前已简化）：

| 预留位 | 落点 | P1–P4 的行为 |
|---|---|---|
| 令牌捕获与透传 | `remote-process.ts` 解析启动输出取令牌；`forward-local.ts` 透传 | **必须从 P3 就做**——不做则浏览器打不开（401），不再是"可后补" |
| `/healthz` 探活 | `remote-process.ts` | P1–P4 回落到 pid 文件 + 端口 TCP 连通性 |
| guard 插件条目 | patch 模板 | 条目存在但默认摘除 |

**已验证不成问题的点**：本机转发端口与远端监听端口**不一致时照样工作**（实测本机 18901 → 远端 18931，带令牌取到完整页面，200 / 31252 字节）。web 应用有 `--trusted-host` 参数管 `/api` 的浏览器信任围栏，本担心它会按端口拒绝隧道请求，实测未发生。

注意 dsh webserver 的 **upgrade 路由只做精确匹配**（其 README 明确写了），WebSocket 相关处理要按精确 pathname 注册，不能用前缀。

---

## 五、远端落盘隔离（决策 11）

同机跑官方 dsh 的其他人不能被影响。调研结论与实现：

| 项目 | 远端落盘 | 隔离程度 |
|---|---|---|
| VS Code | 单根 `~/.vscode-server`（server/扩展/数据/日志全在内），官方明言与远端已有安装互不影响；卸载 = `rm -rf` 该根 | 最干净，**照抄的模型** |
| Zed | 二进制在 `~/.zed_server`，状态/配置走 XDG 目录 | 弱于 VS Code，远端本地装过 Zed 会共享 |
| JetBrains | `~/.cache/JetBrains` 下专属目录 | 单根自治 |

dsh 自身契约是「所有用户数据在一个根」（`DSH_HOME` 可整体搬移）——源码逐一
核实 settings/credentials/attachments/profiles/anonymous-id 全随之走，唯一例外
是 skill-filesystem 默认读 `~/.agents`（`DSH_AGENTS_HOME` 可覆盖）。

实现（对照审计发现的两处缺口 + doctor 可见性）：

| 落盘 | 状态 |
|---|---|
| Node/dsh 安装、会话状态（= `DSH_HOME`）、临时文件、镜像缓存 | ✅ 原本就在 `~/.dsh-remote/` 内 |
| npm 缓存（含 `_logs`） | ✅ 收进 `~/.dsh-remote/npm-cache`（装机命令带 `npm_config_cache`） |
| skill 目录 | ✅ runner 设 `DSH_AGENTS_HOME=<会话目录>/agents`，不读机器全局 `~/.agents` |
| pnpm store | ⚠️ 有意不隔离：仅用户主动跑 `dsh plugin` 才触及，内容寻址并发安全 |
| doctor | 新增「隔离检查」段：占用清单 + 官方 `~/.dsh` 存在性 + 卸载指引 |

实测：`npm config get cache` 认到我们的根、`npm view` 后 `_cacache` 落我们的根
而 `~/.npm` 零新写入；远端进程环境确认 `DSH_AGENTS_HOME` 指向会话内目录。

---

## 六、多主机并行（决策 9）

同时连多台主机，以及对同一台主机开多个会话，两种情形都要支持。

**会话 id 取 `(主机别名, 远端工作目录)` 的确定性摘要**，不用随机值。理由：重连时要能找回既有会话（对标 Zed 的 `--identifier` + `--reconnect` 语义）。同别名同目录 ⇒ 同 id ⇒ 复用；不同目录 ⇒ 不同 id ⇒ 各自独立的 `DSH_HOME`。

隔离边界：

| 资源 | 隔离方式 |
|---|---|
| 远端 dsh 安装 | **共享**，按版本（不必每会话一份） |
| 远端 `DSH_HOME` | 每会话独立 `sessions/<会话 id>/` |
| 远端 webserver 端口 | 每会话独立，探测 + 冲突重试 |
| 反向代理端口与令牌 | 每会话独立 |
| 本机转发端口 | 每会话独立，OS 分配 |
| SSH 传输实例与通道池 | **每主机一个**，同主机多会话共享 |

本机侧需要一张会话表 `~/.dsh/remote-sessions.json`：会话 id → 主机别名、远端工作目录、本机/远端/反向端口、本机 CLI 的 pid、启动时间、状态。

两个必须处理的细节：

- **陈旧条目**：CLI 被 kill -9 时表里会留死条目。读表时按 pid 存活性过滤，`status` 显示并清理。
- **并发写竞争**：两个 CLI 同时启动会同时写表。用锁文件 + 原子替换（先写临时文件再 rename）。dsh 自己用 `@deepseek-ai/dsh-atomic-write` 的 `withFileLock` 做同类事，但本仓库是独立 CLI，自己实现一个最小版本即可，不引入该依赖。

---

## 七、CLI 表面

```
dsh-remote list                        列出 ~/.ssh/config 中的主机
dsh-remote connect <别名> [--cwd <远端路径>]
                                       主命令：引导 → 起远端 → 建隧道 → 开浏览器 → 常驻守护
dsh-remote status                      所有会话状态（含跨主机）
dsh-remote kill <别名> [--all]          杀远端 dsh（对标 VS Code "Kill VS Code Server on Host"）
dsh-remote doctor <别名>                诊断：镜像延迟、Node/dsh 版本、通道配额、隧道连通性
dsh-remote clean <别名> [--keep-latest] 清理旧版本目录与陈旧会话目录
```

`--cwd` 参与会话 id 计算，是"同主机多会话"的入口。`kill` 与 `doctor` 不是锦上添花——VS Code 的故障排查文档把"kill server"列为一大类连接错误的通用解法。`clean` 是版本入名 + 每会话目录策略的必要配套（两者都会累积）。

---

## 八、现有代码处置

### 7.1 复用清单（显式）

| 现有文件 | 处置 | 去向 |
|---|---|---|
| `src/ssh-config-parser.ts` (239行) | **整体复用** | `hosts/ssh-config-parser.ts`。主机唯一真源不变，`compute()` 合并 `Host *` + 递归 `ProxyJump` 链照用 |
| `src/ssh2-connection.ts` (591行) | **部分复用** | ssh2 连接建立、跳板机链、SFTP 会话管理 → `transport/ssh-transport.ts`；`RpcPeer`、TLS-PSK、helper 帧协议**全部废弃** |
| `src/remote-bootstrap.ts` (535行) | **部分复用** | Node 探测（`uname -s && uname -m`、arch 映射 aarch64/x86_64/armv7l）、`MIRROR_URLS`、tar 解包 → `provision/probe.ts` + `node-installer.ts` + `mirror-selector.ts`；helper 上传逻辑废弃 |
| `src/remote-connection.ts` (285行) | **部分复用** | 状态机骨架、指数退避、连接历史 → `session/`；状态枚举按 Zed 扩充 |

复用时顺手偿还已知问题：`probe()` 里不存在的 `profile` 引用（108、111 行）、未 import 的 `homedir`（498、519 行）。

### 7.2 删除清单

| 文件 | 原因 |
|---|---|
| `src/remote-workspace.ts` | 远端 dsh 用自己的 `node:fs`，shim 无意义 |
| `src/remote-workspace-bridge.ts` | 同上 |
| `src/remote-workspace-registry.ts` | 同上 |
| `src/remote-directory-picker.ts` | 同上，且原地改写 capability 的做法本身就该废 |
| `src/dependency-collector.ts` | 不再散装传 588 个文件 |
| `src/native-stub.ts` | **远端原生模块变真的，桩必须删** |
| `src/webgui-integration.ts` | 本机不再有 dsh 页面可注入 |
| `client/` 全部 | 同上 |
| `src/api/websocket-bridge.ts` | 已失效 |
| `src/api/remote-host-controller.ts` | 门面随 WS 层一起废 |
| `src/remote-hosts.ts` | 遗留代码，运行时早已不走 |
| `src/schemas.ts` | helper 协议专用 |
| `src/diagnostics.ts` | 临时诊断，其注释自己写了"问题解决后删除" |
| `tests/*.cjs` | 依赖已删模块 |

净减约 2000 行 shim，外加 588 文件串行 SFTP 上传整条路径消失。

### 7.3 仓库形态变化

薄启动器不是 Cordis 插件，所以：

- `package.json` 从插件改为 CLI 包，加 `bin` 字段
- `cordis.patch.yml` 与 `INSTALL.md` 里三种插件加载方式**作废**，改为 `npm i -g` 或 `npx`
- `dsh` 字段（`bundle.patch`）移除
- 顺手补上现有缺失声明：`ssh-config` 没进 `dependencies`（干净安装会崩）；`zod` 实际装 4.6.5 而 `package.json` 写 `^3.24.0`

`dsh-remote-guard` 作为第二个包（`remote-plugin/` 子目录），它**是** Cordis 插件，装在远端。

---

## 九、里程碑

### P0 — 可行性验证 ✅ 已完成（2026-09-20，aarch64 验证机）

五步全部通过，门禁放行。详细实测数据与结论见第十二章。

| # | 验证项 | 结果 |
|---|---|---|
| 1 | 装 Node 与 `@deepseek-ai/dsh` | ✅ 约 75 秒 / 700M，但**必须用 Node v24**（见 11.2） |
| 2 | 原生模块可用性 | ⚠️ 桩已消除、真 `.node` 加载成功、`flock` 可用；**landlock 受远端内核限制**（见 11.3） |
| 3 | 每会话 `DSH_HOME` | ✅ 成立，共享安装与会话状态确实解耦 |
| 4 | `ssh -L` + Windows 浏览器 | ✅ 取到完整页面（200 / 31252 字节），本地与远端端口不一致也正常 |
| 5 | `ssh -R` 凭据回打 | ✅ 远端环境无任何 API key，代理在本机注入 |

### P1 — 连接闭环

`transport/` + `hosts/` + `provision/probe.ts` + `mirror-selector.ts`，同时按 4.6 表格铺好 guard 的接口预留位。交付：`dsh-remote list` 与 `doctor` 能跑，能打印远端 os/arch/node 版本与各镜像实测延迟。

### P2 — 引导闭环 ✅ 已完成

`provision/` 全部（`node-installer` / `dsh-installer` / `profile-writer` / `provisioner`）+ `util/session-id.ts`，交付 `dsh-remote provision` 命令。

实测（验证机）：

| 路径 | 耗时 | 说明 |
|---|---|---|
| 全新装 Node v24.20.0 | 10.5s | 下载 + 解包 + 稳定性自检 20/20 |
| 全新装 dsh 0.1.5-rc.2 | 57.2s | 490 个包，与 P0 实测 60s 一致 |
| 全部复用（幂等重跑） | 2.5s | 命中已装版本，跳过测速与安装 |
| dist-tag 解析 | 0.8s | `latest → 0.1.5-rc.2`，印证 latest 比 alpha 旧 |

实现中修掉一个会全面破坏远端命令的 bug：`env: { PATH: '<新>:$PATH' }` 经 `quote()` 转义后 `$PATH` 成了字面量，远端 PATH 只剩一个目录，连 `rm`、`mkdir` 都找不到。改为传输层专设 `pathPrefix` 选项，把 `"$PATH"` 留在引号外由 shell 展开，目录本身仍转义防注入。

另外把 `--ssh-config` 接成真实参数（对标 VS Code 的 `remote.SSH.configFile`），它必须在任何主机解析前生效，因为解析结果带模块级缓存。

### P3 — 会话闭环 ✅ 已完成

`tunnel/`（`port-allocator` / `forward-local`）+ `session/`（`remote-process` / `lifecycle-state` / `heartbeat` / `reconnect` / `session-registry` / `session-manager`），交付 `connect` / `status` / `kill` 三个命令。

实测（验证机）：

| 场景 | 结果 |
|---|---|
| `connect` 全流程 | 引导复用 2s + 启动远端 3.7s + 建隧道，端到端就绪 |
| 经隧道取页面 | 无令牌 401；带令牌 200 / 31252 字节完整页面 |
| detach 语义 | 本机 CLI 退出后远端 dsh 仍在监听 |
| 会话复用 | 同 `--cwd` 再连，探到既有 pid 直接复用，不重启 |
| 同主机多会话 | 不同 `--cwd` → 不同会话 id、独立端口与 pid，并行可用 |
| `kill --all` | 正确停止运行中的会话，跳过未运行的 |
| 陈旧记录清理 | 本机 CLI 消失后 `status` 自动清除其记录 |

一处关键设计：**本机监听器跨重连存活。** 为此把传输接口的 `forwardOut`（本机监听 + 转发一体）改为更底层的 `openChannel`（只开通道），监听器交由 `tunnel/forward-local.ts` 持有。重连时只换传输引用，本机端口不变——否则用户已打开的浏览器标签会全部失效。

实测暴露并修掉两个 bug：

1. **会话表主键必须是 `(sessionId, localPid)` 组合，不能只用 `sessionId`。** 会话 id 是远端身份，同别名同目录的多个本机 CLI 会共享同一个远端 dsh（后来者探到即复用），它们是同一远端会话的多个本机视图。只按 sessionId 去重会让后启动的 CLI 挤掉先前记录，`status` 漏报一个仍在工作的隧道。

2. **Git Bash（MSYS）会在参数到达程序前改写 POSIX 路径。** 在 Git Bash 里写 `--cwd /home/user`，程序实际收到 `D:/SoftWare/Git/home/user`。这发生在 shell 层，程序无法阻止，只能识别并拒绝——放过它不只是路径错，远端目录参与会话 id 计算，同一逻辑会话会因调用方式不同得到不同 id，复用与 kill 都会失灵。现已校验并提示两种绕过方式（`--cwd //home/xxx` 或 `MSYS_NO_PATHCONV=1`）。

### P4 — 凭据闭环 ✅ 已完成

`credential/`（`token` / `types` / `tunnel-proxy`）+ 会话编排接线，交付完整的反向隧道代理。

实测（验证机，本机带假 key 验证——上游 401 恰好证明请求到达了真实 API 且 key 被注入）：

| 验证项 | 结果 |
|---|---|
| 占位凭据进远端进程环境 | ✅ `/proc/<pid>/environ` 有 `DEEPSEEK_API_KEY` |
| 令牌文件权限 | ✅ 600（umask 077 创建） |
| 正确令牌 → 代理 → 上游 | ✅ 真实 `api.deepseek.com` 回 401（假 key 被拒），链路全通 |
| 错误令牌 | ✅ 本机代理回 401（令牌校验生效） |
| patch 生效 | ✅ `--dump-config` 确认 `baseURL: http://127.0.0.1:<反向端口>/anthropic` |
| 会话复用读回材料 | ✅ 反向端口与令牌跨重启从 `.runtime/` 读回，代理校验仍通过 |
| 真实模型调用 | ⏸ 需用户带真实 `DEEPSEEK_API_KEY` 验证；链路已由上游 401 证明 |

关键设计（均已实现）：

- **占位凭据即共享令牌。** dsh 缺 key 时请求在发出前就以 `MISSING_CREDENTIAL` 失败——所以远端进程环境里放的是代理令牌（随机 43 字符），请求带它回打，代理校验后换成真实 key。真实 key 全程不出本机。
- **令牌与反向端口随会话固定，落盘远端 `.runtime/`**（令牌 600 权限）。反向端口写进 patch 的 baseURL，运行中的远端进程认它；复用、重连、换本机 CLI 读回的都是同一组值。
- **多视图共享会话时反向端口先到先得**：sshd 拒绝重复绑定，后启动的视图挂不上 `forwardIn` 时降级为警告（凭据路径由先来的视图维持），不阻断会话。
- **代理实例跨重连存活**：重连只重挂 `forwardIn`，本机回环监听不动。

实现中修掉一个环境级问题：**本机 Node v24.14.0 的 fetch（undici）拒绝一切流式请求体**（ReadableStream / 异步生成器 / `new Request` 四种传法实测全部抛 `expected non-null body source`，字符串与 Buffer 正常）。因此代理的请求体改为整体缓冲后转发——模型调用请求体是 KB 级 JSON，不受影响；流式真正要紧的响应侧（SSE）保持 pipe 直传。已写入 CLAUDE.md 的踩坑清单。

另一个实现细节：反向通道（ssh2 ClientChannel）**不能**直接喂给 `http.Server`（缺 `setTimeout` 等 Socket 接口），代理在本机回环起真实 http.Server 监听临时端口，通道与一条本机 TCP 连接对接——多一跳本地回环换来完全标准的 socket 语义。

**多供应商扩展（用户实际需求驱动）**：用户的默认模型配置在 `llm-pi-ai` 通道（settings.yaml 的 `llm-pi-ai.providers` 段，如 AStudio），P4 的单上游 DeepSeek 代理覆盖不到。泛化方案：

- 代理改为**路由表**：DeepSeek 原生通道保留 `/anthropic` 前缀（patch 重定向）；pi-ai 供应商统一 `/r/<供应商名>` 前缀，路由自动从本机 `~/.dsh/settings.yaml` 提取（要求供应商同时具备 `apiKeyEnv` 与 `baseURL`）。
- 路径换算：请求前缀替换成上游自身路径（`/r/astudio/...` → maas 上游的 `/v1/...`），剩余子路径与查询串原样。
- 每条路由的 `keyEnv` 各自检查——缺哪个供应商的 key 只影响该供应商（502 带明确指引），其余照常。
- **远端 settings 镜像**：本机 settings.yaml 整体复制到会话 `DSH_HOME/settings.yaml`（热重载，同值重写无副作用），仅 provider 的 `baseURL` 重定向进隧道。`agent-default-model` 等键随之镜像，远端的默认模型与本机一致。**只镜像 settings**（凭据引用，无密钥），绝不镜像 `.credentials.yaml`（可能含真实密钥）。
- pi-ai 的 `apiKeyEnv` 每次请求经 `ctx.credentials` 从继承环境解析，占位令牌进远端进程环境即生效——与 DeepSeek 同一机制。

实测：4 条路由（DeepSeek + astudio + qwen + iflytek）自动识别；假 ASTUDIO key 经代理打到讯飞 maas 上游，拿到上游真实 401（`HMAC signature cannot be verified: apikey not found`，链路全通且 key 已注入）；缺 key 的 DeepSeek 路由得到明确的 502 指引。

### P5 — guard 与打磨 ✅ 已完成（`--upload-fallback` 除外，见下）

**guard 的最终处置：不需要独立插件，其剩余职责由更轻的机制承担。**

决策 5 说要做 `dsh-remote-guard`，当时的理由是"dsh webserver 不提供认证，这层必须补"。
P0 实测推翻了前提（dsh 已内置令牌 + cookie 认证），guard 职责缩到两件事，而这两件
在后续阶段都被更轻的机制解决了：

| 原职责 | 最终实现 |
|---|---|
| 认证 | dsh 内置（P0 发现，见 11.4） |
| `baseURL` 指向反向隧道 | P4 的 profile patch（`id: llm-deepseek` 条目） |
| 免认证 `/healthz` 探活 | **心跳的 HTTP 层**：带会话令牌 curl 根路径，拿到任何 HTTP 状态码即证明 webserver 在真正服务请求（P0 实测带令牌得 303） |

第三项的实现把三层判据合并进一条远端命令（进程存活 + 端口监听 + HTTP 应答），
不需要在远端安装、分发任何插件——也就绕开了"未发布的 guard 包如何装到远端"这个
分发问题。P0 时"P1 起预留的接口边界"（令牌捕获与透传、探活回落、patch 模板条目）
全部按计划落位并被上述机制消费。

`clean` 命令已实现并实测：清陈旧会话目录与旧版本（默认各保留最新 1 个，
`--keep` 调整）。保护机制依赖一个事实——**活会话的 runner 脚本
（`.runtime/start.sh`）记录着它正在用的 dsh 与 Node 路径**，被引用的版本即使
超出保留线也不删。实测暴露并修掉一个解析 bug：runner 脚本的一行 exec 里 dsh 与
Node 路径同时出现，用 `else if` 会让第二个版本永远收不到保护。

心跳升级实测：连续十几轮心跳零误判（HTTP 探活层与 pid/端口层一致）。

**`--upload-fallback` 离线回退：有意推迟，未实现。** 原因是实现成本与收益严重
不对称：dsh 安装是 490 个包的依赖树，正确的离线方案要在本机为远端平台打包整棵树
（`npm install --os/--arch` 的标志存在，但生命周期脚本在**本机平台**上跑，
koffi 这类跨平台包会构建出错误产物或直接失败）；`npm pack` 只含 dsh 自身
（49KB），不含依赖。而它的目标场景——完全离线的远端——与当前实际环境不符
（远端有网，镜像测速就是为此设计的）。若确有离线远端需求，正确做法是先在另一台
同架构有网主机上装好再整目录搬运，或单独立项做依赖树打包。

---

## 十、风险

| 风险 | 说明 | 缓解 |
|---|---|---|
| **远端 Node 运行时不稳定** | **P0 实测 v22 在 aarch64 上崩溃率 35%**，见 11.2 | 锁定 v24 系；`probe` 阶段跑崩溃率自检，不合格拒绝引导并给出换版建议 |
| 远端装不上 | npm 镜像需可达 | `mirror-selector` 自适应 + `doctor` 提前诊断 + `--upload-fallback` |
| landlock 不可用 | **P0 实测取决于远端内核 LSM**，非架构问题 | `doctor` 报告 `probe()` 结果；沙箱依赖方需自行决定降级策略 |
| 令牌捕获失败 | 令牌只在远端启动首行输出，丢了就打不开页面 | 日志文件持久化 + 启动后立即校验能取到；失败即报错而非静默 |
| 远端端口竞态 | 探测与绑定之间有窗口，多会话放大 | 有限次换端口重试 + 启动后探活验证 |
| 本机文件不可用 | 没法把本地文件拖进远端会话 | 显式上传命令（P5），或告知用户用 git |
| 反向隧道中继被借用 | 远端同权限用户可用你的额度 | 每会话独立令牌 + 限速 + 路径白名单；多用户主机需知情 |
| 通道配额 | 正反向转发 + exec + SFTP 共用 SSH 通道 | `channel-pool.ts` 统一配额，每主机一池 |
| 会话表并发写 | 多 CLI 同时启动 | 锁文件 + 原子替换；按 pid 过滤陈旧条目 |
| 高延迟/丢包链路 | SSH 上的交互体验会退化 | 已知限制；Zed 社区也在讨论 MoSH，无现成解 |
| 磁盘占用 | P0 实测约 700M/主机（Node 200M + dsh 500M） | `clean` 命令；`doctor` 提示占用 |

已消除的风险：**每会话 `DSH_HOME` 不成立**（P0 第 3 步实测成立）。
首次安装耗时按决策 7 接受，且 P0 实测仅 75 秒，远优于预估。

---

## 十一、调研来源

源码级（可信度高）：

- Zed `crates/remote/src/transport/ssh.rs`（2408 行）、`remote_client.rs`（2109 行）、`crates/remote_server/src/main.rs`
- dsh `packages/util/home-paths/src/index.ts`、`packages/boot/app-boot/src/{index,profile}.ts`、`apps/cli/src/args.ts`、`packages/host/webserver/`

文档级（可信度中）：

- [Zed Remote Development](https://zed.dev/docs/remote-development)
- [VS Code Remote Development 故障排查](https://code.visualstudio.com/docs/remote/troubleshooting)、[Remote SSH](https://code.visualstudio.com/docs/remote/ssh)
- [JetBrains 远程开发概览](https://www.jetbrains.com/help/clion/remote-development-overview.html)、[Gateway 深入](https://blog.jetbrains.com/blog/2021/12/03/dive-into-jetbrains-gateway/)
- [Coder 架构](https://coder.com/docs/admin/infrastructure/architecture)、[AI Gateway provider 配置](https://coder.com/docs/ai-coder/ai-gateway/providers)
- [凭据代理模式（CB4A）](https://blog.christianposta.com/credential-brokering-patterns-for-ai-agent-egress/)

注：`vscode-remote-release` 是纯 issue 仓库，只有 issue 模板、文档跳转链接与 devcontainer 基线测试，**无扩展源码**，所以 VS Code 部分只能是文档级。

---

## 十二、P0 实测记录（2026-09-20）

环境：客户端 Windows 11；远端验证机（aarch64，3 核，15G 内存，Ubuntu glibc 2.35，内核 5.10.0+）。

### 11.1 结论概览

方案主体被证实可行，但有三处实测结论推翻了原先的判断，均已改回正文：

| # | 原判断 | 实测 | 影响 |
|---|---|---|---|
| 1 | dsh webserver 无认证，guard 必须补 | **dsh 已内置令牌 + cookie 认证** | guard 职责大幅缩小，见 11.4 |
| 2 | 官方 Node 源被墙，需选阿里 | 官方可达；**只测时间会被 302 误导** | 测速必须带 `-L` 并校验内容，见 4.2.1 |
| 3 | 装上预编译包即等于沙箱可用 | **landlock 取决于远端内核** | 收益表述需修正，见 11.3 |

### 11.2 Node v22 在 aarch64 上不稳定（最重要的发现）

最初按 dsh 的 `engines` 下界装了 Node v22.23.2，`npm install` 必然失败。报错指向 koffi 的 postinstall：

```
npm error path .../node_modules/koffi
npm error command sh -c node ./cnoke.cjs -P . -D src/koffi --prebuild --release
npm error signal SIGTRAP
# Fatal JavaScript out of memory: MemoryChunk allocation failed during deserialization.
```

**这个归因是错的。** 四条证据推翻了它：

1. 单独 `npm install koffi` 在同一环境下 1 秒装完，完全正常
2. 加 `--ignore-scripts`（完全跳过 postinstall）仍然崩，且崩的是 npm 自己（`EXIT=133`、`Trace/breakpoint trap (core dumped)`）
3. `npm view <包>` 这种纯网络操作也崩
4. 机器有 13G 空闲内存，cgroup 无限制，`ulimit -v unlimited`，不是真 OOM

真因是 **V8 在这台 aarch64 机器上初始化 isolate 时随机失败**。逐步加压测试暴露了随机性：50MB ok、100MB 崩、200MB ok、400MB ok。裸起 node 的崩溃率统计：

| Node 版本 | 崩溃率 | 备注 |
|---|---|---|
| v22.23.2 | **7 / 20（35%）** | 关 ASLR（`setarch -R`）降到 4/20，未消除 |
| v20.19.5 | 3 / 20（15%） | |
| **v24.11.1** | **0 / 60** | 大内存分配 0/10 失败 |

SIGTRAP 是 V8 的 OOM 处理器调 `__builtin_trap()` 的正常表现，所以报错形态像 OOM，但根因是 VA 空间/ASLR 交互。`npm install` 要起几十次 node 子进程，35% 的单次崩溃率意味着整装几乎必败。

**决策 10：锁定 Node v24 系。** dsh 的 `engines` 是 `^22.19.0 || >=24.0.0`，v24 在范围内。`probe.ts` 应当跑一次崩溃率自检（建议连起 20 次），不合格则拒绝引导并建议换版——这比装到一半失败再回溯要省事得多。

### 11.3 原生模块：桩消除了，landlock 取决于内核

预编译包正确装上，且是**真实二进制**而非 no-op 桩：

```
node_modules/@deepseek-ai/node-addon-system-linux-arm64/bin/glibc/system.node
node_modules/@deepseek-ai/node-addon-system-linux-arm64/bin/musl/system.node
```

加载与调用实测：

| 能力 | 结果 |
|---|---|
| `flock` 导出 | `tryLockExclusive` 存在 |
| `flock` 实调用 | **成功**（签名是 `Promise<void>`，resolve 即拿到锁） |
| `landlock-run` 导出 | `LAUNCHER_BIN`、`grantArgs`、`launcherPath`、`probe` 均在 |
| `launcherPath()` | 正确返回平台包内的 `bin/landlock-run` |
| **`probe()`** | **`"unusable"`** |

`probe()` 返回 `unusable` 的原因在远端内核：`/sys/kernel/security/lsm` 为 `capability,yama,kbox_capability`，**没有 landlock**。该包的类型声明明确说明 `unusable` 涵盖"内核无 landlock、LSM 被禁用、二进制缺失"三种情况且故意不可区分。

所以准确表述是：**转向消除了 `native-stub.ts` 这个架构性空洞（本机方案下二进制根本无法跨平台，只能用桩），flock 确实可用；landlock 则取决于具体远端主机的内核配置，与架构选择无关。** 验证机恰好没开。`doctor` 应当报告 `probe()` 结果，让用户知道该主机的沙箱能力边界。

### 11.4 dsh 已内置认证（guard 职责缩小）

启动输出：`dsh web: http://127.0.0.1:18931/?token=<43 字符>`

| 请求 | 响应 |
|---|---|
| `/` 无令牌 | 401 |
| `/` 错误令牌 | 401 |
| `/` 正确令牌 | 303 + `Set-Cookie: ...; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict` |
| `/api` 无令牌 | 401 |
| `/api` 带有效 cookie | 404（认证已过，该路径非 GET 端点） |
| `/healthz`、`/version`、`/health` | **全部 404** |

401 响应体：`dsh web authentication required; reopen the URL printed by dsh web.`

与 VS Code 的机制等价甚至更严（`HttpOnly` + `SameSite=Strict`，且**令牌不落盘**——在会话目录里搜不到，只存在于启动输出）。因此 guard 不需要实现认证，只需补免认证探活端点。代价是**令牌捕获从"可后补"变成 P3 必做**：不解析首行输出就拿不到令牌，浏览器直接 401。

### 11.5 隧道与凭据路径

正向（`ssh -L 18901:127.0.0.1:18931`）：带令牌访问 → 303 → 跟随重定向取到完整页面，**200 / 31252 字节**，内容是真实 dsh 页面（`<!doctype html>` + boot script）。

**本地端口与远端端口不一致不成问题。** 原先担心 web 应用的 `--trusted-host`（`/api` 浏览器信任围栏）会按端口拒绝，实测未发生。

反向（`ssh -R 127.0.0.1:18903:127.0.0.1:18902`）：远端 `curl` 回打本机假代理成功，代理返回注入后的响应；同时确认**远端环境无任何 API key**（`env | grep -i "DEEPSEEK\|API_KEY"` 为空）。凭据路径的核心主张得到验证。

### 11.6 其他实现细节（已并入正文）

- `PATH` 必须含 node 的 bin 目录——dsh 和 npm 的 shebang 都是 `#!/usr/bin/env node`
- patch 条目必须用 `id` 而非 `name`，否则报 `patch: id is required for non-insert patches`
- host/port 用 web 应用原生 flag（`--host`/`--port`/`--no-open`），经 `webStartup` 服务覆盖 bundle 默认值，无需 patch
- `dist-tags` 的 `latest` 是 `0.1.5-rc.2` 而 `alpha` 才是 `0.1.6-alpha.2`，**版本号必须显式指定**
- 远端启动必须 `setsid nohup ... < /dev/null &` detach
- **停进程绝不能用 `pkill -f <模式>`**——实测把执行该命令的 SSH 会话自己杀掉了（承载命令的 shell 命令行含同一模式串）。用 pid 文件或按端口定位
- 磁盘占用：Node 201M + dsh 500M ≈ 700M/主机

### 11.7 P0 遗留

远端保留了可复用产物：`~/.dsh-remote/node/v24.11.1`、`~/.dsh-remote/versions/dsh-0.1.6-alpha.2`。已清理：测试会话目录、临时文件、不稳定的 v22、测试进程。一个陈旧的 18903 监听残留（已不可连接，随 sshd 回收）。

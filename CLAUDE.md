# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 语言要求

本仓库的所有交流、代码注释、提交信息、文档一律使用**中文**。代码规范见 [docs/type_script_style.md](docs/type_script_style.md)，写任何代码前先读它。

## 这是什么

`@deepseek-ai/dsh-remote-ssh` 是 deepseek-harness（dsh）的 Cordis 插件，提供远程主机开发能力：跨平台 SSH 连接、远端环境全自动引导、连接编排状态机、远程工作区适配、注入到 dsh Web GUI 的远程资源管理器面板。

**没有构建步骤。** `tsconfig.json` 是 `noEmit: true` + `allowImportingTsExtensions: true`——dsh 通过 tsx 实时编译 TypeScript 源码，插件以 `.ts` 形式被直接加载。不要添加打包产物或 `outDir` 流程。

## 常用命令

```bash
# 类型检查（见下方"已知问题"，本地 tsc 目前跑不起来，用这条替代）
npx -y -p typescript@5.7.3 tsc --noEmit

# 独立运行演示服务（不嵌入 dsh），然后浏览器打开 http://127.0.0.1:18900
npx tsx tests/start-demo.cjs --helperDir <dsh-ssh>/lib/bundle

# 单个测试脚本（tests/ 下每个文件都是独立可执行脚本，不是 node:test 套件）
npx tsx tests/test-quick-connect.ts     # 最快的连接冒烟测试
npx tsx tests/test-connect.cjs          # SSH 连接 + SFTP
npx tsx tests/test-bootstrap.cjs        # 全自动引导
npx tsx tests/test-e2e.cjs              # 端到端连接编排
npx tsx tests/test-ssh-config.ts        # ssh config 解析
```

`npm test`（`node --test`）跑不出有效结果——`tests/` 里没有 `node:test` 用例。

**测试需要真实远端主机。** 现有脚本硬编码了别名 `OrangePI`（aarch64 Linux, 192.168.1.82），从 `~/.ssh/config` 解析。改动连接/引导逻辑后，至少跑一次 `test-quick-connect.ts` 验证，不能只靠类型检查。

在 dsh 中加载插件的三种方式见 [INSTALL.md](INSTALL.md)，开发调试首选 `pnpm dsh web --patch ../dsh_remote_ssh/cordis.patch.yml`。

## 架构

四层，数据自上往下：

```
client/remote-explorer.js  ← 注入进 dsh 主页面的面板（原生 JS，无框架、无构建）
client/index.html          ← /remote-ssh 独立页面
        │ WebSocket JSON-RPC  /remote-ssh/ws
src/webgui-integration.ts  ← 路由注册 + handleMethod 方法分发表
        │
src/api/remote-host-controller.ts  ← 门面：主机列表、连接生命周期、远端文件操作
        │
src/remote-connection.ts   ← ConnectionOrchestrator 状态机 + 自动重连 + 连接历史
        │
src/ssh2-connection.ts     ← Ssh2Connection：ssh2 客户端 + RpcPeer + TLS-PSK 流
        │ 4 字节大端长度前缀 + JSON 帧
远端 helper（dsh-ssh 构建产物，跑在远端 Node 上）
```

旁路模块：
- [src/ssh-config-parser.ts](src/ssh-config-parser.ts) — 主机配置的**唯一**来源
- [src/remote-bootstrap.ts](src/remote-bootstrap.ts) — 远端环境引导（装 Node、传 helper 和依赖）
- [src/remote-directory-picker.ts](src/remote-directory-picker.ts) — 劫持 dsh 的 `ctx.directoryPicker` 走远端
- [src/remote-workspace.ts](src/remote-workspace.ts) — 用 helper RPC 替代本地 `node:fs` 的 realpath/stat/list

### 必须知道的几件事

**1. 主机配置来自 `~/.ssh/config`，不做持久化。** 这是近期的架构转向。`listHosts()` / `resolveHost(alias)` 用 `ssh-config` 库的 `compute()` 合并 `Host *` 默认值并递归解析 `ProxyJump` 跳板机链。解析结果带模块级缓存，改了 config 文件必须调 `refreshConfig()`。

[src/remote-hosts.ts](src/remote-hosts.ts) 的 `RemoteHostRegistry`（主机档案 CRUD + `remote-hosts.json`）是**遗留代码**，仍从 `index.ts` 导出、仍被老的 `.cjs` 测试引用，但运行时路径已经不走它。新代码不要用它。

**2. 连接是"先试后引导"。** `connectWithBootstrap()` 先用猜测路径（`~/.dsh/node/node`、`~/.dsh/helper/helper.mjs`）直连并**跳过 hash 校验**（`helperHash` 为空时 `Ssh2Connection` 不校验），失败才跑完整引导，再带着引导出的 hash 重连。这是为了避免已引导主机每次重复引导。改这里要保持两条路径都能走通。

**3. RPC 协议必须与 dsh-ssh 保持二进制兼容。** `SSH_PROTOCOL_VERSION = 1`，帧格式是 4 字节大端长度 + JSON body，`RpcPeer` 与 dsh-ssh 的 `SshRpcPeer` 可互操作。流转发用 ssh2 的 OpenSSH 扩展 `openssh_forwardOutStream` 直连远端 Unix 域套接字，再叠一层 TLS-PSK（`PSK-AES256-GCM-SHA384`，TLS 1.2 锁定，与 dsh-ssh 的 `stream-security.ts` 一致）。这些常量不能单方面改。

**4. 引导上传的是散装文件，不是 tarball。** `collectHelperDependencies()` 从工作队列递归收集 `@deepseek-ai/*` 和 `zod` 的传递依赖（约 588 个文件），逐个 SFTP 上传到远端 `~/.dsh/helper/node_modules/`；原生模块 `node-addon-system` 用 [src/native-stub.ts](src/native-stub.ts) 的 no-op 桩替换，因为二进制无法跨平台。helper 通过 `NODE_PATH` 环境变量找到这些依赖。上传全部走**单个 SFTP 会话串行**执行——并发会超 SSH 通道上限。

**5. 面板是注入进去的，不是独立页面。** `webServer.tapIndex()` 把 `client/remote-explorer.js` 整个内联到 dsh 主页面 `</body>` 之前。脚本内容有模块级缓存，改完要重启 dsh 才生效。`remote-directory-picker.ts` 的做法更激进：直接**原地改写** `ctx.directoryPicker` capability 对象的 `list` 方法，连接断开时还原。

**6. 加新 WebSocket 方法要改两处。** [src/webgui-integration.ts](src/webgui-integration.ts) 的 `handleMethod` switch 是真正生效的分发表，前端调用点在 `client/remote-explorer.js`。

**7. 落盘位置。** 镜像源选择存 `~/.dsh/remote-ssh-mirror.json`，远程工作区存 `~/.dsh/remote-workspaces.json`。Node 下载镜像源支持官方/阿里/清华/中科大四选一。

## 已知问题

动手前先了解这些，别当成自己改出来的：

- **`npm run typecheck` 跑不起来。** `node_modules` 里的 typescript 是 7.0.2，缺 `@typescript/typescript-win32-x64` 平台包。用 `npx -y -p typescript@5.7.3 tsc --noEmit` 替代。
- **`ssh-config` 没进 package.json。** `ssh-config-parser.ts` 依赖它，`node_modules` 里有 5.3.0，但 `dependencies` 没声明。干净安装会崩。
- **`zod` 实际装的是 4.6.5，package.json 写 `^3.24.0`。** 这导致 `remote-workspace.ts:106` 等处 zod 类型推导报错。
- **`src/api/websocket-bridge.ts` 已失效。** 它调用的 `controller.list/create/update/delete/probe/bootstrap` 在 controller 上都不存在了（随主机管理迁移到 ssh config 一起废弃）。但 `tests/start-demo.cjs` 还在 require 它。生效的 WS 实现是 `webgui-integration.ts`。
- **`remote-bootstrap.ts` 有未定义引用**：`probe()` 里用了不存在的 `profile`（108、111 行），`homedir` 没 import（498、519 行）。`bootstrap()` 路径不经过这些行所以运行时没暴露。
- **`remote-host-controller.ts:142` 调了未定义的 `log()`**。
- `ConnectionState` 的 `'reconnecting'` 不在 `api/types.ts` 的 `RemoteConnectionStateValue` 里，两处类型不一致。

现有类型错误共约 25 个。改代码时至少不要让它变多；顺手修掉相关的那几个更好。

## 约束

- 远端只支持 POSIX（Linux/macOS）；客户端支持 Windows/Linux/macOS，所以**不要引入依赖系统 `ssh` 命令的实现**——用纯 JS 的 ssh2 就是为了这个。
- 认证只用私钥文件路径引用，不在代码或配置里落明文密钥。`remote-bootstrap.ts` 的 `connectClient()` 目前硬要求 `IdentityFile`。
- 断线语义与 dsh-ssh 一致：连接丢失后所有挂起操作作废，`Ssh2Connection` 自身不重连，重连由 `ConnectionOrchestrator` 负责（有限次指数退避，默认 3 次）。

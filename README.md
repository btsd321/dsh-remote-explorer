# dsh_remote_ssh

DeepSeek Harness 远程主机开发插件——基于 dsh-ssh provider 家族，在之上提供跨平台连接、自动引导、主机档案管理、连接编排、远程工作区适配和 Web GUI 能力。

## 功能

- **跨平台 SSH 连接**：基于 ssh2 纯 JS 库，支持 Windows/Linux/macOS 客户端连接 POSIX 远程主机
- **全自动远端引导**：自动检测、安装 Node 运行时，上传 harness helper 及所有依赖（含 native stub）
- **代理配置**：支持远端 HTTP 代理（用于被墙环境下载 Node 等）
- **主机档案管理**：持久化远程主机配置，密钥通过文件路径引用不落明文
- **连接编排状态机**：可观测的连接生命周期（disconnected → connecting → verifying → ready → reconnecting → lost）
- **断线检测与自动重连**：有限次指数退避自动重连 + 手动重连
- **连接历史记录**：记录连接开始/结束时间、断开原因
- **远程工作区适配**：通过 helper RPC 实现远端 realpath/stat/listDir/readText
- **Web GUI**：主机面板、连接向导、状态徽标、远端文件浏览器、操作日志、连接历史

## 架构

```
┌─ Web GUI (client/index.html) ───────────────────┐
│  主机面板 │ 连接向导 │ 远端文件浏览器 │ 连接历史 │
└────────────────────┬───────────────────────────┘
                     │ WebSocket JSON-RPC
┌─ Host: API Controller + Bridge ─────────────────┐
│  CRUD/探测/引导/连接/重连/历史/远端文件操作      │
└────────────────────┬───────────────────────────┘
                     │ Ssh2Connection RPC
┌─ 远端 Helper (dsh-ssh) ─────────────────────────┐
│  fs.resolve/stat/list/readText + process.*      │
└─────────────────────────────────────────────────┘
```

## 模块

| 模块 | 文件 | 职责 |
|---|---|---|
| 跨平台 SSH 连接 | `src/ssh2-connection.ts` | 基于 ssh2 的连接，RPC 通道，TLS-PSK 流认证 |
| 远端环境引导器 | `src/remote-bootstrap.ts` | 探测 Node、自动安装、上传 helper 和依赖、代理支持 |
| 主机档案注册表 | `src/remote-hosts.ts` | CRUD + 持久化，密钥引用，代理配置 |
| 连接编排状态机 | `src/remote-connection.ts` | 引导→连接→就绪→断开，断线检测，自动重连，连接历史 |
| 依赖收集器 | `src/dependency-collector.ts` | 递归收集 helper 的所有传递依赖 |
| 原生插件 stub | `src/native-stub.ts` | node-addon-system 的 no-op 替代 |
| 远程工作区适配 | `src/remote-workspace.ts` | 通过 helper RPC 实现远端 realpath/stat/listDir |
| API controller | `src/api/remote-host-controller.ts` | 远程主机管理 API（含远端文件操作） |
| WebSocket 桥接 | `src/api/websocket-bridge.ts` | WebSocket JSON-RPC 桥接服务 |
| API 类型定义 | `src/api/types.ts` | 请求/响应类型 |
| 协议 schema | `src/schemas.ts` | helper RPC 返回值的 Zod schema |

## 使用

```bash
# 1. 启动演示服务
npx tsx tests/start-demo.cjs --helperDir /path/to/dsh-ssh/lib/bundle

# 2. 在浏览器打开
# http://127.0.0.1:18900?helperDir=/path/to/dsh-ssh/lib/bundle

# 3. 在 Web GUI 中：
#    - 新增远程主机（填写地址/用户/密钥/工作目录/代理）
#    - 点击"自动引导"（自动装 Node + 上传 helper）
#    - 点击"连接"
#    - 连接就绪后浏览远端目录、查看文件
```

## 编程接口

```typescript
import { RemoteHostRegistry, RemoteBootstrap, ConnectionOrchestrator, RemoteWorkspaceAdapter } from './src/index.js';

// 1. 创建主机档案
const registry = new RemoteHostRegistry();
const profile = registry.create({
  title: 'My Server', host: '192.168.1.82', port: 22,
  username: 'user', privateKeyPath: '~/.ssh/id_rsa',
  workspace: '/home/user/projects',
  proxy: 'http://127.0.0.1:18890', // 可选
});

// 2. 全自动引导
const bootstrap = new RemoteBootstrap();
const result = await bootstrap.bootstrap(profile, '/path/to/dsh-ssh/lib/bundle');
registry.update(profile.id, { node: result.node, helper: result.helper, helperHash: result.helperHash });

// 3. 连接编排
const orchestrator = new ConnectionOrchestrator();
orchestrator.on('stateChange', (e) => console.log(e.state, e.message));
const hello = await orchestrator.activate(profile, '/path/to/dsh-ssh/lib/bundle');

// 4. 远程工作区操作
const adapter = new RemoteWorkspaceAdapter(orchestrator.activeConnection);
const entries = await adapter.listDir(await adapter.realpath('/home/user'));
const content = await orchestrator.activeConnection.request('fs.readText', { target: { targetKey: path, displayPath: path } }, z.string());

// 5. 断开
await orchestrator.deactivate();
```

## 测试

```bash
npx tsx tests/test-connect.cjs          # SSH 连接 + SFTP
npx tsx tests/test-bootstrap.cjs        # 全自动引导
npx tsx tests/test-direct-connect.cjs    # 直接连接 + RPC
npx tsx tests/test-e2e.cjs               # 端到端连接编排
npx tsx tests/test-remote-workspace.cjs  # 远程工作区适配
npx tsx tests/start-demo.cjs             # 演示服务
node tests/test-ws-client.cjs            # WebSocket 客户端
node tests/test-remote-api.cjs           # 远端文件操作 API
```

## 测试环境

已在 OrangePI（aarch64 Linux, 192.168.1.82）上验证：
- Windows → ARM64 Linux SSH 连接 + SFTP
- 全自动引导（Node v22.20.0 + helper + 588 依赖文件）
- helper hello 握手 + RPC executable 查找
- 远端目录浏览（45 个条目）+ 文件读取（.bashrc 3771 字节）
- 连接状态机全流程 + 断线重连 + 连接历史

# dsh_remote_ssh

DeepSeek Harness 远程主机开发插件——基于 dsh-ssh provider 家族，在之上提供跨平台连接、自动引导、主机档案管理和连接编排能力。

## 功能

- **跨平台 SSH 连接**：基于 ssh2 纯 JS 库，支持 Windows/Linux/macOS 客户端连接 POSIX 远程主机
- **全自动远端引导**：自动检测、安装 Node 运行时，上传 harness helper 及所有依赖
- **代理配置**：支持远端 HTTP 代理（用于被墙环境下载 Node 等）
- **主机档案管理**：持久化远程主机配置，密钥通过文件路径引用不落明文
- **连接编排状态机**：可观测的连接生命周期（disconnected → connecting → verifying → ready → lost）

## 架构

插件作为 `packages/ssh/` 之上的产品编排层，不替换现有 provider，而是按 `RemoteHostProfile` 动态组装 `dsh-ssh + fs-ssh + subprocess-ssh + sandbox-ssh` 的 cordis 子树。

```
┌─ 客户端 (Web/Headless) ─────────────────────────┐
│  主机管理面板 │ 连接向导 │ 远程目录选择器        │
└────────────────────┬───────────────────────────┘
                     │ Remote API
┌─ Host: dsh-remote-ssh 编排层 ────────────────────┐
│ A. 主机档案注册表   ctx.remoteHosts             │
│ B. 远端环境引导器   ctx.remoteBootstrap          │
│ C. 连接编排/状态机  ctx.remoteConnection         │
│ D. 远程工作区适配   (复用 workspace/files)       │
│ E. 前端 client 模块                             │
└────────────────────┬───────────────────────────┘
                     │ 动态组装 cordis 子树
┌─ 现有 provider（不动）─────────────────────────┐
│ dsh-ssh │ dsh-fs-ssh │ dsh-subprocess-ssh │ sandbox-ssh │
└─────────────────────────────────────────────────┘
```

## 模块

| 模块 | 文件 | 职责 |
|---|---|---|
| 跨平台 SSH 连接 | `src/ssh2-connection.ts` | 基于 ssh2 的连接，RPC 通道，TLS-PSK 流认证 |
| 远端环境引导器 | `src/remote-bootstrap.ts` | 探测 Node、自动安装、上传 helper 和依赖 |
| 主机档案注册表 | `src/remote-hosts.ts` | CRUD + 持久化，密钥引用 |
| 连接编排状态机 | `src/remote-connection.ts` | 引导→连接→就绪→断开的生命周期管理 |
| 依赖收集器 | `src/dependency-collector.ts` | 递归收集 helper 的所有 npm 依赖 |
| 原生插件 stub | `src/native-stub.ts` | node-addon-system 的 no-op 替代 |
| 协议 schema | `src/schemas.ts` | helper RPC 返回值的 Zod schema |

## 使用

```typescript
import { RemoteHostRegistry, RemoteBootstrap, ConnectionOrchestrator } from '@deepseek-ai/dsh-remote-ssh';

// 1. 创建主机档案
const registry = new RemoteHostRegistry();
const profile = registry.create({
  title: 'My Server',
  host: '192.168.1.82',
  port: 22,
  username: 'user',
  privateKeyPath: '~/.ssh/id_rsa',
  workspace: '/home/user/projects',
  proxy: 'http://127.0.0.1:18890', // 可选：远端代理
});

// 2. 全自动引导（安装 Node + 上传 helper）
const bootstrap = new RemoteBootstrap();
const result = await bootstrap.bootstrap(profile, '/path/to/dsh-ssh/lib/bundle');
registry.update(profile.id, { node: result.node, helper: result.helper, helperHash: result.helperHash });

// 3. 连接编排
const orchestrator = new ConnectionOrchestrator();
orchestrator.on('stateChange', (event) => console.log(event.state, event.message));
const hello = await orchestrator.activate(profile, '/path/to/dsh-ssh/lib/bundle');

// 4. 使用连接
const conn = orchestrator.activeConnection;
const lsPath = await conn.request('executable', { command: 'ls' }, z.string());

// 5. 断开
await orchestrator.deactivate();
```

## 测试

```bash
# 需要配置测试主机
npx tsx tests/test-connect.cjs      # 测试 SSH 连接
npx tsx tests/test-bootstrap.cjs    # 测试全自动引导
npx tsx tests/test-e2e.cjs          # 测试端到端连接
```

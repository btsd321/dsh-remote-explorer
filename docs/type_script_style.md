# TypeScript 编程规范（AI 编程约定）

本文档是 `dsh-remote-ssh` 仓库的代码风格与工程约定。AI 与人类开发者写任何 TypeScript 代码前都应遵循本规范。

核心原则：**模块化、工程化、注释完备**。新代码要读起来像仓库里已有的代码，而不是像另一个人写的。

---

## 一、注释规范

注释一律用**中文**。注释解释"为什么"和"约束是什么"，不重复代码已经说清楚的"做了什么"。

### 1.1 文件头（必需）

每个 `.ts` 文件开头必须有文件级 JSDoc，包含 `@file` 和 `@description`。`@description` 要写清这个模块在整体架构中的位置和职责边界，而非罗列函数名。

涉及协议、安全、跨模块契约的文件，在 `@description` 之后追加分节说明（流程、约束、兼容性要求）。

```typescript
/**
 * @file 跨平台 SSH 连接模块
 * @description 基于 ssh2 纯 JS 库实现，替代 dsh-ssh 中依赖系统 ssh 命令的实现。
 *              支持 Windows/Linux/macOS 客户端连接 POSIX 远程主机，提供与
 *              dsh-ssh SshConnection 兼容的接口（request/connectStream/dispose/ready）。
 *
 * 安全约束：
 * - 流转发统一叠加 TLS-PSK 认证，PSK 由 helper 每流下发
 * - 协议版本、密码套件不可单方面修改，需与 dsh-ssh 同步
 */
```

插件主入口这类需要被外部理解的模块，额外标注 `@module`。

### 1.2 接口与类型（必需）

接口本身要有 JSDoc 说明用途；**每个字段都要有单行 `/** */` 注释**。不要用 `//` 行注释代替字段文档，前者不会被 IDE 悬浮提示采集。

```typescript
/** 连接历史记录条目 */
export interface ConnectionHistoryEntry {
  /** SSH config Host 别名 */
  hostAlias: string;
  /** 主机地址 */
  hostName: string;
  /** 连接结束时间，仍在连接中时为 null */
  disconnectedAt: string | null;
  /** 结束原因 */
  endReason: 'manual' | 'lost' | 'failed' | null;
}
```

字段含义有歧义时（单位、是否可空、默认值、取值范围）必须在注释里写明：

```typescript
/** 请求超时（毫秒） */
requestTimeoutMs?: number;
/** helper 入口文件的 SHA-256，用于连接时校验；为空串时跳过校验 */
helperHash: string;
```

类型别名同样要有注释：

```typescript
/** 连接状态枚举 */
export type ConnectionState = 'disconnected' | 'connecting' | 'verifying' | 'ready' | 'lost' | 'failed' | 'reconnecting';
```

### 1.3 类（必需）

类的 JSDoc 说明它的职责和设计取舍。设计上有多个要点时用列表展开，让后来者不必读完整个类才知道边界在哪。

```typescript
/**
 * 跨平台 SSH 连接：基于 ssh2 实现，提供与 dsh-ssh SshConnection 兼容的接口。
 *
 * 核心设计：
 * - RPC 通道：ssh2 exec 执行远端 Node helper，stdin/stdout 承载 JSON-RPC
 * - 流转发：ssh2 openssh_forwardOutStream 直连远端 Unix 域套接字，再用 TLS-PSK 认证
 * - 心跳租约：定期 heartbeat 保持 helper 活性
 * - 断线语义：连接丢失后所有挂起操作作废，不自动重连（与 dsh-ssh 一致）
 */
export class Ssh2Connection extends EventEmitter {
```

构造函数参数用 `@param` 标注。公开的 getter 用单行注释说明取值时机：

```typescript
/** 远端 Node 可执行文件路径（helper 就绪后可用） */
get nodeExecutable(): string {
```

### 1.4 函数与方法（必需）

所有函数——包括 `private` 方法和模块内的辅助函数——都要有 JSDoc。公开 API 必须写全 `@param` 和 `@returns`；会抛错的写 `@throws`。

```typescript
/**
 * 解析 Host 别名获取完整连接配置（含递归解析 ProxyJump 跳板机链）
 *
 * ProxyJump 格式："jump1" 或 "jump1,jump2"（多级跳板机，逗号分隔）
 * 每个跳板机别名也会被递归解析（如果它自身也有 ProxyJump）。
 *
 * @param alias - SSH config 中的 Host 别名
 * @returns 含跳板机链的完整配置，未找到返回 undefined
 */
export function resolveHost(alias: string): ResolvedHostWithJump | undefined {
```

一行就说得清的私有方法可以用单行 JSDoc：

```typescript
/** 断言连接仍然打开 */
private assertOpen(): void {
```

`@param` 用 ` - ` 连接参数名和说明，保持全仓库一致。

### 1.5 函数体内注释

关键步骤用编号注释串起流程，让人能顺着读完主干：

```typescript
// 1. 确保 ~/.dsh 目录存在
// 2. 探测并安装 Node
// 3. 上传 helper bundle 文件
```

以下三种情况**必须**写行内注释：

- **绕过常规做法的地方**——写清为什么

  ```typescript
  // 首次尝试时跳过 hash 校验（helperHash 为 undefined 时 Ssh2Connection 不校验）
  // 用单个 SFTP 会话串行上传所有依赖文件，避免并发通道超限
  // 消费 stderr 防止缓冲区满导致 channel 关闭
  ```

- **与外部系统的契约**——写清对方的行为

  ```typescript
  // compute() 用 ignoreCase: true 后键名全小写
  // openssh_forwardOutStream 是 ssh2 的 OpenSSH 扩展：直接连接远端 Unix 域套接字
  ```

- **空的 catch 块**——必须说明为什么可以忽略，不允许留空白 `catch {}`

  ```typescript
  } catch { /* 文件损坏或不存在，用默认值 */ }
  } catch { /* 持久化失败不影响运行时使用 */ }
  ```

---

## 二、模块化

### 2.1 一个文件一个职责

文件名用 kebab-case，名字直接反映职责：`ssh-config-parser.ts`、`dependency-collector.ts`、`remote-workspace-registry.ts`。

单文件超过约 600 行就该考虑拆分。拆分沿职责边界切，不要按"太长了"随意切半。

### 2.2 分层与依赖方向

依赖必须单向向下，不允许反向或环形引用：

```
入口/集成层   index.ts、webgui-integration.ts、remote-directory-picker.ts
门面层        api/remote-host-controller.ts
编排层        remote-connection.ts
传输层        ssh2-connection.ts、remote-bootstrap.ts
基础层        ssh-config-parser.ts、dependency-collector.ts、schemas.ts、native-stub.ts
```

下层不得 import 上层。传输层不感知 Cordis 上下文，基础层不感知连接状态。

### 2.3 导出约定

- 只用**命名导出**，不用 `export default`
- [src/index.ts](../src/index.ts) 是唯一对外 barrel：值用 `export {}`，类型用 `export type {}` 分开写
- 内部辅助函数不导出；仅为测试而导出是不可接受的理由——测试走公开 API

```typescript
export { ConnectionOrchestrator } from './remote-connection.js';
export type { ConnectionState, ConnectionEvent, ReconnectConfig } from './remote-connection.js';
```

### 2.4 导入约定

- `src/` 内的相对导入**一律带 `.js` 后缀**（ESM 要求），即使源文件是 `.ts`
- `tests/` 下的脚本用 `.ts` 后缀（靠 `allowImportingTsExtensions`）
- Node 内置模块带 `node:` 前缀：`node:fs`、`node:path`、`node:crypto`
- 只用于类型的导入写 `import type`
- 导入顺序：第三方 → Node 内置 → 本仓库模块
- 避免运行时动态 `import()`，除非确实要延迟加载重依赖并在注释里说明原因

```typescript
import { Client, type ClientChannel } from 'ssh2';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { collectHelperDependencies } from './dependency-collector.js';
import type { ResolvedHostWithJump } from './ssh-config-parser.js';
```

### 2.5 状态封装

模块级可变状态只用于确实进程唯一的东西（配置缓存、镜像源选择），且必须配套提供刷新/失效函数：

```typescript
let cachedConfig: any[] | undefined;

/** 刷新缓存（文件变更后调用） */
export function refreshConfig(): void {
  cachedConfig = undefined;
}
```

其余状态放进类的 `private` 字段。对外暴露只读视图，不要把可变引用递出去：

```typescript
get history(): readonly ConnectionHistoryEntry[] { return this._history; }
get activeConnection(): Ssh2Connection | undefined {
  return this._state === 'ready' ? this.connection : undefined;
}
```

---

## 三、类型安全

`tsconfig.json` 已开 `strict` + `noImplicitAny`，不要放宽。

- **不用 `any` 逃避类型**。第三方库确实缺类型时，在使用点就近断言并注释说明，不要让 `any` 顺着调用链扩散。当前仓库里 `ssh-config` 相关的 `any` 属于待偿还的技术债，新代码不要照抄这个模式。
- **不用 `@ts-ignore`**；万不得已用 `@ts-expect-error` 并写明原因。
- **不用非空断言 `!` 绕过检查**，改用显式判断并抛出带上下文的错误。
- **可选属性用条件展开**，避免把 `undefined` 显式写进对象（配合 `exactOptionalPropertyTypes` 风格）：

  ```typescript
  ...(target.identityFile ? { privateKeyPath: target.identityFile } : {}),
  ...(jumpHosts.length > 0 ? { jumpHosts: jumpHosts.map(toJumpConfig) } : {}),
  ```

- **联合字面量优先于 enum**：`type NodeMirror = 'official' | 'aliyun' | 'tsinghua' | 'ustc'`
- **枚举值到配置的映射用 `Record` 收口**，新增成员时编译器会提醒补齐：

  ```typescript
  const MIRROR_URLS: Record<NodeMirror, string> = { /* ... */ };
  ```

### 3.1 外部数据必须用 Zod 校验

所有跨进程边界进来的数据（helper RPC 响应、WebSocket 请求、配置文件）都要过 Zod。schema 集中放 [src/schemas.ts](../src/schemas.ts)，模块私有的放模块内。

- 契约明确的用 `.strict()`，拒绝多余字段
- 远端实现可能多带字段的用 `.passthrough()`，并注释说明为什么放宽
- 类型从 schema 推导，不要手写一份再维护两处：`export type Prepared = z.infer<typeof preparedSchema>;`

```typescript
/** fs.stat 响应 schema（完全放宽，远端返回格式可能与本地不同） */
const infoSchema = z.object({}).passthrough();
```

---

## 四、错误处理

- **错误消息用中文**，且必须带定位信息：哪台主机、哪个路径、哪一级跳板机、期望值与实际值。

  ```typescript
  throw new Error(`跳板机 ${i + 1} (${jh.host}:${jh.port}) 连接失败: ${err.message}`);
  throw new Error(`helper 入口文件摘要不匹配：期望 ${helperHash}，实际 ${installedHash}`);
  ```

- **需要携带错误码时定义专用错误类**，并设置 `name`：

  ```typescript
  /** 远端操作错误：保留远端返回的错误码 */
  export class RemoteOperationError extends Error {
    constructor(message: string, readonly code?: string) {
      super(message);
      this.name = 'RemoteOperationError';
    }
  }
  ```

- **`catch (e: unknown)` 后统一归一化**，不要假设捕获到的是 `Error`：

  ```typescript
  const msg = error instanceof Error ? error.message : String(error);
  ```

- **资源释放用 `try/finally`**，失败路径也要清理连接、SFTP 会话、定时器：

  ```typescript
  const sftpSession = await openSftp(client);
  try {
    for (const dep of deps) await upload(sftpSession, dep);
  } finally {
    sftpSession.end();
  }
  ```

- **后台定时器一律 `unref()`**，避免阻止进程退出：

  ```typescript
  this.heartbeat = setInterval(/* ... */, interval);
  this.heartbeat.unref();
  ```

- **有意忽略的 Promise 用 `void` 标注**，表明不是漏写 `await`：`void this.ready.catch(() => {});`

---

## 五、异步

- 一律 `async/await`，不写 `.then()` 链
- 包装回调式 API 时用 `new Promise`，并**同时处理 `error` 事件**，不要只接 `ready`/成功回调
- 事件监听器要成对清理，用 `once` 或在 `finally`/`cleanup` 里 `off`

  ```typescript
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => { client.off('ready', onReady); client.off('error', onError); };
    const onReady = (): void => { cleanup(); resolve(); };
    const onError = (err: Error): void => { cleanup(); reject(err); };
    client.once('ready', onReady);
    client.once('error', onError);
    client.connect(options);
  });
  ```

- 超时用 `AbortSignal.timeout()` / `AbortSignal.any()`，不要自己搭 `setTimeout` 竞速
- 可取消的长操作接受可选 `signal?: AbortSignal` 参数，入口处 `signal?.throwIfAborted()`
- 对远端资源的批量操作默认**串行**；要并发必须确认对方能承受（本仓库 SFTP 上传就是因通道上限而必须串行）

---

## 六、命名与格式

| 对象 | 约定 | 示例 |
|---|---|---|
| 文件 | kebab-case | `remote-workspace-registry.ts` |
| 类 / 接口 / 类型 | PascalCase | `ConnectionOrchestrator`、`ResolvedHostWithJump` |
| 函数 / 变量 / 方法 | camelCase | `resolveHost`、`helperDirPath` |
| 模块级常量 | UPPER_SNAKE_CASE | `HELPER_DIR`、`MIN_NODE_MAJOR` |
| 私有字段 | camelCase；与 getter 同名时前缀 `_` | `private _state` + `get state()` |
| 布尔值 | `is`/`has`/`enabled` 前缀或后缀 | `nodeSufficient`、`hasProxyJump` |

- 缩进 2 空格，单引号，语句末加分号
- 数字字面量用下划线分隔：`30_000`、`64 * 1024 * 1024`
- 用 `===`，不用 `==`
- 默认值用 `??`，不用 `||`（除了确实要把空串一起兜掉的场合）
- 显式写返回类型，包括 `: void`
- 提前 return / continue 收窄分支，避免深层嵌套
- **不要引入魔法数字**。超时、重试次数、版本门槛都提成具名常量放文件顶部：

  ```typescript
  /** 最小 Node 版本要求 */
  const MIN_NODE_MAJOR = 22;
  const MIN_NODE_MINOR = 19;
  ```

---

## 七、工程化约束

1. **无构建步骤。** 插件以 `.ts` 源码被 tsx 直接加载。不要添加 `outDir` 产物、打包流程或产物提交。
2. **改代码后跑类型检查**：`npx -y -p typescript@5.7.3 tsc --noEmit`（本地 `tsc` 目前不可用，原因见 [CLAUDE.md](../CLAUDE.md)）。不要让类型错误总数变多。
3. **新增运行时依赖必须写进 `package.json`**，版本锁定或用窄范围。`node_modules` 里有不等于已声明——`ssh-config` 就是现存的反例。
4. **协议相关常量不可单方面修改**：`SSH_PROTOCOL_VERSION`、帧格式、TLS-PSK 密码套件必须与 dsh-ssh 同步，改动要在注释里标明兼容性影响。
5. **跨平台**：客户端可能是 Windows，远端一定是 POSIX。
   - 不要依赖系统 `ssh`/`scp` 命令，用纯 JS 的 ssh2
   - 构造远端路径用 `/` 字符串拼接，**不要用 `node:path` 的 `join`**（Windows 上会产出反斜杠）
   - 本地路径转远端相对路径时显式 `.replace(/\\/g, '/')`
6. **不落明文凭据**：私钥只以文件路径引用，日志和错误消息不打印密钥、口令、PSK 内容。
7. **落盘配置放 `~/.dsh/` 下**，读取时容错（文件缺失或损坏回落默认值），写入失败不影响运行时。
8. **新增 WebSocket 方法要同步改两处**：`webgui-integration.ts` 的 `handleMethod` 分发表 + `client/remote-explorer.js` 的调用点。
9. **前端脚本无框架无构建**：`client/` 下是原生 JS，保持零依赖，不要引入打包器。
10. **改动连接或引导逻辑后跑一次真实连接测试**（`npx tsx tests/test-quick-connect.ts`）。类型检查通过不等于连得上。

---

## 八、提交信息

中文，一句话说清做了什么。修 bug 用 `修复:` 前缀，重构用 `重构:` 前缀。

```
修复: tryConnect 传空 node/helper/helperHash 导致连接必失败
重构: 直接解析 ~/.ssh/config 管理主机 + 跳板机队列支持
远程目录选择器: SSH 连接就绪时替换 ctx.directoryPicker 为远端列表
```

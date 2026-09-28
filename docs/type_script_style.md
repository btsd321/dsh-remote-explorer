# TypeScript 编程规范（AI 编程约定）

本文档是 `dsh-remote-explorer` 仓库的代码风格与工程约定。AI 与人类开发者写任何 TypeScript 代码前都应遵循本规范。

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
 * @description 在本机监听一个端口，把入站连接经 SSH 通道转到远端 dsh 的 webserver。
 *              监听器跨重连存活：重连只换传输引用，本机端口不变——否则用户
 *              已打开的浏览器标签会全部失效。
 *
 * 安全约束：
 * - 转发监听只绑 127.0.0.1——绑全网卡等于把远端 GUI 挂到网上
 * - raw socket 的 error 监听器必须在任何 destroy 之前挂上，未处理 error 事件会直接掀翻进程
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
/** 反向端口：一经启用随会话固定；复用会话时读回落盘值，不重新生成 */
reversePort: number;
```

类型别名同样要有注释：

```typescript
/** 会话生命周期状态标签 */
export type SessionStateTag = 'idle' | 'connecting' | 'connected' | 'heartbeat-missed' | 'reconnecting' | 'reconnect-failed' | 'reconnect-exhausted' | 'disconnected';
```

### 1.3 类（必需）

类的 JSDoc 说明它的职责和设计取舍。设计上有多个要点时用列表展开，让后来者不必读完整个类才知道边界在哪。

```typescript
/**
 * 正向转发：本机监听 → SSH 通道 → 远端 dsh webserver。
 *
 * 核心设计：
 * - 监听器跨重连存活：只持「当前传输」引用，重连 swapTransport 换引用，本机端口不变
 * - 通道配额：forward/admin 分类配额由 channel-pool 统一管理
 * - 重连语义：心跳统一决策重连，单条失败连接不各自发起
 */
export class LocalForward {
```

构造函数参数用 `@param` 标注。公开的 getter 用单行注释说明取值时机：

```typescript
/** 本机监听端口；`listen()` 之后可用 */
get localPort(): number {
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
// 1. 探测远端环境（OS/架构/家目录）
// 2. 安装 Node 与 dsh（已装则跳过）
// 3. 会话 profile 接入用户级插件仓库
```

以下三种情况**必须**写行内注释：

- **绕过常规做法的地方**——写清为什么

  ```typescript
  // 绝不用 pkill -f：承载命令的 shell 命令行也含该模式，会杀掉自己
  // 池化 SFTP 会话内 4 路并发，不为每个操作新开通道（配额受限）
  // 消费 stderr 防止缓冲区满导致 channel 关闭
  ```

- **与外部系统的契约**——写清对方的行为

  ```typescript
  // compute() 合并 Host * 默认值并递归解析 ProxyJump 链
  // dsh webserver 的 host 只接受 127.0.0.1 与 0.0.0.0，且自身不带 TLS
  ```

- **空的 catch 块**——必须说明为什么可以忽略，不允许留空白 `catch {}`

  ```typescript
  } catch { /* 文件损坏或不存在，用默认值 */ }
  } catch { /* 持久化失败不影响运行时使用 */ }
  ```

---

## 二、模块化

### 2.1 一个文件一个职责

文件名用 kebab-case，名字直接反映职责：`ssh-config-parser.ts`、`channel-pool.ts`、`plugin-store.ts`。

单文件超过约 600 行就该考虑拆分。拆分沿职责边界切，不要按"太长了"随意切半。

### 2.2 分层与依赖方向

依赖必须单向向下，不允许反向或环形引用：

```
入口层        cli/、plugin/、plugin-client/
编排层        session/
能力层        provision/、tunnel/、credential/、handoff/
传输层        transport/
基础层        hosts/、util/
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
get currentTransport(): RemoteTransport | undefined {
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

### 3.1 外部数据必须校验

- **插件 Config 用 schemastery**（`@deepseek-ai/schemastery`，zod 风格 API；dsh loader 拒绝真 zod），全字段给 default（3.18 无 enum/optional API）
- **跨进程边界的其余数据**（远端命令输出、manifest JSON、路由请求体）用校验函数与容错解析：`validateRemoteCwd` 拒绝 MSYS 改写路径、manifest `JSON.parse` 失败回落空清单并说明原因——解析失败要么明确报错要么明确降级，不静默吞掉
- **形状同步靠 `import type`**：面板/路由消费的类型从 `supervisor.ts` / `remote-plugin-store.ts` / `session-manager.ts` 类型导入，编译期强制同步，不手写第二份

---

## 四、错误处理

- **错误消息用中文**，且必须带定位信息：哪台主机、哪个路径、哪一级跳板机、期望值与实际值。

  ```typescript
  throw new Error(`跳板机 ${i + 1} (${jh.host}:${jh.port}) 连接失败: ${err.message}`);
  throw new RemoteError('EXEC_FAILED', `主机 ${hostAlias} 上安装 dsh ${version} 失败：版本不符`, { hostAlias });
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
| 文件 | kebab-case | `plugin-store.ts` |
| 类 / 接口 / 类型 | PascalCase | `SessionSupervisor`、`ResolvedHostWithJump` |
| 函数 / 变量 / 方法 | camelCase | `resolveHost`、`syncSessionManifest` |
| 模块级常量 | UPPER_SNAKE_CASE | `ROUTE_PREFIX`、`DEFAULT_DSH_VERSION` |
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

1. **开发流程无构建步骤。** CLI 形态以 `.ts` 源码经 tsx 直接运行，开发流程不添加 `outDir` 产物。**插件形态是例外**：dsh loader 经纯 ESM import 加载插件、不走 tsx，必须用 `scripts/build-plugin.ts` 的产物（`lib/`，已 gitignore；含 handoff 双入口，产物文本经 define 内联进宿主半 bundle）。分发打包走 `scripts/package.ts`（esbuild 单文件 + 目标平台 Node 二进制），产物落 `dist/` 且已 gitignore——不改变源码运行方式，不提交产物。
2. **改代码后跑类型检查**：`pnpm run typecheck`。不要让类型错误总数变多。
3. **新增运行时依赖必须写进 `package.json`**，版本锁定或用窄范围。`node_modules` 里有不等于已声明——`ssh-config` 就是现存的反例。
4. **协议与命名常量不可单方面修改**：路由前缀（`/api/dsh-remote-explorer`、`/api/dsh-remote-handoff`）、slash 命令名、agent 工具名前缀、handoff 协议版本（`HANDOFF_PROTOCOL_VERSION`）在 `scripts/check-plugin.ts` 都有静态护栏；改动必须同步护栏并在注释里标明兼容性影响（远端旧 bundle 靠协议版本降级只读）。
5. **跨平台**：客户端可能是 Windows，远端一定是 POSIX。
   - 不要依赖系统 `ssh`/`scp` 命令，用纯 JS 的 ssh2
   - 构造远端路径用 `/` 字符串拼接，**不要用 `node:path` 的 `join`**（Windows 上会产出反斜杠）
   - 本地路径转远端相对路径时显式 `.replace(/\\/g, '/')`
6. **不落明文凭据**：私钥只以文件路径引用，日志和错误消息不打印密钥、口令、PSK 内容。SSH 密码（交互输入或 `--password` 传入）只存进程内存：交互提示用 node:readline 加只吞字节的 output 实现不回显（零新依赖），`--password` 是用户显式选择、CLI 打警告但不写日志；JS 字符串不可清零，只能丢弃引用靠 GC（已知限制，注释里如实写明，不假装安全）。
7. **落盘配置放 `~/.dsh/` 下**，读取时容错（文件缺失或损坏回落默认值），写入失败不影响运行时。
8. **新增面板能力同步三处**：`src/plugin/routes.ts` 的 RouteDef、`src/plugin-client/api.ts` 的客户端函数、面板组件；快照形状经 `import type` 从 `supervisor.ts` 共享，编译期强制同步。远端执行的脚本片段（如 plugin-store 的扫描脚本）里所有动态值必须过 `quote()`。
9. **前端脚本无框架无构建**：`client/` 下是原生 JS，保持零依赖，不要引入打包器。
10. **改动传输或引导逻辑后跑一次真实验证**：插件形态 `pnpm exec tsx scripts/dev-plugin.ts --smoke`，CLI 形态真实 `doctor`/`connect`（行为脚本 `tests/stop-remote-on-close.ts`、`tests/sftp-roundtrip.ts`）。类型检查通过不等于连得上。
11. **日志统一使用 `src/util/logger.ts` 的 `createLogger`**。不直接调用 `console.*`。
    每个模块在文件顶部创建日志器：`const log = createLogger('模块名');`，模块名用
    kebab-case 取自文件名。级别语义：debug（开发排查）、info（关键流程节点）、
    warn（可恢复异常/降级）、error（不可恢复失败）。输出格式固定为
    `[时间戳] [级别] [模块] 内容`，便于跨模块日志检索与过滤。
    supervisor 的 `this.push()` 是面板业务日志，不受此约束。

    **后端日志级别约束**：supervisor 面板日志只允许 `info | warn | error | state`
    四种级别，不使用 stage-start/stage-done/stage-skip 等非标准级别。阶段进度
    统一用 info 级别 + `[开始]/[完成]/[跳过]` 文本前缀区分。

    **高频路径日志纪律**：轮询、心跳、定时器等周期性代码路径中，只在状态变化时
    输出 info 日志；重复性诊断信息用 debug 级别（生产环境默认不显示）。避免每轮
    都输出的 info 日志占用日志窗口。一次性事件（连接发起、会话就绪、错误）正常
    使用 info/error。

---

## 八、提交信息

中文，一句话说清做了什么。修 bug 用 `修复:` 前缀，重构用 `重构:` 前缀。

```
修复: 会话 manifest 同步丢模板 base bundles 导致远端 dsh 起不来
重构: 远端插件仓库改用户级，会话经 symlink 接入
远程会话面板: 从 settings.section 迁到侧栏全局面板
```

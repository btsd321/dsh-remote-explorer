# 安装指南

将 dsh-remote-ssh 插件安装到 deepseek-harness 中有三种方式，按推荐程度排列。

---

## 方式一：`dsh plugin add` 正式安装（推荐）

这是 DSH 的标准插件安装方式，插件会被持久化到 profile 中，每次启动自动加载。

### 前提

- deepseek-harness 仓库已 `pnpm install` 完成
- 有 `pnpm` 可用（通过 `pnpm dsh` 从源码运行）

### 步骤

```bash
# 1. 从 deepseek-harness 仓库目录执行
cd D:\Project\deepseek-harness

# 2. 安装插件到 web profile（或 headless profile）
pnpm dsh plugin --profile web add ../dsh_remote_ssh

# 3. 验证安装
pnpm dsh --profile web --dump-config
# 输出中应能看到 "# == @deepseek-ai/dsh-remote-ssh" 层

# 4. 启动
pnpm dsh web
```

### 如果 pnpm 拒绝运行构建脚本

TypeScript 源码包从本地路径安装时，pnpm 可能要求允许构建。在 profile 的 `pnpm-workspace.yaml` 中添加：

```yaml
# ~/.dsh/profiles/web/pnpm-workspace.yaml
packages:
  - .
nodeLinker: hoisted
autoInstallPeers: false
allowBuilds:
  "@deepseek-ai/dsh-remote-ssh": true
```

然后重新执行 `pnpm dsh plugin --profile web add ../dsh_remote_ssh`。

### 卸载

```bash
pnpm dsh plugin --profile web remove @deepseek-ai/dsh-remote-ssh
```

---

## 方式二：`--patch` 临时加载（开发调试用）

不需要 pnpm 安装，每次启动时通过 `--patch` 参数加载插件的 `cordis.patch.yml`。适合开发调试。

### 步骤

```bash
cd D:\Project\deepseek-harness

# headless 模式
pnpm dsh headless --patch ../dsh_remote_ssh/cordis.patch.yml "你的任务"

# web 模式
pnpm dsh web --patch ../dsh_remote_ssh/cordis.patch.yml
```

### 注意

- `--patch` 是临时的，不持久化到 profile
- 每次启动都要加 `--patch` 参数
- 插件的 TypeScript 源码通过 tsx 实时编译，不需要构建

---

## 方式三：放入 profile 的 cordis.patch.yml（持久但不走 pnpm）

直接把插件入口写入 profile 的 `cordis.patch.yml`，不需要 pnpm 安装。

### 步骤

编辑 `~/.dsh/profiles/web/cordis.patch.yml`（默认是空数组 `[]`）：

```yaml
- insert:
    - id: remote-ssh
      name: '@deepseek-ai/dsh-remote-ssh'
      config:
        helperDirPath: D:/Project/deepseek-harness/packages/ssh/ssh/lib/bundle
        wsPort: 18900
        wsHost: 127.0.0.1
```

然后直接启动：

```bash
cd D:\Project\deepseek-harness
pnpm dsh web
```

### 注意

- 需要确保 Node 能解析到 `@deepseek-ai/dsh-remote-ssh` 包——如果 pnpm 未安装它，Loader 找不到包会报错
- 因此这个方式需要配合方式一或方式二使用

---

## 方式四：独立运行（不嵌入 dsh）

如果只想用插件的远程主机管理功能，不嵌入 dsh 的 agent loop，可以直接运行演示服务：

```bash
cd D:\Project\dsh_remote_ssh

# 用 deepseek-harness 的 tsx 运行
npx tsx tests/start-demo.cjs --helperDir D:/Project/deepseek-harness/packages/ssh/ssh/lib/bundle

# 然后在浏览器打开
# http://127.0.0.1:18900?helperDir=D:/Project/deepseek-harness/packages/ssh/ssh/lib/bundle
```

这会启动一个独立的 HTTP + WebSocket 服务，提供 Web GUI 管理远程主机。

---

## 安装后验证

无论哪种方式，安装后都可以验证：

```bash
# 1. 检查插件是否被 Loader 识别
pnpm dsh --profile web --dump-config | findstr remote-ssh

# 2. 启动后检查 WebSocket 服务
# 浏览器打开 http://127.0.0.1:18900

# 3. 运行单元测试（需要 OrangePI 等测试主机）
npx tsx tests/test-connect.cjs
npx tsx tests/test-e2e.cjs
```

---

## 常见问题

### Q: `pnpm dsh plugin add` 报 "Cannot find module" 

A: 确保从 deepseek-harness 仓库目录执行，且 `pnpm install` 已完成。

### Q: TypeScript 源码需要构建吗？

A: 不需要。DSH 的源码启动通过 tsx 实时编译 TypeScript，`--patch` 方式直接加载 `.ts` 文件。正式安装（方式一）也通过 tsx 运行。

### Q: 远端主机需要什么？

A: 只需要 SSH 可达。插件会自动引导（安装 Node + 上传 helper），但需要：
- SSH 认证（密钥或密码）
- 远端是 Linux/macOS（POSIX）
- 如果远端被墙，需要配置代理（见主机档案的 proxy 字段）

# Git 分支管理与提交规范

本文档是 `dsh-remote-explorer` 仓库的 Git 工作流约定。AI agent 与人类开发者在本仓库中创建分支、提交代码、合并变更时**必须**遵循本规范。

---

## 一、分支模型

本项目采用**短生命周期特性分支 + 主干发布**模型（参考 Trunk-Based Development），适配 AI agent 并行协作场景。

### 1.1 长期分支

| 分支 | 用途 | 保护规则 |
|------|------|---------|
| `master` | 发布分支，始终可部署 | 只接受从 `develop` 的 `--no-ff` merge |
| `develop` | 集成分支，所有特性在此汇聚 | 只接受从特性分支的 `--no-ff` merge |

**核心约束：合并方向单向——`develop → master`，禁止反向合并。**

```
特性分支 ──→ develop ──→ master
              ↑
         （唯一入口）
```

- ✅ `git checkout master && git merge develop --no-ff`
- ❌ `git checkout develop && git merge master`（禁止）

当 master 上有 develop 没有的 commit 时（如 hotfix），应通过 cherry-pick 或重新在 develop 上做相同改动来同步，而非反向 merge。

### 1.2 特性分支

命名格式：`<type>/<short-description>`

| 前缀 | 用途 | 示例 |
|------|------|------|
| `feat/` | 新功能 | `feat/wsl-file-transfer` |
| `fix/` | Bug 修复 | `fix/heartbeat-timeout` |
| `refactor/` | 重构（不改行为） | `refactor/session-manager-split` |
| `docs/` | 纯文档更新 | `docs/update-architecture-diagram` |
| `test/` | 纯测试补充 | `test/shell-quote-unit` |
| `chore/` | 构建/工具/配置 | `chore/upgrade-pnpm` |

**生命周期规则：**

1. 从 `develop` 的最新 HEAD 创建：`git checkout develop && git branch <name>`
2. 完成后以 `--no-ff` merge 回 `develop`
3. merge 后立即删除本地特性分支
4. 特性分支**不直接 merge 到 master**
5. 特性分支之间**不互相 merge**——如有依赖，先合并上游分支到 develop，再从 develop rebase

### 1.3 AI Agent 分支约定

AI agent 在本仓库工作时，除遵循上述规则外，还需注意：

1. **每个 agent 任务使用独立分支**：避免多个 agent 在同一分支上并发写入导致冲突
2. **写作用户不重叠**：Lead 分配任务时确保不同 agent 修改的文件集合不相交
3. **agent 不自行 merge 到 develop/master**：agent 完成工作后提交到特性分支，由 Lead 审核并执行 merge
4. **agent 不做反向 merge**：如果 agent 需要同步其他分支的改动，应通知 Lead 处理
5. **特性分支命名加编号**：便于追踪，如 `refactor/smell-1-transport-platform`

### 1.4 git worktree 与 Agent 团队协作

当使用 Agent 团队（Agent Teams）或多 agent 并行协作时，**必须**使用 `git worktree` 为每个 agent 创建独立工作区，而非让多个 agent 共享同一工作目录。

#### 1.4.1 为什么必须用 worktree

多个 agent 共享同一工作目录时，任何一个 agent 执行 `git checkout` 切换分支会**改变整个工作区的分支引用**，导致其他 agent 正在编辑的文件瞬间变成另一分支的内容：

- agent A 正在 `feat/a` 上编辑 `src/cli/main.ts`，agent B 执行 `git checkout develop`，A 的未提交改动可能被覆盖或产生混乱冲突
- 构建产物 `lib/` 与 `node_modules/` 是工作区级状态，分支切换后状态不一致，typecheck 和 build 会给出误导性结果
- 并发 `git checkout` 本身有竞态：索引（index）和 HEAD 的更新不是原子的，两个 agent 同时操作会损坏 `.git/index`

`git worktree` 为每个分支创建**独立的工作目录**，共享同一个 `.git` 仓库（对象库一致、引用独立），从根本上消除上述问题。

#### 1.4.2 worktree 工作流

**Lead 职责（创建 worktree）：**

```bash
# 1. 确认 develop 最新
git checkout develop && git pull

# 2. 为每个 agent 从 develop 创建独立 worktree + 特性分支
#    worktree 放在仓库内部 .worktrees/ 目录下，不写到仓库外
#    （写到仓库同级目录可能因权限不足而失败）
git worktree add .worktrees/agent-a -b feat/agent-a-task develop
git worktree add .worktrees/agent-b -b refactor/agent-b-cleanup develop
```

每个 worktree 是一个独立目录，有自己的工作区、索引和分支引用，但共享 `.git` 对象库。agent 在各自的 worktree 目录里工作，互不干扰。

**Agent 职责（在 worktree 中工作）：**

1. 进入 Lead 指定的 worktree 目录（如 `.worktrees/agent-a`）作为工作目录
2. 在该目录中完成所有编辑、typecheck、build、commit——**不要切换到其他分支**，该 worktree 已绑定你的特性分支
3. 完成后向 Lead 报告 commit hash 与 worktree 路径，**不要自行 merge**

**Lead 职责（收集与合并）：**

```bash
# 1. 在主工作区逐个 review 各 worktree 的提交
git -C .worktrees/agent-a log --oneline develop..HEAD

# 2. 确认无误后，将各特性分支 merge 回 develop
git checkout develop
git merge --no-ff feat/agent-a-task -m "merge: develop ← feat/agent-a-task — <摘要>"
git merge --no-ff refactor/agent-b-cleanup -m "merge: develop ← refactor/agent-b-cleanup — <摘要>"

# 3. 合并完成后清理 worktree（先删工作目录，再删已合并的特性分支）
git worktree remove .worktrees/agent-a
git worktree remove .worktrees/agent-b
git branch -d feat/agent-a-task refactor/agent-b-cleanup
```

#### 1.4.3 worktree 约定

| 约定 | 说明 |
|------|------|
| **worktree 位置** | 放在仓库内部 `.worktrees/` 目录下，命名 `.worktrees/<agent名>`。**不写到仓库外部**——仓库同级目录可能因权限不足导致 `git worktree add` 失败，仓库内部目录始终可读写 |
| 分支来源 | 一律从 `develop` 最新 HEAD 创建，不从 master |
| 单一 agent 归属 | 每个 worktree 只分配给一个 agent，不跨 agent 复用 |
| node_modules | 新 worktree 需独立 `pnpm install`（worktree 不共享 node_modules） |
| 清理 | 合并回 develop 后 Lead 立即 `git worktree remove` 清理，不残留 |
| worktree 目录不提交 | `.worktrees/` 已在 `.gitignore` 中排除，不得提交 |

#### 1.4.4 何时用 worktree，何时不用

| 场景 | 是否用 worktree |
|------|----------------|
| Agent Teams 多 agent 并行修改不同文件 | ✅ 必须用 |
| Lead 单 agent 串行完成全部工作 | ❌ 不用，直接在特性分支工作即可 |
| 两个 agent 修改同一文件（写作用户重叠） | ❌ 不用——应先拆分任务使写作用户不重叠，worktree 解决不了内容冲突 |
| 需要对比两个分支的运行效果 | ✅ 适合用 worktree 并行跑两个版本 |

### 1.5 发布流程

```
develop (稳定) ──merge──→ master ──tag──→ v0.x.y
```

1. 确认 develop 上所有改动已通过 typecheck、单元测试、插件护栏检查
2. `git checkout master && git merge develop --no-ff -m "merge: develop → master — <摘要>"`
3. 如需版本号变更，在 master 上修改 `package.json` 并提交
4. `git tag -a v0.x.y -m "v0.x.y: <发布摘要>"`
5. push master 和 tag

---

## 二、提交规范

采用 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/v1.0.0/) 规范，提交信息一律使用**中文描述**。

### 2.1 格式

```
<类型>(<范围>): <中文描述>

[可选正文]

[可选脚注]
```

### 2.2 类型

| 类型 | 含义 | SemVer 对应 |
|------|------|------------|
| `feat` | 新功能 | MINOR |
| `fix` | Bug 修复 | PATCH |
| `refactor` | 重构（不改外部行为） | — |
| `docs` | 文档更新 | — |
| `test` | 测试增删改 | — |
| `chore` | 构建/工具/配置/依赖 | — |
| `perf` | 性能优化 | PATCH |
| `style` | 代码格式（不影响逻辑） | — |
| `ci` | CI/CD 配置 | — |
| `revert` | 回滚 | — |

### 2.3 范围（scope）

使用模块名或层级名，与项目架构对齐：

| 范围 | 对应模块 |
|------|---------|
| `transport` | src/transport/ |
| `session` | src/session/ |
| `provision` | src/provision/ |
| `credential` | src/credential/ |
| `tunnel` | src/tunnel/ |
| `plugin` | src/plugin/ |
| `plugin-client` | src/plugin-client/ |
| `cli` | src/cli/ |
| `hosts` | src/hosts/ |
| `util` | src/util/ |
| `handoff` | src/handoff/ |
| `scripts` | scripts/ |

省略范围也可以，但当改动集中在单个模块时推荐标注。

### 2.4 描述要求

- 使用中文，简洁明了（≤ 50 字为佳）
- 祈使语气："提取…"、"修复…"、"新增…"，不用"了"、"过"等过去时态助词
- 不以句号结尾
- 首字母不大写（中文无此概念）

### 2.5 正文与脚注

- 正文用空行与标题分隔，解释"为什么"而非"做了什么"
- 破坏性变更必须在标题加 `!` 或在脚注写 `BREAKING CHANGE:`
- 引用 issue/PR 用 `Refs: #123` 脚注

### 2.6 示例

```
refactor(transport): 提取 platform.ts 共享模块，消除 ssh/wsl transport 重复代码

ARCH_MAP、OS_MAP、detectPlatform、buildCommandWithEnv 从两个 transport
实现中提取到共享模块，新增架构或修复平台探测 bug 时只需改一处。

Refs: smell-report #1, #10
```

```
fix(session): 重连时心跳未停止导致配额泄漏

runReconnect 入口处遗漏 heartbeat.stop()，重连期间旧心跳继续占用
admin 通道配额，新连接建立后配额耗尽。

Refs: #287
```

```
feat!(credential): 支持多供应商凭据路由

BREAKING CHANGE: TunnelProxyCredential 构造函数新增 routes 参数，
单供应商初始化方式不再可用。
```

```
docs: 更新架构图反映 smell 修复后的模块结构
```

```
test(util): 为 shell-quote.ts 添加 53 个单元测试

覆盖基本功能、特殊字符、Shell 注入防护、Unicode、边界情况。
```

### 2.7 Merge Commit 格式

merge commit 也遵循约定式提交格式：

```
merge: develop → master — <本次合并的摘要>
```

或带范围：

```
merge(session): develop → master — open() 拆分与凭据下沉
```

---

## 三、Agent 工作流检查清单

AI agent 在本仓库执行代码变更时，按以下清单自检：

### 开始前

- [ ] 确认当前在正确的特性分支上（不在 master/develop 上直接改）
- [ ] 确认特性分支从 develop 最新 HEAD 创建（不从 master 建分支）
- [ ] 确认 Lead 分配的写作用户与其他 agent 不重叠
- [ ] **Agent 团队协作时**：确认 Lead 已为自己分配独立 worktree，且当前工作目录在该 worktree 内（如 `.worktrees/agent-a`），不在主工作区与他人共享

### 工作中

- [ ] 每个逻辑独立的改动单独 commit（不攒大提交）
- [ ] commit message 符合 Conventional Commits 格式
- [ ] 中文描述，注释用中文
- [ ] 运行 `pnpm run typecheck` 确认零错误
- [ ] 涉及 plugin/ 改动时运行 `pnpm exec tsx scripts/check-plugin.ts`
- [ ] 提交前运行 `pnpm exec tsx scripts/build-plugin.ts` 更新 lib/ 构建产物，并将 lib/ 变更一并提交

### 完成后

- [ ] 所有改动已 commit 到特性分支
- [ ] 向 Lead 报告完成状态、commit hash、验证结果
- [ ] **不自行 merge 到 develop 或 master**
- [ ] **不做 master → develop 的反向 merge**
- [ ] **Agent 团队协作时**：报告 worktree 路径，由 Lead 负责合并后清理 worktree（不自行删除 worktree）

---

## 四、禁止事项

| 禁止操作 | 原因 |
|---------|------|
| 直接在 master/develop 上 commit | 所有改动必须经特性分支 |
| 从 master 创建特性分支 | 特性分支只能从 develop 创建；master 仅用于发布合并 |
| master → develop 的 merge | 破坏单向合并规则，产生混乱历史 |
| 特性分支之间互相 merge | 应通过 develop 中转 |
| **Agent 团队协作时在共享工作区切换分支** | 共享工作区切分支会改变所有 agent 看到的文件，必须用 git worktree 隔离 |
| **worktree 创建到仓库外部目录** | 仓库同级目录可能因权限不足导致 `git worktree add` 失败；worktree 必须放在仓库内部 `.worktrees/` 目录下 |
| **worktree 未清理残留** | 合并回 develop 后 Lead 必须立即 `git worktree remove` |
| **提交 `.worktrees/` 目录** | `.worktrees/` 是 worktree 临时工作区，已在 `.gitignore` 中排除 |
| force push 已推送的分支 | 除非 Lead 明确要求重写历史 |
| 使用 `git merge --squash` | 保留完整提交历史，merge 时用 `--no-ff` |
| 提交含 `.claude/`、`.agents/`、`agent/`、`tasks/` 的文件 | 已在 .gitignore 中排除 |
| 提交信息用英文 | 本仓库一律中文 |
| 提交 src/ 改动时不带 lib/ 更新 | lib/ 是构建产物，必须与源码同步提交 |

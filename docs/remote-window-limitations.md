# 桌面浮层（远程窗口）的复制与链接限制

> **状态**：链接与复制均已在本分支实现插件侧修复（待桌面端实机验证）；剪贴板原生权限仍需上游 dsh 壳放行根治。
> **适用版本**：dsh-remote-explorer 0.8.11 + DeepSeek Harness 桌面端 0.2.2-rc.2 ~ 0.2.2-rc.5（Electron 44.7.0，`app.asar` 实测）。
> **适用范围**：桌面端「在新窗口连接」打开的整窗浮层（[remote-window.tsx](../src/plugin-client/remote-window.tsx)）。
> 浏览器形态（「进入（当前标签）」/「新标签打开 ↗」）**不受这两条限制影响**。

## 0. 结论速览

| 能力 | 桌面浮层（修复前） | 浏览器形态 | 根因 |
|---|---|---|---|
| 界面里的复制按钮（代码块、链接/路径右键菜单、JSON） | ❌ 提示「无法复制 / 复制失败」 | ✅ | 桌面壳拒绝 guest 剪贴板权限；前端直调 `writeText` 无降级或抛错不回落 |
| 选中文字 + 系统快捷键 | ✅（原生路径） | ✅ | 与壳的权限策略无关（注：原生右键菜单未挂到 guest，需用 `Cmd/Ctrl+C`） |
| 链接（左键点击 / 右键「外部浏览器打开」） | ❌ 点击无反应 | ✅ 新标签页 | `<webview>` 缺 `allowpopups` 导致 `setWindowOpenHandler` 不触发；此前 `onOpenRequested` 也丢弃非意图 URL |
| 链接（`linkOpening = sidebar`，远端开启 browser tab 时） | ⚠️ 远端右栏 iframe，可能被目标站拒绝嵌入 | 同左 | 目标站 `X-Frame-Options` / CSP（远端未启 browser tab 时会回落 `window.open`） |
| 普通 `<a href>` 跨站导航 | ⚠️ 整个浮层被导航走，远端界面消失 | ✅ 整页跳转（浏览器语义） | `<webview>` DOM `will-navigate` 不可 `preventDefault()`，需 `stop()` + `did-navigate` 兜底 |

两句话版本：

- **复制**：桌面壳给每个 webview guest 的 partition 装了「一律拒绝」的权限策略，dsh 前端与 `open-in-app` 等插件调 `navigator.clipboard.writeText` 被拒后不回落；但远端页面运行着本插件的 `dsh-remote-handoff`，可在同上下文为 `writeText` 补 `execCommand('copy')` 降级。
- **链接**：`<webview>` 未设 `allowpopups` 时 `disablePopups=true` 会直接掐死 guest 的 `window.open`，导致壳的 `guest.setWindowOpenHandler` 根本不触发；且 `<webview>` 的 `will-navigate` 事件不可 `preventDefault()`，跨站导航必须显式 `stop()` 并配 `did-navigate` 兜底。

## 1. 复制

### 1.1 现象

远端浮层里点代码块的「复制」、目录右键「复制路径」、JSON 树的「复制值」等，全部提示「复制失败」（`copy.failed`）。

### 1.2 根因链

```
dsh 前端复制按钮
  └─ navigator.clipboard.writeText(...)          ← 需要 clipboard-write 权限
       └─ 桌面壳 guest partition 的权限策略：
            setPermissionRequestHandler(cb(false))
            setPermissionCheckHandler(() => false)
          → NotAllowedError
       └─ 前端 catch 后直接 return false，不回落 execCommand
  → 弹「复制失败」
```

三处证据：

1. **壳的权限策略**（`app.asar/lib/main.js`）：
   - `acquire()` 在签发 lease 时对每个 workspace 的 partition 调 `configureSession`（约 18105–18111 行）；
   - `configureSession`（约 18233 行）里 `setPermissionRequestHandler` 恒 `callback(false)`、`setPermissionCheckHandler` 恒 `false`、`setDevicePermissionHandler` 恒 `false`。
2. **前端复制实现**：
   - `dsh-web-frontend/dist/assets/index-*.js` 的 `Ss()`（`writeClipboard`，代码块复制、会话 ID 等）：
     ```js
     async function Ss(e){
       if (navigator.clipboard?.writeText)
         try { return await navigator.clipboard.writeText(e), !0 }
         catch { return !1 }            // ← 失败即返回，不落 execCommand
       /* 只有 clipboard API 不存在时才走 textarea + execCommand('copy') */
     }
     ```
   - `dsh-client-ui-open-in-app/lib/client.js`（右键「复制链接地址」「复制文件路径」「复制文件夹路径」）与 `settings-account`、`forge` 等则**直接 `await navigator.clipboard.writeText(...)`**，没有任何降级，失败时弹出「无法复制，请检查内容是否可用后重试」。
3. **壳侧限制与远端 handoff 兜底边界**：壳在 `will-attach-webview` 里清空了 `webPreferences`（只保留 `disablePopups`），因此宿主页确实无法给 `<webview>` 注入 preload 或修改权限策略；但远端页面运行的是本插件引导的远端 dsh，已加载本插件的浏览器半 [`dsh-remote-handoff`](../src/handoff/client.tsx)，与远端前端共享同一 `window` / `navigator` / `document`。

### 1.3 插件侧兜底修复（已在本地实现，待实机验证）

在 [`src/handoff/clipboard-fallback.ts`](../src/handoff/clipboard-fallback.ts) 实现并在 [`src/handoff/client.tsx`](../src/handoff/client.tsx) 激活时挂载（单测见 [`tests/unit/clipboard-fallback.test.ts`](../tests/unit/clipboard-fallback.test.ts)）：

- 包装 `navigator.clipboard.writeText`：始终优先调用原生 `writeText`（浏览器直连等原生已授权场景零改动）；
- 仅在原生 `writeText` 抛错/拒绝（如 `NotAllowedError`）时，降级到离线 `<textarea>` + `document.execCommand('copy')`（并还原原有焦点与选区）；若降级仍失败，重新抛出原始异常；
- 一次性兜住 `open-in-app`（复制链接/路径）与 `writeClipboard`（代码块/会话 ID 等）所有 `writeText` 入口。

> 注意：本改动位于远端 `dsh-remote-handoff` 浏览器半，构建后需**重连一次远端**让 [handoff-installer.ts](../src/provision/handoff-installer.ts) 把新 `client.js` 写回远端 store，再刷新/重开浮层即可生效。

### 1.4 可用替代与上游修复点（dsh 桌面端）

- **替代**：选中文字 + `Cmd/Ctrl+C`（走 Chromium 原生编辑路径；注：`main.js` 的原生 `context-menu` 只挂在主窗口未挂在 guest），或改用浏览器形态。
- **上游根治**（二选一，壳侧放行最彻底）：
  1. **壳侧放行**：`configureSession` 对 `clipboard-sanitized-write` 单独放行：
     ```js
     browserSession.setPermissionRequestHandler((_c, permission, cb) => cb(permission === 'clipboard-sanitized-write'));
     browserSession.setPermissionCheckHandler((_c, permission) => permission === 'clipboard-sanitized-write');
     ```
     只放行「写」不放行「读」，风险面最小。
  2. **前端侧降级**：`Ss()` 与 `open-in-app` 在 `writeText` 抛错时统一走 `textarea + document.execCommand('copy')`。

## 2. 链接

### 2.1 现象

- 点击远端对话里的链接（链接偏好为 `new-tab` 时）**没有任何反应**；
- 或者点一个普通 `<a href>`，整个浮层被导航到目标站，远端 dsh 界面消失，只能重开浮层。

### 2.2 根因链

**路径 A：`window.open`（左键点击链接回落 / 右键「外部浏览器打开」 / `new-tab` 偏好）**

```
远端页面 window.open(url, '_blank', 'noopener,noreferrer')
  ├─ [原因 A1] <webview> 未设 allowpopups → Electron 默认 disablePopups=true
  │    壳在 will-attach-webview 里专门保留了 disablePopups（对比第一方 sidebar-browser 显式设了 allowpopups=""）
  │    → 弹窗在 guest 内直接被掐死，guest.setWindowOpenHandler 根本不触发，browserOpenRequested 从未发出
  └─ [原因 A2] 即使放行到 guest.setWindowOpenHandler（一律 deny 并转发 browserOpenRequested），
       此前插件的 onOpenRequested 回调只处理假意图 origin，其余 URL 被静默丢弃
  → 界面上什么都不发生
```

**路径 B：主框架导航（普通 `<a href>`）**

- Electron 44 `<webview>` 的 DOM 事件 `will-navigate` 是由 `WebViewImpl.dispatchEvent` 用 `new Event(e)`（不可取消、忽略返回值）派发的异步通知，**`event.preventDefault()` 无效**；
- 壳的 guest 侧 `will-frame-navigate` 只拦「非 http(s)」与「应用自身 host」，跨站 http(s) 是放行的；
- 因此仅靠 `preventDefault()` 拦不住跨站导航，整窗仍会被导航走、远端界面消失。

### 2.3 链接偏好背景

- dsh Chat 的 `openExternalLink` 在 `linkOpening === 'sidebar'` **且** `sidebarRightTabs.get('browser')` 存在时才走右侧栏；远端未启用 `browser` 侧栏 tab 时（右键菜单里「在侧边栏打开」置灰），左键点击会直接回落到 `window.open`；
- 右键菜单的「外部浏览器打开」（`open-in-app.url`）与 `linkOpening = new-tab` 也一律走 `window.open`，全部命中路径 A。

### 2.4 插件侧修复（已在本地实现，待实机验证）

1. **补齐 `<webview>` 属性（对齐第一方 `ui-sidebar-browser`）**：显式设置 `name`、`partition`、`allowpopups=""`、`src`，让 guest 的 `window.open` 能进入壳的 `guest.setWindowOpenHandler`（壳仍一律返回 `{ action: 'deny' }`，仅转发合法 http(s) URL 到 `browserOpenRequested`）；
2. **接住 `onOpenRequested`**：先判 handoff 假意图 origin，其余外部 http(s) 调用宿主 `window.open(url, '_blank', 'noopener,noreferrer')` → 命中主窗口 `setWindowOpenHandler` 调 `shell.openExternal` 交系统浏览器打开；
3. **真拦住跨 origin 主框架导航**：`will-navigate` 里用 `element.stop()` 中止导航并外开系统浏览器，并配 `did-navigate` 兜底（若 `stop()` 竞态或 302 重定向已提交外部页面，则 `goBack()` 或 `loadURL(lastSessionUrl)` 拉回远端会话）。

实现落在 [`src/plugin-client/link-policy.ts`](../src/plugin-client/link-policy.ts)（纯函数判据，含单测 [`tests/unit/link-policy.test.ts`](../tests/unit/link-policy.test.ts)）与 [`src/plugin-client/remote-window.tsx`](../src/plugin-client/remote-window.tsx)（`<webview>` 属性与事件接线），不动壳。

## 3. 复现步骤

1. 桌面端打开远程会话面板，选一台主机，「在新窗口连接」；
2. 在远端对话里让模型输出一段带复制按钮的代码块 → 点复制 → 提示「复制失败」；
3. 让模型输出一个 markdown 链接，把 Chat 链接偏好设为 `new-tab` → 点击 → 无反应；
4. 换一个不带 `target` 的普通链接 → 点击 → 浮层被导航走，远端界面消失。

## 4. 修复后的验证清单

- [ ] 代码块复制成功，且剪贴板内容与代码一致；
- [ ] `new-tab` 偏好的链接在系统浏览器打开，浮层保持原状；
- [ ] 普通 `<a href>` 跨站链接同样外开，浮层不消失；
- [ ] 远端页面内同 origin 路由跳转（会话切换、设置页）仍正常，不被误拦；
- [ ] handoff pill 的「返回管理页 / 关闭 / 停止」三个动作不受影响（它们走假意图 origin，必须先于通用外开判断）。

## 5. dsh 升级后如何重新核对

壳的事实都在 `app.asar/lib/main.js`，原生 `grep` 进不去 asar，用运行中的 Electron 以 Node 模式读：

```sh
ELECTRON_RUN_AS_NODE=1 "$DSH_NODE_EXECUTABLE" -e '
const fs=require("node:fs");
const s=fs.readFileSync(process.env.DSH_INSTALL_DIR + "/../../../../lib/main.js","utf8");
for (const t of ["configureSession","setWindowOpenHandler","browserOpenRequested","setPermissionCheckHandler"]) {
  const i = s.indexOf(t);
  console.log(t, i);
}'
```

（路径以实际安装布局为准；桌面端 `DSH_INSTALL_DIR` 指向 `app.asar/dsh/node_modules/@deepseek-ai/dsh`。）

需要确认的四点：

1. `configureSession` 是否仍拒绝全部权限（复制是否已放行）；
2. guest 的 `setWindowOpenHandler` 是否仍只转发、不打开；
3. `will-attach-webview` 是否仍清空 `webPreferences`（决定插件能否注入）；
4. 前端 `Ss()` 是否已加 `execCommand` 降级。

## 6. 相关代码位置

| 位置 | 作用 |
|---|---|
| [src/plugin-client/remote-window.tsx](../src/plugin-client/remote-window.tsx) | 浮层本体：lease、`allowpopups` webview、意图 URL 与跨站导航拦截 |
| [src/plugin-client/link-policy.ts](../src/plugin-client/link-policy.ts) | 链接外开与同 origin 判据 |
| [src/plugin-client/desktop-bridge.ts](../src/plugin-client/desktop-bridge.ts) | 桌面壳 lease 桥（`acquire` / `release` / `onOpenRequested`） |
| [src/handoff/clipboard-fallback.ts](../src/handoff/clipboard-fallback.ts) | 远端页面 `navigator.clipboard.writeText` 的 `execCommand('copy')` 降级 |
| [src/handoff/client.tsx](../src/handoff/client.tsx) | 远端浏览器半入口（挂载剪贴板降级与 handoff pill） |
| `app.asar/lib/main.js` 的 `DesktopBrowserGuests` | 壳的 guest 生命周期：acquire、attach（保留 `disablePopups`）、弹窗策略、权限策略 |
| `app.asar/lib/main.js` 主窗口 `setWindowOpenHandler` | 宿主窗口外开系统浏览器 |
| `dsh-web-frontend/dist/assets/index-*.js` 的 `Ss()` | 前端 `writeClipboard` 实现（抛错不落 `execCommand`） |
| `dsh-client-ui-open-in-app/lib/client.js` | 右键「外部浏览器打开」「复制链接地址/路径」动作实现 |

## 7. 白屏根因与修复（弱网首屏被误判重连截断）

现象：打开远程窗口后是**白屏**（`#root` 为空、`__ModuleLoader__.mode` 停在 `queue`）。

根因链路（弱网环境：高延迟、明显丢包）：

1. dsh 首屏并发拉取 7 个静态资源，gzip 后合计约 2.6MB；弱网下下载耗时很长。
2. 心跳每 5s 发一条 `exec`（`kill -0` + `ss` + `curl`），单次超时 5s。大块 CHANNEL_DATA
   占满单条 SSH TCP 时，心跳 `exec` 排在其后必然超时——但隧道其实仍在正常传数据。
3. 连续 5 次超时被状态机判为断线 → 自动重连 → `forward.swapTransport()` 销毁所有
   活跃转发 socket（[forward-local.ts](../src/tunnel/forward-local.ts) 的 `swapTransport`）。
4. 浏览器对**已失败的 `<script>` 不会重试**：4 个核心 JS 直接 `ERR_INCOMPLETE_CHUNKED_ENCODING`，
   `load` 事件仍触发，浮层撤掉加载层 → 空白 `#root` 永久白屏。

修复（三层）：

- [forward-local.ts](../src/tunnel/forward-local.ts)：记录最近一次转发数据流动时间
  （`lastActivityAt` / `isRecentlyActive()`）。
- [heartbeat.ts](../src/session/heartbeat.ts) + [session-manager.ts](../src/session/session-manager.ts)：
  心跳结果区分 `remote-down` / `timeout` / `link-error`；**仅当 `timeout` 且转发近期活跃时
  视为链路健康**，不累加断线（`remote-down` / `link-error` 照常计数）。同时心跳超时 5s→15s。
- [ssh-transport.ts](../src/transport/ssh-transport.ts)：keepalive 连续失败上限 3→6（60s 容忍）。
- [remote-window.tsx](../src/plugin-client/remote-window.tsx)：首屏渲染看门狗——主文档 load 后
  轮询 guest 的 `#root` 是否有内容，渲染出来才撤加载层；`did-fail-load` 或长时间空白给出
  「重试」入口，不再把空白 `#root` 直接亮成白屏。

验证：弱网真实链路 + headless Chrome，加载全程 `reconnectTriggers=0`，`#root` 有内容、
`__ModuleLoader__.mode` 由 `queue` 变 `live`，首屏正常渲染。

/**
 * @file 桌面浮层顶部让位值的计算
 * @description 桌面壳（DeepSeek Harness Electron）在 Windows 上是无边框 + 原生 caption
 *              浮层（titleBarStyle:'hidden' + titleBarOverlay{height:40}），最小化/最大化/
 *              关闭按钮由 Electron 画在网页之上；macOS 是 hiddenInset + 红绿灯浮在左上。
 *              「打开会话」走的 body 级浮层（remote-window.tsx）若从 y=0 铺满整窗，会压住
 *              远端页面右上角控件（Windows）/ 左上角控件（macOS），也盖住宿主自己的
 *              caption 行（侧栏开关 + 应用/编辑菜单 + 可拖拽区），窗口无法拖动。
 *
 *              本模块算出浮层顶部要让出的 CSS 长度（窗口 chrome 在顶部占据的带宽），供
 *              remote-window.tsx 写进容器的 `top` 样式。
 *
 * 让位值来源（优先吃 dsh 本体发布在根元素上的 CSS 变量，详见
 * packages/client/ui-layout/src/client/AppFrame.module.css）：
 * - `--dsh-frame-chrome-top`：语义即「窗口 chrome 在顶部占据的带宽」，且**全屏时归零**
 *   （全屏隐藏原生窗口控件，无需让位）。Windows 下等于 `--dsh-windows-titlebar-height`
 *   （=40px）；macOS 下 dsh 不发布此变量。
 * - `--dsh-frame-top-clearance`：macOS 下发布 48px。**全屏时不归零**（陈旧，不能单独依赖），
 *   只作为 macOS 非全屏场景在 chrome-top 缺失时的回退。
 *
 * 关键设计：top 值用 CSS `var()` 链直接写进 cssText，而不是用 JS 读计算值——`var()` 会随
 * 全屏切换自动重算，JS 读到的是挂载瞬间的快照，用户切全屏就失效。只有 dsh 没发布这两个
 * 变量（老版本 dsh 或纯网页形态）时，才按根元素的平台标记回退硬编码值。
 */

/** dsh 本体发布的「窗口顶部 chrome 带宽」变量名（全屏时归零，首选来源） */
const CSS_VAR_CHROME_TOP = '--dsh-frame-chrome-top';
/** dsh 本体发布的「顶部让位」变量名（macOS 下 48px，全屏不归零，仅作 chrome-top 缺失时回退） */
const CSS_VAR_TOP_CLEARANCE = '--dsh-frame-top-clearance';

/**
 * 优先走 dsh 变量链时的返回值。写成常量便于测试断言，也便于阅读时一眼看出整条回退链：
 * chrome-top 缺失则回退 top-clearance，都缺失则 0px。CSS 层随全屏切换自动重算，无需 JS 介入。
 */
const VAR_CHAIN = 'var(--dsh-frame-chrome-top, var(--dsh-frame-top-clearance, 0px))';

/** macOS 回退值：ui-sidebar 内部顶条高度 52px（dsh 自己发布 48px，此处按用户拍板用 sidebar 顶条高度） */
const MACOS_FALLBACK = '52px';
/** Windows 非全屏硬编码回退：等于 dsh 发布的 --dsh-windows-titlebar-height（titleBarOverlay.height） */
const WINDOWS_FALLBACK = '40px';
/** 全屏或无平台标记时的回退：全屏无原生窗口控件，纯网页形态无 chrome */
const ZERO_FALLBACK = '0px';

/**
 * 浮层顶部让位值的最小读取面。
 *
 * dsh 把上述 CSS 变量与平台标记都发布在**根元素**上（原注释明确说「Declared on the root
 * element rather than the frame so overlays portalled to document.body inherit it too」——
 * 正是本模块这种 body 级浮层的用法）。本接口只取计算这两个变量与查标记所需的最小面，
 * 而非真 `HTMLElement`，这样纯 Node 环境下单测可直接构造假对象测试，零新增依赖。
 *
 * `document.documentElement` 结构上满足本接口，故 remote-window.tsx 传真实根元素时类型通过。
 */
export interface OverlayRoot {
  /** 读取根元素上的 CSS 自定义属性已解析值（语义同 getComputedStyle(root).getPropertyValue） */
  getComputedStyleValue(name: string): string;
  /** 根元素是否存在某 data-* 标记（语义同 Element.hasAttribute） */
  hasDataAttribute(name: string): boolean;
  /** 根元素的 dataset.platform 值（无则 undefined） */
  readonly platform: string | undefined;
}

/**
 * 把真实 `document.documentElement` 适配成本模块的窄读取面。
 *
 * 放在本模块而非 remote-window.tsx，是因为这里集中了「变量名怎么拼」的知识，调用方无需关心。
 *
 * @param root - 文档根元素（document.documentElement）
 * @returns 适配后的读取面
 */
export function adaptOverlayRoot(root: HTMLElement): OverlayRoot {
  // 每次调用都重取 computed style：getComputedStyle 返回的是实时 CSSStyleDeclaration，
  // 全屏切换后属性值会变，复用挂载瞬间的旧引用会读到陈旧值
  return {
    getComputedStyleValue(name: string): string {
      return window.getComputedStyle(root).getPropertyValue(name);
    },
    hasDataAttribute(name: string): boolean {
      return root.hasAttribute(name);
    },
    get platform(): string | undefined {
      return root.dataset.platform;
    },
  };
}

/**
 * 计算浮层顶部要让出的 CSS 长度值（窗口 chrome 占据的带宽）。
 *
 * 行为：
 * 1. 若 `--dsh-frame-chrome-top` 或 `--dsh-frame-top-clearance` 中**任一**在根元素上已解析出
 *    非空值 → 返回 `var()` 回退链字符串（保留 CSS 层的响应式，全屏自动归零，不读快照）。
 * 2. 否则（老版本 dsh 没发布这两个变量，或纯网页形态）→ 按根元素的平台标记回退硬编码：
 *    - 有 `data-windows-titlebar` 属性 → `'40px'`
 *    - `dataset.platform === 'darwin'` → `'52px'`
 *    - 其余 → `'0px'`
 *    存在 `data-fullscreen` 属性时，硬编码回退路径一律返回 `'0px'`（全屏无原生控件）。
 *    走 `var()` 链那条路径不需要单独处理全屏——CSS 自己会把 chrome-top 归零。
 *
 * @param root - 根元素读取面（由 adaptOverlayRoot(document.documentElement) 构造）
 * @returns 可直接写进 `top:` 的 CSS 值字符串
 */
export function overlayTopInset(root: OverlayRoot): string {
  // 1. dsh 发布了任一变量 → 走 var() 链，让 CSS 层随全屏切换自动重算（不读 JS 快照）
  const chromeTop = root.getComputedStyleValue(CSS_VAR_CHROME_TOP).trim();
  const topClearance = root.getComputedStyleValue(CSS_VAR_TOP_CLEARANCE).trim();
  if (chromeTop !== '' || topClearance !== '') {
    return VAR_CHAIN;
  }

  // 2. dsh 没发布变量（老版本 / 纯网页形态）→ 按平台标记回退硬编码
  if (root.hasDataAttribute('data-fullscreen')) {
    // 全屏隐藏原生窗口控件，无需让位（这条分支只在没有变量可吃时才走到，
    // 有变量时全屏归零由 CSS 层 chrome-top:0px 负责，不需要这里处理）
    return ZERO_FALLBACK;
  }
  if (root.hasDataAttribute('data-windows-titlebar')) {
    return WINDOWS_FALLBACK;
  }
  if (root.platform === 'darwin') {
    // dsh 自己在 macOS 发布的 clearance 是 48px；此处 52px 是 ui-sidebar 内部顶条高度，
    // 由用户明确指定为回退值。真机上 macOS 会拿到 dsh 发布的变量走 var() 链（48px），
    // 不会用到这个回退——只有老版本 dsh 既不发布变量、又标了 darwin 时才命中此分支。
    return MACOS_FALLBACK;
  }
  return ZERO_FALLBACK;
}

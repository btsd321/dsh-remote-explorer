/**
 * @file 远端窗口交接（handoff）协议常量与类型
 * @description 会话级远端组件的契约中心：合成包名、两端路由前缀、协议版本与
 *              本机管理回调的形状。宿主半（远端 dsh 内）、浏览器半（远端页面）、
 *              本机反向代理与监督器四方共用本模块，改契约只改这里。
 *
 * 通道拓扑（VS Code「管理权在远端窗口内」的等价实现）：
 *
 * ```
 * 远端页面 ──同源──▶ 远端 dsh 的 /api/dsh-remote-handoff/*（host.ts 注册，
 *   （浏览器）       dsh 自身 Cookie 鉴权）──反向隧道──▶ 本机代理 /manage/*
 *                                                  （令牌鉴权）──进程内──▶ 监督器
 * ```
 *
 * 本机管理页地址（managerUrl）由面板在发起连接时随请求带来——CLI 形态没有
 * 管理页，meta 里该字段缺省，远端菜单据此降级为只读。
 */

/** 合成包名：引导期写进会话 profile 的 node_modules，随包发布产物一起落盘 */
export const HANDOFF_PKG_NAME = 'dsh-remote-handoff';

/** 远端组件宿主半在远端 dsh 注册的同源路由前缀（check-plugin 护栏盯守） */
export const HANDOFF_ROUTE_PREFIX = '/api/dsh-remote-handoff';

/** 本机反向代理为远端组件开出的管理路由前缀（与 LLM 路由同令牌闸门） */
export const MANAGE_PREFIX = '/manage';

/**
 * 交接协议版本：远端菜单与本机构造器各持一份（构建期同源注入）。
 * 不一致时远端菜单降级只读——老会话的旧 bundle 不会误读新响应形状。
 */
export const HANDOFF_PROTOCOL_VERSION = 1;

/**
 * 本机管理回调：监督器提供闭包，经 openSession 选项桥接进反向代理。
 *
 * 返回值必须是可 JSON 序列化的快照形状；监督器侧负责裁剪（不含日志尾、
 * 不含远端访问 URL——日志走 log 操作增量拉取）。
 */
export interface ManageHandlers {
  /** 单个会话的状态快照；无此会话时抛监督器错误（代理侧转 404 JSON） */
  state(sessionId: string): unknown;
  /** 自 since 之后的增量日志 */
  log(sessionId: string, since: number): unknown;
  /** 交接元信息：managerUrl / protocolVersion / packageVersion */
  meta(): unknown;
}

/** meta 操作的响应形状（远端浏览器半按此判级与渲染动作组） */
export interface HandoffMeta {
  /** 本组件所属会话的 id（每会话一个远端 dsh，监督器填登记项） */
  sessionId: string;
  /** 本机管理页 origin；CLI 形态缺省 */
  managerUrl?: string;
  /** 本机构造器持有的交接协议版本 */
  protocolVersion: number;
  /** 本机插件包版本（诊断展示） */
  packageVersion: string;
}

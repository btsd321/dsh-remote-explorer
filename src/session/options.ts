/**
 * @file 会话选项契约
 * @description openSession / RemoteSession.close 消费的选项契约与传输类型
 *              标识。原定义在 session-manager.ts，拆分后独立成模块：
 *              session/ 内的传输工厂与 open 流水线各阶段共用同一份类型，
 *              session-manager 顶部 re-export 维持 cli/plugin 既有 import
 *              路径零改动。
 *
 * 安全契约随字段注释走（口令只进进程内存、env 键名校验、回调注入面）——
 * 改字段语义前先读各字段注释里的约束论述。
 *
 * 分层：本文件属编排层（session/），向下引用能力层（handoff 协议回调
 * 形状）与基础层（util 的密码提示回调形状）的类型，均为纯类型导入。
 */

import type { ReconnectConfig } from './reconnect.js';
import type { LifecycleConfig, SessionState } from './lifecycle-state.js';
import type { PasswordPromptFn } from '../util/password-prompt.js';
import type { ManageHandlers } from '../handoff/protocol.js';
import type { JumpEntry } from '../hosts/ssh-config-parser.js';

/** 传输类型标识 */
export type TransportType = 'ssh' | 'wsl';

/** 会话打开选项 */
export interface OpenSessionOptions {
  /** 主机别名 */
  hostAlias: string;
  /** 远端工作目录；参与会话 id 计算 */
  remoteCwd: string;
  /** 传输类型；默认 'ssh'（向后兼容） */
  transportType?: TransportType;
  /** WSL 发行版名称（transportType='wsl' 时必需） */
  distroName?: string;
  /** WSL 用户名（transportType='wsl' 时可选） */
  wslUser?: string;
  /** 目标 Node 版本 */
  nodeVersion?: string;
  /** 目标 dsh 版本或 dist-tag */
  dshVersion?: string;
  /** 本机期望端口；0 表示由 OS 分配 */
  localPort?: number;
  /** 强制重新启动远端 dsh，即便既有会话可用 */
  forceRestart?: boolean;
  /** 强制重测镜像 */
  refreshMirrors?: boolean;
  /** 重连配置 */
  reconnect?: Partial<ReconnectConfig>;
  /** 生命周期参数 */
  lifecycle?: Partial<LifecycleConfig>;
  /** 阶段进度回调 */
  onStageStart?: (stage: string) => void;
  /** 阶段完成回调 */
  onStageDone?: (detail?: string) => void;
  /** 阶段跳过回调 */
  onStageSkip?: (reason: string) => void;
  /** 状态变化回调 */
  onStateChange?: (state: SessionState, description: string) => void;
  /**
   * 私钥文件路径覆盖（--private-key）：优先于 config 的 IdentityFile，
   * 只作用于目标主机；跨重连持续生效
   */
  privateKey?: string;
  /**
   * 固定密码（--password）：显式走密码认证，优先于 config 的 IdentityFile。
   * 只存本进程内存，不落盘、不进日志
   */
  password?: string;
  /**
   * 自定义密码提示回调（dsh 插件形态用：密码来自面板表单而非终端）。
   * 优先级 password > promptPassword > 内置终端提示；CLI 不传，行为不变
   */
  promptPassword?: PasswordPromptFn;
  /**
   * 注入远端 dsh 进程的额外环境变量（插件高级选项的环境变量弹窗）。
   *
   * 调用方（插件 supervisor）传入的用户自定义环境变量，键已在读取侧过滤、
   * 进本层后再过一次 assertSafeEnvKeys 校验（键名会直接拼进远端启动命令，
   * 非法键名 = 命令注入）。合并优先级：本层还会把 collectProxyEnv()（本机
   * DSH_REMOTE_PROXY 兜底，最低优先，**仅 SSH 连接**）与
   * credential.remoteEnv()（凭据占位
   * 键如 DEEPSEEK_API_KEY，最高优先）并进同一份注入环境——后者不被它覆盖，
   * 防止用户 env 意外挤掉占位令牌导致远端 dsh 报 MISSING_CREDENTIAL
   */
  extraEnv?: Record<string, string>;
  /**
   * 代理 URL（面板高级选项的代理弹窗，SSH 域「上一次输入」）。
   *
   * 连接时经 collectProxyEnv(explicit) 展开为八个代理键注入远端 dsh，优先级
   * 低于 extraEnv（用户 env 里的同名键可覆盖）、高于 DSH_REMOTE_PROXY 环境
   * 变量兜底；空串/undefined = 未配置。值只存本进程内存与宿主侧 0600 文件，
   * 不进任何日志（连接日志打印时 userinfo 打码，见 connect-summary）。
   * **仅 SSH 连接生效**——WSL 连接无代理层（DSH_REMOTE_PROXY 兜底也被
   * 切断，分流落点在 open-pipeline/tunnels 的 launch）
   */
  proxy?: string;
  /**
   * 直连主机的跳板机条目（面板高级选项的跳板机弹窗）。
   *
   * **仅对 user@host[:port] 直连主机生效**——config 别名主机的跳板机由
   * ~/.ssh/config 的 ProxyJump 决定，此处的值被忽略（分流规则唯一落点在
   * session/transport/factory.ts 的 planJumpHosts）。条目认证覆盖（私钥/
   * 密码）与安全约束见 JumpEntry 的字段注释——**密码只经本请求内存传递，
   * 绝不落盘**（每次连接由用户输入，会话结束丢弃引用）
   */
  jumpHosts?: JumpEntry[];
  /**
   * 转发失败告警回调（插件形态接进会话日志缓冲）。
   * 不传时 LocalForward 直写 stderr（CLI 形态既有行为）
   */
  onForwardError?: (message: string) => void;
  /**
   * 远端 handoff 组件的管理回调（插件形态由监督器提供闭包）。
   * 经反向代理的 `/manage/*` 路由族暴露给远端窗口；CLI 不传，行为不变
   */
  manageHandlers?: ManageHandlers;
}

/** 会话关闭选项 */
export interface CloseSessionOptions {
  /** 是否同时停止远端 dsh 进程；默认 false（保留以便下次复用） */
  stopRemote?: boolean;
}

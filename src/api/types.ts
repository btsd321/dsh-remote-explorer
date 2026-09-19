/**
 * @file 远程主机管理 API 类型定义
 * @description 定义远程主机管理 controller 的请求/响应类型，
 *              供 Remote 装饰器序列化和前端 TypeScript 类型推导使用。
 */

/** 远程主机档案投影（前端可见，不含密钥明文） */
export interface RemoteHostValue {
  /** 唯一标识符 */
  id: string;
  /** 显示名称 */
  title: string;
  /** 远程主机地址 */
  host: string;
  /** SSH 端口 */
  port: number;
  /** 登录用户名 */
  username: string;
  /** 是否已配置私钥路径 */
  hasPrivateKey: boolean;
  /** 远端 Node 路径（引导后填充） */
  node: string;
  /** 远端 helper 路径（引导后填充） */
  helper: string;
  /** 是否已完成引导 */
  bootstrapped: boolean;
  /** 远端默认工作目录 */
  workspace: string;
  /** 是否配置了代理 */
  hasProxy: boolean;
  /** 创建时间（ISO-8601） */
  createdAt: string;
  /** 最后更新时间（ISO-8601） */
  updatedAt: string;
}

/** 创建主机请求 */
export interface RemoteHostCreateRequest {
  /** 显示名称 */
  title: string;
  /** 远程主机地址 */
  host: string;
  /** SSH 端口（默认 22） */
  port?: number;
  /** 登录用户名 */
  username: string;
  /** 私钥文件路径 */
  privateKeyPath?: string;
  /** 私钥口令 */
  passphrase?: string;
  /** 密码 */
  password?: string;
  /** 远端默认工作目录 */
  workspace: string;
  /** 远端 HTTP 代理地址 */
  proxy?: string;
}

/** 创建主机响应 */
export interface RemoteHostCreateValue {
  /** 创建的主机档案投影 */
  host: RemoteHostValue;
  /** 是否为新创建（false 表示已存在同 host+username 的档案） */
  created: boolean;
}

/** 更新主机请求 */
export interface RemoteHostUpdateRequest {
  /** 主机 ID */
  id: string;
  /** 显示名称 */
  title?: string;
  /** SSH 端口 */
  port?: number;
  /** 登录用户名 */
  username?: string;
  /** 私钥文件路径 */
  privateKeyPath?: string;
  /** 私钥口令 */
  passphrase?: string;
  /** 密码 */
  password?: string;
  /** 远端默认工作目录 */
  workspace?: string;
  /** 远端 HTTP 代理地址 */
  proxy?: string;
}

/** 删除主机请求 */
export interface RemoteHostDeleteRequest {
  /** 主机 ID */
  id: string;
}

/** 删除主机响应 */
export interface RemoteHostDeleteValue {
  /** 是否删除成功 */
  deleted: boolean;
}

/** 列出主机响应 */
export interface RemoteHostListValue {
  /** 主机档案列表 */
  hosts: RemoteHostValue[];
}

/** 探测远端环境请求 */
export interface RemoteHostProbeRequest {
  /** 主机 ID */
  id: string;
}

/** 探测远端环境响应 */
export interface RemoteHostProbeValue {
  /** 远端操作系统 */
  os: string;
  /** 远端 CPU 架构 */
  arch: string;
  /** Node 路径（若存在） */
  nodePath: string | null;
  /** Node 版本（若存在） */
  nodeVersion: string | null;
  /** Node 版本是否满足要求 */
  nodeSufficient: boolean;
  /** helper 是否已安装 */
  helperInstalled: boolean;
  /** helper 摘要是否匹配 */
  helperHashMatch: boolean | null;
}

/** 引导远端环境请求 */
export interface RemoteHostBootstrapRequest {
  /** 主机 ID */
  id: string;
  /** 本地 helper bundle 目录路径 */
  helperDirPath: string;
}

/** 引导远端环境响应 */
export interface RemoteHostBootstrapValue {
  /** 远端 Node 路径 */
  node: string;
  /** 远端 helper 路径 */
  helper: string;
  /** helper SHA-256 */
  helperHash: string;
  /** 是否新安装了 Node */
  nodeInstalled: boolean;
  /** 是否新上传了 helper */
  helperUploaded: boolean;
}

/** 连接状态枚举（前端用） */
export type RemoteConnectionStateValue = 'disconnected' | 'connecting' | 'verifying' | 'ready' | 'lost' | 'failed';

/** 连接状态事件 */
export interface RemoteConnectionEvent {
  /** 当前状态 */
  state: RemoteConnectionStateValue;
  /** 状态变化时间戳 */
  timestamp: string;
  /** 状态消息 */
  message?: string;
}

/** 激活连接请求 */
export interface RemoteHostActivateRequest {
  /** 主机 ID */
  id: string;
  /** 本地 helper bundle 目录路径 */
  helperDirPath: string;
}

/** 断开连接请求 */
export interface RemoteHostDeactivateRequest {
  /** 主机 ID */
  id: string;
}

/** 连接状态查询响应 */
export interface RemoteConnectionStatusValue {
  /** 主机 ID */
  hostId: string | null;
  /** 当前连接状态 */
  state: RemoteConnectionStateValue;
  /** 状态消息 */
  message?: string;
}

/**
 * @file dsh-remote-ssh 插件主入口
 * @description DeepSeek Harness 远程主机开发插件入口模块。
 *              基于 dsh-ssh provider 家族，在之上提供跨平台连接、自动引导、
 *              主机档案管理、连接编排、远程工作区适配和 Web GUI 能力。
 *
 * Cordis 插件标准入口：
 * - export const name: 插件名（Loader 诊断用）
 * - export function apply(ctx, config): 插件激活时调用，注册服务和事件
 *
 * 插件功能：
 * 1. 跨平台 SSH 连接（基于 ssh2，支持 Windows 客户端）
 * 2. 远端环境全自动引导（自动装 Node + 上传 helper + 依赖收集 + native stub）
 * 3. 主机档案持久化管理（CRUD + 代理配置）
 * 4. 连接生命周期状态机（disconnected → connecting → verifying → ready → reconnecting）
 * 5. 远程主机管理 API controller（JSON-RPC + WebSocket 桥接）
 * 6. 远程工作区适配（通过 helper RPC 实现远端 realpath/stat/listDir）
 * 7. 远程工作区注册表（持久化 + session 绑定）
 *
 * @module dsh-remote-ssh
 */

import type { Context } from '@deepseek-ai/cordis';
import { RemoteHostController } from './api/remote-host-controller.js';
import { registerWebGuiRoutes } from './webgui-integration.js';
import { installRemoteDirectoryPicker } from './remote-directory-picker.js';
import { installRemoteWorkspaceBridge } from './remote-workspace-bridge.js';
import { installDiagnostics } from './diagnostics.js';

// === 模块导出 ===

export { Ssh2Connection } from './ssh2-connection.js';
export type { Ssh2Config, Hello } from './ssh2-connection.js';
export { RemoteOperationError } from './ssh2-connection.js';

export { RemoteBootstrap } from './remote-bootstrap.js';
export type { RemoteProbe, BootstrapResult } from './remote-bootstrap.js';

export { RemoteHostRegistry, sha256File, sha256Buffer } from './remote-hosts.js';
export type { RemoteHostProfile, CreateHostInput, UpdateHostInput } from './remote-hosts.js';

export { ConnectionOrchestrator } from './remote-connection.js';
export type { ConnectionState, ConnectionEvent, ConnectionHistoryEntry, ReconnectConfig } from './remote-connection.js';

export { RemoteWorkspaceAdapter } from './remote-workspace.js';
export type { RemoteFsInfo, RemoteFsTarget, RemoteDirEntry } from './remote-workspace.js';

export { installRemoteWorkspaceBridge } from './remote-workspace-bridge.js';

export { RemoteWorkspaceRegistry } from './remote-workspace-registry.js';
export type { RemoteWorkspaceRecord, CreateRemoteWorkspaceInput, RemoteWorkspaceValue } from './remote-workspace-registry.js';

export { collectHelperDependencies } from './dependency-collector.js';
export type { DependencyFile } from './dependency-collector.js';

export { createNodeAddonStub } from './native-stub.js';

export { RemoteHostController } from './api/remote-host-controller.js';
export { RemoteHostBridge } from './api/websocket-bridge.js';
export type {
  RemoteHostValue,
  RemoteHostCreateRequest,
  RemoteHostCreateValue,
  RemoteHostUpdateRequest,
  RemoteHostDeleteRequest,
  RemoteHostDeleteValue,
  RemoteHostListValue,
  RemoteHostProbeRequest,
  RemoteHostProbeValue,
  RemoteHostBootstrapRequest,
  RemoteHostBootstrapValue,
  RemoteHostActivateRequest,
  RemoteHostDeactivateRequest,
  RemoteConnectionStatusValue,
  RemoteConnectionEvent,
} from './api/types.js';

export type { SshStreamEndpoint, Prepared, Done } from './schemas.js';

// === Cordis 插件标准入口 ===

/** Cordis 插件名（Loader 诊断用） */
export const name = 'dsh-remote-ssh';

/** 插件配置 schema */
export interface Config {
  /** 本地 helper bundle 目录路径（dsh-ssh 的构建产物） */
  helperDirPath?: string;
  /** SSH config 文件路径（默认 ~/.ssh/config） */
  sshConfigPath?: string;
  /** 远程工作区持久化文件路径 */
  workspacesFilePath?: string;
  /** 自动重连配置 */
  reconnect?: {
    enabled?: boolean;
    maxAttempts?: number;
    initialDelayMs?: number;
    backoffMultiplier?: number;
    maxDelayMs?: number;
  };
}

/**
 * Cordis 插件激活函数。
 *
 * 不再持久化主机档案——主机列表来自 ~/.ssh/config，用户通过编辑 ssh config 管理主机。
 */
export function apply(ctx: Context, config: Config): void {
  // 1. 创建 API controller（直接从 ssh config 解析主机）
  const controller = new RemoteHostController(config.helperDirPath || '');

  // 2. 配置 SSH config 路径
  if (config.sshConfigPath) {
    controller.setSshConfigPath(config.sshConfigPath);
  }

  // 3. 配置自动重连
  if (config.reconnect) {
    controller.configureReconnect(config.reconnect);
  }

  // 4. 注册 ctx 服务
  ctx.provide('remoteHostController', controller);

  // 5. 在 dsh webServer 可用时注册 /remote-ssh 路由
  ctx.inject(['webServer'], (webServerCtx: Context) => {
    registerWebGuiRoutes(webServerCtx, controller, config);
  });

  // 6. 在 directoryPicker 可用时安装远程目录选择器适配
  //    用注入后的 ctx（而非外层 ctx），保证拿到的是已注册该服务的上下文
  ctx.inject(['directoryPicker'], (pickerCtx: Context) => {
    installRemoteDirectoryPicker(pickerCtx, controller);
  });

  // 7. 在 workspaceRegistry 可用时安装远程工作区桥接
  //    让"添加工作区"能接受远端 POSIX 路径（dsh 原实现按宿主平台校验，会拒绝）
  ctx.inject(['workspaceRegistry'], (workspaceCtx: Context) => {
    installRemoteWorkspaceBridge(workspaceCtx, controller);
  });

  // 8. 临时诊断：捕获 agent/error 的原始错误对象并打全栈
  //    定位 ".prepare" 报错用；问题解决后删除 src/diagnostics.ts 及此段
  installDiagnostics(ctx);

  // 9. 在 ctx 销毁时断开 SSH 连接
  ctx.effect(() => () => {
    void controller.connectionOrchestrator.deactivate().catch(() => {});
  });
}

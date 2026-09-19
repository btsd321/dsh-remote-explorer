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
import { RemoteHostBridge } from './api/websocket-bridge.js';
import { RemoteHostRegistry } from './remote-hosts.js';
import { ConnectionOrchestrator } from './remote-connection.js';
import { RemoteWorkspaceRegistry } from './remote-workspace-registry.js';
import { registerWebGuiRoutes } from './webgui-integration.js';

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
  /** WebSocket 服务端口（供前端连接） */
  wsPort?: number;
  /** WebSocket 监听地址 */
  wsHost?: string;
  /** 主机档案持久化文件路径 */
  hostsFilePath?: string;
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
 * 当 Loader 加载此插件时调用，在此：
 * 1. 创建 RemoteHostRegistry（主机档案管理）
 * 2. 创建 RemoteWorkspaceRegistry（远程工作区管理）
 * 3. 创建 RemoteHostController（API controller）
 * 4. 注册 ctx.remoteHostController 服务（供其他插件和前端使用）
 * 5. 如果配置了 wsPort，启动 WebSocket 桥接服务
 * 6. 如果配置了 reconnect，配置自动重连参数
 *
 * @param ctx - Cordis 上下文
 * @param config - 插件配置
 */
export function apply(ctx: Context, config: Config): void {
  // 1. 创建主机档案注册表
  const registry = new RemoteHostRegistry(config.hostsFilePath);

  // 2. 创建远程工作区注册表
  const workspaceRegistry = new RemoteWorkspaceRegistry(config.workspacesFilePath);

  // 3. 创建 API controller（内部持有 ConnectionOrchestrator）
  const controller = new RemoteHostController(registry);

  // 4. 配置自动重连参数
  if (config.reconnect) {
    controller.connectionOrchestrator.configureReconnect(config.reconnect);
  }

  // 5. 注册 ctx 服务（让其他插件和前端通过 ctx.remoteHostController 访问）
  ctx.provide('remoteHostController', controller);
  ctx.provide('remoteWorkspaceRegistry', workspaceRegistry);

  // 6. 如果配置了 WebSocket 端口，启动独立桥接服务（向后兼容）
  if (config.wsPort) {
    const bridge = new RemoteHostBridge(controller, {
      port: config.wsPort,
      host: config.wsHost ?? '127.0.0.1',
    });
    bridge.start();
    ctx.effect(() => () => bridge.stop());
  }

  // 7. 在 dsh webServer 可用时注册 /remote-ssh 路由（让管理页面出现在 dsh Web GUI 中）
  ctx.inject(['webServer'], (webServerCtx: Context) => {
    registerWebGuiRoutes(webServerCtx, controller, config);
  });

  // 8. 在 ctx 销毁时断开 SSH 连接
  ctx.effect(() => () => {
    void controller.connectionOrchestrator.deactivate().catch(() => {});
  });
}

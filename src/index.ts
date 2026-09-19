/**
 * @file dsh-remote-ssh 插件主入口
 * @description DeepSeek Harness 远程主机开发插件入口模块。
 *              基于 dsh-ssh provider 家族，在之上提供跨平台连接、自动引导、
 *              主机档案管理、连接编排和 Web GUI 能力。
 *
 * 插件功能：
 * 1. 跨平台 SSH 连接（基于 ssh2，支持 Windows 客户端）
 * 2. 远端环境全自动引导（自动装 Node + 上传 helper + 依赖收集 + native stub）
 * 3. 主机档案持久化管理（CRUD + 代理配置）
 * 4. 连接生命周期状态机（disconnected → connecting → verifying → ready）
 * 5. 远程主机管理 API controller（JSON-RPC + WebSocket 桥接）
 * 6. Web GUI 演示页面（主机面板/连接向导/状态徽标）
 *
 * @module dsh-remote-ssh
 */

// === 核心连接模块 ===
export { Ssh2Connection } from './ssh2-connection.js';
export type { Ssh2Config, Hello } from './ssh2-connection.js';
export { RemoteOperationError } from './ssh2-connection.js';

// === 远端引导模块 ===
export { RemoteBootstrap } from './remote-bootstrap.js';
export type { RemoteProbe, BootstrapResult } from './remote-bootstrap.js';

// === 主机档案管理 ===
export { RemoteHostRegistry, sha256File, sha256Buffer } from './remote-hosts.js';
export type { RemoteHostProfile, CreateHostInput, UpdateHostInput } from './remote-hosts.js';

// === 连接编排 ===
export { ConnectionOrchestrator } from './remote-connection.js';
export type { ConnectionState, ConnectionEvent } from './remote-connection.js';

// === 依赖收集 ===
export { collectHelperDependencies } from './dependency-collector.js';
export type { DependencyFile } from './dependency-collector.js';

// === 原生插件 stub ===
export { createNodeAddonStub } from './native-stub.js';

// === API controller ===
export { RemoteHostController } from './api/remote-host-controller.js';
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

// === WebSocket 桥接 ===
export { RemoteHostBridge } from './api/websocket-bridge.js';
export type { BridgeConfig } from './api/websocket-bridge.js';

// === 协议 schema ===
export type { SshStreamEndpoint, Prepared, Done } from './schemas.js';

/**
 * 创建插件导出对象。
 * Cordis 插件通过 cordis.yml 加载时调用此函数。
 * @returns 插件公共接口
 */
export function createPlugin() {
  return {
    Ssh2Connection,
    RemoteBootstrap,
    RemoteHostRegistry,
    ConnectionOrchestrator,
    RemoteHostController,
    RemoteHostBridge,
    collectHelperDependencies,
    createNodeAddonStub,
    name: '@deepseek-ai/dsh-remote-ssh',
    version: '0.2.0',
  };
}

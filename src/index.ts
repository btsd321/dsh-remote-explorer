/**
 * @file dsh-remote-ssh 插件主入口
 * @description DeepSeek Harness 远程主机开发插件入口模块。
 *              基于 dsh-ssh provider 家族，在之上提供跨平台连接、自动引导、
 *              主机档案管理和连接编排能力。
 *
 * 插件功能：
 * 1. 跨平台 SSH 连接（基于 ssh2，支持 Windows 客户端）
 * 2. 远端环境全自动引导（自动装 Node + 上传 helper）
 * 3. 主机档案持久化管理
 * 4. 连接生命周期状态机
 * 5. 可与 dsh-ssh provider 家族（fs-ssh/subprocess-ssh/sandbox-ssh）组合使用
 *
 * @module dsh-remote-ssh
 */

// 导出各模块的公共接口
export { Ssh2Connection } from './ssh2-connection.js';
export type { Ssh2Config, Hello } from './ssh2-connection.js';
export { RemoteOperationError } from './ssh2-connection.js';

export { RemoteBootstrap } from './remote-bootstrap.js';
export type { RemoteProbe, BootstrapResult } from './remote-bootstrap.js';

export { RemoteHostRegistry, sha256File, sha256Buffer } from './remote-hosts.js';
export type { RemoteHostProfile, CreateHostInput, UpdateHostInput } from './remote-hosts.js';

export { ConnectionOrchestrator } from './remote-connection.js';
export type { ConnectionState, ConnectionEvent } from './remote-connection.js';

export type { SshStreamEndpoint, Prepared, Done } from './schemas.js';

/**
 * 创建插件导出对象。
 * Cordis 插件通过 cordis.yml 加载时调用此函数。
 * @returns 插件公共接口
 */
export function createPlugin() {
  return {
    Ssh2Connection: Ssh2Connection,
    RemoteBootstrap: RemoteBootstrap,
    RemoteHostRegistry: RemoteHostRegistry,
    ConnectionOrchestrator: ConnectionOrchestrator,
    name: '@deepseek-ai/dsh-remote-ssh',
    version: '0.1.0',
  };
}

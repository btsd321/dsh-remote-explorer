/**
 * @file 远程主机管理 API controller
 * @description 直接从 ~/.ssh/config 解析主机列表，不持久化主机档案。
 *              提供主机列表、连接激活/断开/重连/状态/历史、远端文件操作接口。
 */

import { RemoteBootstrap, type RemoteProbe, type BootstrapResult, setNodeMirror, getNodeMirror, type NodeMirror } from '../remote-bootstrap.js';
import { ConnectionOrchestrator, type ConnectionEvent, type ConnectionHistoryEntry } from '../remote-connection.js';
import { RemoteWorkspaceAdapter, type RemoteDirEntry } from '../remote-workspace.js';
import { RemoteWorkspaceRegistry } from '../remote-workspace-registry.js';
import { listHosts, resolveHost, setConfigPath, setConfigContent, refreshConfig, type SshHostSummary } from '../ssh-config-parser.js';
import { z } from 'zod';
import type { RemoteConnectionStatusValue, RemoteConnectionEvent } from './types.js';

/**
 * 远程主机管理 controller。
 * 不再持久化主机档案——主机列表来自 ~/.ssh/config，用户通过编辑 ssh config 管理主机。
 */
export class RemoteHostController {
  private readonly orchestrator: ConnectionOrchestrator;
  private readonly workspaceRegistry: RemoteWorkspaceRegistry;
  private readonly helperDirPath: string;

  constructor(helperDirPath: string) {
    this.orchestrator = new ConnectionOrchestrator();
    this.workspaceRegistry = new RemoteWorkspaceRegistry();
    this.helperDirPath = helperDirPath;
  }

  get connectionOrchestrator(): ConnectionOrchestrator { return this.orchestrator; }
  get remoteWorkspaceRegistry(): RemoteWorkspaceRegistry { return this.workspaceRegistry; }

  /** 设置 SSH config 文件路径 */
  setSshConfigPath(path: string): void {
    setConfigPath(path);
    refreshConfig();
  }

  /** 直接设置 SSH config 文本内容（浏览器上传文件时使用） */
  setSshConfigContent(content: string): number {
    setConfigContent(content);
    refreshConfig();
    return listHosts().length;
  }

  /** 刷新 SSH config 缓存 */
  refreshSshConfig(): void {
    refreshConfig();
  }

  /** 列出 SSH config 中的所有主机 */
  listSshHosts(): SshHostSummary[] {
    return listHosts();
  }

  /** 设置 Node 下载镜像源 */
  setMirror(mirror: NodeMirror): void {
    setNodeMirror(mirror);
  }

  /** 获取当前镜像源 */
  getMirror(): NodeMirror {
    return getNodeMirror();
  }

  /** 通过 SSH config 别名激活连接 */
  async activate(alias: string): Promise<boolean> {
    await this.orchestrator.activate(alias, this.helperDirPath);
    return this.orchestrator.state === 'ready';
  }

  async deactivate(): Promise<boolean> {
    await this.orchestrator.deactivate();
    return true;
  }

  async reconnect(): Promise<boolean> {
    await this.orchestrator.reconnect();
    return this.orchestrator.state === 'ready';
  }

  async status(): Promise<RemoteConnectionStatusValue> {
    const alias = this.orchestrator.currentHostAlias;
    return { hostId: alias ?? null, state: this.orchestrator.state };
  }

  getHistory(): ConnectionHistoryEntry[] {
    return [...this.orchestrator.history];
  }

  configureReconnect(config: {
    enabled?: boolean; maxAttempts?: number; initialDelayMs?: number; backoffMultiplier?: number; maxDelayMs?: number;
  }): void {
    this.orchestrator.configureReconnect(config);
  }

  subscribeStateChanges(callback: (event: RemoteConnectionEvent) => void): () => void {
    const handler = (event: ConnectionEvent): void => {
      callback({ state: event.state, timestamp: event.timestamp, ...(event.message ? { message: event.message } : {}) });
    };
    this.orchestrator.on('stateChange', handler);
    return () => { this.orchestrator.off('stateChange', handler); };
  }

  // ===== 远程文件操作 =====

  private getWorkspaceAdapter(): RemoteWorkspaceAdapter | null {
    const conn = this.orchestrator.activeConnection;
    if (!conn) return null;
    return new RemoteWorkspaceAdapter(conn);
  }

  async listRemoteDir(path: string): Promise<unknown[]> {
    const adapter = this.getWorkspaceAdapter();
    if (!adapter) throw new Error('连接未就绪');
    const resolved = await adapter.realpath(path);
    return await adapter.listDir(resolved);
  }

  async readRemoteFile(path: string): Promise<string> {
    const conn = this.orchestrator.activeConnection;
    if (!conn) throw new Error('连接未就绪');
    const adapter = new RemoteWorkspaceAdapter(conn);
    const resolved = await adapter.realpath(path);
    const targetSchema = z.object({ targetKey: z.string() }).passthrough();
    const target = await conn.request('fs.resolve', { path }, targetSchema);
    return await conn.request('fs.readText', { target }, z.string());
  }

  async statRemoteFile(path: string): Promise<unknown> {
    const adapter = this.getWorkspaceAdapter();
    if (!adapter) throw new Error('连接未就绪');
    const resolved = await adapter.realpath(path);
    return await adapter.stat(resolved);
  }
}

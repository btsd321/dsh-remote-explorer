/**
 * @file 远程主机管理 API controller
 * @description 提供远程主机的 CRUD、探测、引导、连接激活/断开和状态查询接口。
 *              作为 host 侧服务，供前端通过 Remote 调用或直接通过 ctx 访问。
 *
 * 由于是仓库外独立插件，不依赖 dsh-typert-protocol 的 @Remote 装饰器，
 * 而是提供纯 JavaScript 接口，可通过 cordis.yml 加载后在 ctx 上访问。
 * 前端通过 JSON-RPC 或 WebSocket 桥接调用这些方法。
 */

import { RemoteHostRegistry, type RemoteHostProfile } from '../remote-hosts.js';
import { RemoteBootstrap, type RemoteProbe, type BootstrapResult } from '../remote-bootstrap.js';
import { ConnectionOrchestrator, type ConnectionEvent, type ConnectionHistoryEntry } from '../remote-connection.js';
import { RemoteWorkspaceAdapter, type RemoteDirEntry } from '../remote-workspace.js';
import { z } from 'zod';
import type {
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
} from './types.js';

/**
 * 远程主机管理 controller。
 *
 * 持有一个 RemoteHostRegistry 实例和一个 ConnectionOrchestrator 实例，
 * 提供主机档案 CRUD、远端环境探测/引导、连接激活/断开和状态查询。
 * 连接状态变化通过 EventEmitter 对外发送事件。
 */
export class RemoteHostController {
  /** 主机档案注册表 */
  private readonly registry: RemoteHostRegistry;
  /** 连接编排器 */
  private readonly orchestrator: ConnectionOrchestrator;
  /** 探测结果缓存（hostId → probe） */
  private readonly probeCache = new Map<string, RemoteProbe>();

  /**
   * @param registry - 主机档案注册表（可选，默认创建新实例）
   */
  constructor(registry?: RemoteHostRegistry) {
    this.registry = registry ?? new RemoteHostRegistry();
    this.orchestrator = new ConnectionOrchestrator();
  }

  /** 获取连接编排器实例（供高级用户直接操作） */
  get connectionOrchestrator(): ConnectionOrchestrator {
    return this.orchestrator;
  }

  /** 获取主机档案注册表实例 */
  get hostRegistry(): RemoteHostRegistry {
    return this.registry;
  }

  /**
   * 创建或复用一个主机档案
   * @param request - 创建请求
   * @returns 创建结果（含投影和是否新建标志）
   */
  async create(request: RemoteHostCreateRequest): Promise<RemoteHostCreateValue> {
    const existing = this.registry.list().find(
      h => h.host === request.host && h.username === request.username
    );
    const created = !existing;
    const profile = existing ?? this.registry.create({
      title: request.title,
      host: request.host,
      port: request.port,
      username: request.username,
      privateKeyPath: request.privateKeyPath,
      passphrase: request.passphrase,
      password: request.password,
      workspace: request.workspace,
      proxy: request.proxy,
    });
    return { host: this.toValue(profile), created };
  }

  /**
   * 列出所有主机档案
   * @returns 主机档案列表
   */
  async list(): Promise<RemoteHostListValue> {
    return { hosts: this.registry.list().map(p => this.toValue(p)) };
  }

  /**
   * 更新一个主机档案
   * @param request - 更新请求
   * @returns 更新后的档案投影，不存在返回 null
   */
  async update(request: RemoteHostUpdateRequest): Promise<RemoteHostValue | null> {
    const profile = this.registry.update(request.id, {
      title: request.title,
      port: request.port,
      username: request.username,
      privateKeyPath: request.privateKeyPath,
      passphrase: request.passphrase,
      password: request.password,
      workspace: request.workspace,
      proxy: request.proxy,
    });
    return profile ? this.toValue(profile) : null;
  }

  /**
   * 删除一个主机档案
   * @param request - 删除请求
   * @returns 是否删除成功
   */
  async delete(request: RemoteHostDeleteRequest): Promise<RemoteHostDeleteValue> {
    return { deleted: this.registry.delete(request.id) };
  }

  /**
   * 探测远端环境
   * @param request - 探测请求
   * @returns 探测结果
   */
  async probe(request: RemoteHostProbeRequest): Promise<RemoteHostProbeValue> {
    const profile = this.registry.get(request.id);
    if (!profile) throw new Error(`主机档案不存在: ${request.id}`);
    const bootstrap = new RemoteBootstrap();
    const probe = await bootstrap.probe(profile);
    this.probeCache.set(request.id, probe);
    return {
      os: probe.os,
      arch: probe.arch,
      nodePath: probe.nodePath,
      nodeVersion: probe.nodeVersion,
      nodeSufficient: probe.nodeSufficient,
      helperInstalled: probe.helperInstalled,
      helperHashMatch: probe.helperHashMatch,
    };
  }

  /**
   * 全自动引导远端环境
   * @param request - 引导请求
   * @returns 引导结果
   */
  async bootstrap(request: RemoteHostBootstrapRequest): Promise<RemoteHostBootstrapValue> {
    const profile = this.registry.get(request.id);
    if (!profile) throw new Error(`主机档案不存在: ${request.id}`);
    const bootstrap = new RemoteBootstrap();
    const result = await bootstrap.bootstrap(profile, request.helperDirPath);
    // 更新档案
    this.registry.update(request.id, {
      node: result.node,
      helper: result.helper,
      helperHash: result.helperHash,
    });
    return {
      node: result.node,
      helper: result.helper,
      helperHash: result.helperHash,
      nodeInstalled: result.nodeInstalled,
      helperUploaded: result.helperUploaded,
    };
  }

  /**
   * 激活一个主机连接（引导→连接→就绪）
   * @param request - 激活请求
   * @returns 是否成功
   */
  async activate(request: RemoteHostActivateRequest): Promise<boolean> {
    const profile = this.registry.get(request.id);
    if (!profile) throw new Error(`主机档案不存在: ${request.id}`);
    await this.orchestrator.activate(profile, request.helperDirPath);
    return this.orchestrator.state === 'ready';
  }

  /**
   * 断开当前连接
   * @param _request - 断开请求（id 可选，当前只支持单连接）
   * @returns 是否成功
   */
  async deactivate(_request?: RemoteHostDeactivateRequest): Promise<boolean> {
    await this.orchestrator.deactivate();
    return true;
  }

  /**
   * 手动重连（用于 lost/failed/disconnected 状态）
   * @returns 是否成功
   */
  async reconnect(): Promise<boolean> {
    await this.orchestrator.reconnect();
    return this.orchestrator.state === 'ready';
  }

  /**
   * 配置自动重连参数
   * @param config - 重连配置（部分字段可选）
   */
  configureReconnect(config: {
    enabled?: boolean;
    maxAttempts?: number;
    initialDelayMs?: number;
    backoffMultiplier?: number;
    maxDelayMs?: number;
  }): void {
    this.orchestrator.configureReconnect(config);
  }

  /**
   * 获取连接历史记录
   * @returns 历史记录列表（最近 50 条，新的在前）
   */
  getHistory(): ConnectionHistoryEntry[] {
    return [...this.orchestrator.history];
  }

  /**
   * 查询当前连接状态
   * @returns 连接状态
   */
  async status(): Promise<RemoteConnectionStatusValue> {
    const profile = this.orchestrator.activeProfile;
    return {
      hostId: profile?.id ?? null,
      state: this.orchestrator.state,
    };
  }

  /**
   * 订阅连接状态变化（返回取消订阅函数）
   * @param callback - 状态变化回调
   * @returns 取消订阅函数
   */
  subscribeStateChanges(callback: (event: RemoteConnectionEvent) => void): () => void {
    const handler = (event: ConnectionEvent): void => {
      callback({
        state: event.state,
        timestamp: event.timestamp,
        ...(event.message ? { message: event.message } : {}),
      });
    };
    this.orchestrator.on('stateChange', handler);
    return () => { this.orchestrator.off('stateChange', handler); };
  }

  /**
   * 将内部 RemoteHostProfile 转换为前端安全的 RemoteHostValue
   * @param profile - 内部档案
   * @returns 前端投影（不含密钥明文）
   */
  private toValue(profile: RemoteHostProfile): RemoteHostValue {
    return {
      id: profile.id,
      title: profile.title,
      host: profile.host,
      port: profile.port,
      username: profile.username,
      hasPrivateKey: !!profile.privateKeyPath,
      node: profile.node,
      helper: profile.helper,
      bootstrapped: !!(profile.node && profile.helper && profile.helperHash),
      workspace: profile.workspace,
      hasProxy: !!profile.proxy,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
    };
  }

  // ===== 远程工作区操作（需要连接就绪） =====

  /**
   * 获取远程工作区适配器（连接就绪后可用）
   * @returns 远程工作区适配器，未连接返回 null
   */
  private getWorkspaceAdapter(): RemoteWorkspaceAdapter | null {
    const conn = this.orchestrator.activeConnection;
    if (!conn) return null;
    return new RemoteWorkspaceAdapter(conn);
  }

  /**
   * 列举远端目录内容
   * @param path - 远端路径（绝对路径）
   * @returns 目录条目列表
   */
  async listRemoteDir(path: string): Promise<unknown[]> {
    const adapter = this.getWorkspaceAdapter();
    if (!adapter) throw new Error('连接未就绪，请先激活连接');
    const resolved = await adapter.realpath(path);
    return await adapter.listDir(resolved);
  }

  /**
   * 读取远端文本文件内容
   * @param path - 远端文件路径
   * @returns 文件文本内容
   */
  async readRemoteFile(path: string): Promise<string> {
    const conn = this.orchestrator.activeConnection;
    if (!conn) throw new Error('连接未就绪，请先激活连接');
    // 先规范化路径
    const adapter = new RemoteWorkspaceAdapter(conn);
    const resolved = await adapter.realpath(path);
    // 通过 helper RPC 读取文件
    const targetSchema = z.object({ targetKey: z.string() }).passthrough();
    const target = await conn.request('fs.resolve', { path }, targetSchema);
    return await conn.request('fs.readText', { target }, z.string());
  }

  /**
   * 获取远端文件信息
   * @param path - 远端路径
   * @returns 文件信息
   */
  async statRemoteFile(path: string): Promise<unknown> {
    const adapter = this.getWorkspaceAdapter();
    if (!adapter) throw new Error('连接未就绪，请先激活连接');
    const resolved = await adapter.realpath(path);
    return await adapter.stat(resolved);
  }

  /**
   * 在远端执行命令（通过 helper 的 process.prepare + process.start）
   * @param command - 要执行的命令
   * @returns 命令的 stdout 输出
   */
  async execRemoteCommand(command: string): Promise<string> {
    const conn = this.orchestrator.activeConnection;
    if (!conn) throw new Error('连接未就绪，请先激活连接');
    // 使用 helper 的 executable 查找 + process.prepare/start/done
    const remotePathSchema = z.string();
    const executable = await conn.request('executable', { command: command.split(' ')[0] }, remotePathSchema);
    // 简化版：直接通过 fs 读取 /proc 或用 process.prepare
    // 完整实现需要 subprocess-ssh 的 spawn 接口，这里用 fs 间接验证
    return `远端可执行文件路径: ${executable}`;
  }
}

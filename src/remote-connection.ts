/**
 * @file 连接编排与状态机模块
 * @description 管理 SSH 连接的生命周期状态，直接从 ~/.ssh/config 解析主机配置。
 *              不再依赖 remote-hosts.json 持久化——主机管理完全由 ssh config 文件负责。
 *
 * 状态机：
 *   disconnected → connecting → verifying → ready → lost
 *                                          ↘ failed      ↘ reconnecting → ...
 */

import { EventEmitter } from 'node:events';
import { Ssh2Connection, type Hello } from './ssh2-connection.js';
import { RemoteBootstrap, type BootstrapResult } from './remote-bootstrap.js';
import { resolveHost, type ResolvedHost, type ResolvedHostWithJump } from './ssh-config-parser.js';

/** 连接状态枚举 */
export type ConnectionState = 'disconnected' | 'connecting' | 'verifying' | 'ready' | 'lost' | 'failed' | 'reconnecting';

/** 连接状态变化事件 */
export interface ConnectionEvent {
  state: ConnectionState;
  timestamp: string;
  message?: string;
}

/** 连接历史记录条目 */
export interface ConnectionHistoryEntry {
  /** SSH config Host 别名 */
  hostAlias: string;
  /** 主机地址 */
  hostName: string;
  /** 连接开始时间 */
  connectedAt: string;
  /** 连接结束时间 */
  disconnectedAt: string | null;
  /** 结束原因 */
  endReason: 'manual' | 'lost' | 'failed' | null;
  /** 最后一个错误消息 */
  lastError?: string;
}

/** 自动重连配置 */
export interface ReconnectConfig {
  enabled: boolean;
  maxAttempts: number;
  initialDelayMs: number;
  backoffMultiplier: number;
  maxDelayMs: number;
}

const DEFAULT_RECONNECT_CONFIG: ReconnectConfig = {
  enabled: true, maxAttempts: 3, initialDelayMs: 1000, backoffMultiplier: 2, maxDelayMs: 10_000,
};

/**
 * 连接编排器：直接从 ~/.ssh/config 解析主机配置，管理 SSH 连接生命周期。
 *
 * 不再持久化主机档案——主机列表来自 ssh config 文件，用户通过编辑 ssh config 管理主机。
 */
export class ConnectionOrchestrator extends EventEmitter {
  private _state: ConnectionState = 'disconnected';
  private connection: Ssh2Connection | undefined;
  private currentAlias: string | undefined;
  private lastHelperDirPath: string | undefined;
  private reconnectConfig: ReconnectConfig = DEFAULT_RECONNECT_CONFIG;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private _history: ConnectionHistoryEntry[] = [];
  private currentHistoryEntry: ConnectionHistoryEntry | undefined;

  get state(): ConnectionState { return this._state; }
  get activeConnection(): Ssh2Connection | undefined { return this._state === 'ready' ? this.connection : undefined; }
  get currentHostAlias(): string | undefined { return this.currentAlias; }
  get history(): readonly ConnectionHistoryEntry[] { return this._history; }

  configureReconnect(config: Partial<ReconnectConfig>): void {
    this.reconnectConfig = { ...this.reconnectConfig, ...config };
  }

  /**
   * 通过 SSH config Host 别名激活连接
   * @param alias - SSH config 中的 Host 别名（如 "OrangePI"）
   * @param helperDirPath - 本地 helper 构建目录路径
   * @returns 连接就绪后的 Hello
   */
  async activate(alias: string, helperDirPath: string): Promise<Hello> {
    if (this.connection) await this.deactivate();

    this.currentAlias = alias;
    this.lastHelperDirPath = helperDirPath;
    this.reconnectAttempts = 0;
    this.setState('connecting', `正在连接 ${alias}...`);

    const resolved = resolveHost(alias);
    if (!resolved) {
      this.setState('failed', `SSH config 中未找到 Host "${alias}"`);
      throw new Error(`SSH config 中未找到 Host "${alias}"`);
    }

    this.currentHistoryEntry = {
      hostAlias: alias,
      hostName: resolved.target.host,
      connectedAt: new Date().toISOString(),
      disconnectedAt: null,
      endReason: null,
    };

    try {
      return await this.connectWithBootstrap(resolved, helperDirPath);
    } catch (error) {
      this.setState('failed', error instanceof Error ? error.message : String(error));
      if (this.currentHistoryEntry) {
        this.currentHistoryEntry.endReason = 'failed';
        this.currentHistoryEntry.lastError = error instanceof Error ? error.message : String(error);
      }
      this.archiveHistoryEntry();
      throw error;
    }
  }

  async deactivate(): Promise<void> {
    this.cancelReconnect();
    if (this.connection) {
      await this.connection.dispose().catch(() => {});
      this.connection = undefined;
    }
    if (this.currentHistoryEntry) {
      this.currentHistoryEntry.disconnectedAt = new Date().toISOString();
      this.currentHistoryEntry.endReason = 'manual';
      this.archiveHistoryEntry();
    }
    this.currentAlias = undefined;
    this.setState('disconnected');
  }

  async reconnect(): Promise<Hello> {
    if (!this.currentAlias || !this.lastHelperDirPath) {
      throw new Error('没有可重连的主机（请先 activate）');
    }
    this.cancelReconnect();
    this.reconnectAttempts = 0;
    this.setState('reconnecting', `正在手动重连 ${this.currentAlias}...`);
    const resolved = resolveHost(this.currentAlias);
    if (!resolved) throw new Error(`SSH config 中未找到 Host "${this.currentAlias}"`);
    return await this.connectWithBootstrap(resolved, this.lastHelperDirPath);
  }

  /**
   * 连接+引导组合逻辑
   */
  private async connectWithBootstrap(resolved: ResolvedHostWithJump, helperDirPath: string): Promise<Hello> {
    // 先尝试直接连接（使用远端已安装的 Node 和 helper）
    this.setState('verifying', '正在验证已有配置...');
    try {
      return await this.tryConnect(resolved, undefined);
    } catch {
      this.setState('connecting', '已有配置失败，正在重新引导...');
    }

    // 执行引导
    this.setState('verifying', '正在引导远端环境...');
    const bootstrap = new RemoteBootstrap();
    const result = await bootstrap.bootstrap(resolved, helperDirPath);
    this.setState('connecting', '正在建立 SSH 连接...');
    // 用引导结果中的 node/helper/helperHash 创建连接
    return await this.tryConnect(resolved, result);
  }

  /**
   * 用解析后的配置创建 Ssh2Connection 并等待就绪
   * @param resolved - 从 SSH config 解析的主机配置
   * @param bootstrapResult - 引导结果（如果已引导），包含 node/helper/helperHash
   */
  private async tryConnect(resolved: ResolvedHostWithJump, bootstrapResult?: BootstrapResult): Promise<Hello> {
    const target = resolved.target;
    const jumpHosts = resolved.jumpHosts;

    const connection = new Ssh2Connection({
      host: target.host,
      port: target.port,
      username: target.username,
      ...(target.identityFile ? { privateKeyPath: target.identityFile } : {}),
      node: bootstrapResult?.node || '/home/' + target.username + '/.dsh/node/node',
      helper: bootstrapResult?.helper || '/home/' + target.username + '/.dsh/helper/helper.mjs',
      helperHash: bootstrapResult?.helperHash || '',
      workspace: '/home/' + target.username,
      ...(jumpHosts.length > 0 ? { jumpHosts: jumpHosts.map(jh => ({
        host: jh.host,
        port: jh.port,
        username: jh.username,
        ...(jh.identityFile ? { privateKeyPath: jh.identityFile } : {}),
      })) } : {}),
    });

    this.connection = connection;
    connection.on('closed', (err: Error) => {
      if (this._state === 'ready') this.notifyConnectionLost(err.message);
    });

    const hello = await connection.ready;
    this.setState('ready', `已连接到 ${this.currentAlias} (${target.host})`);
    return hello;
  }

  notifyConnectionLost(reason: string): void {
    if (this._state !== 'ready' && this._state !== 'reconnecting') return;
    if (this.currentHistoryEntry) {
      this.currentHistoryEntry.disconnectedAt = new Date().toISOString();
      this.currentHistoryEntry.endReason = 'lost';
      this.currentHistoryEntry.lastError = reason;
      this.archiveHistoryEntry();
    }
    this.connection = undefined;
    this.reconnectAttempts++;
    if (this.reconnectConfig.enabled && this.reconnectAttempts <= this.reconnectConfig.maxAttempts) {
      const delay = Math.min(
        this.reconnectConfig.initialDelayMs * Math.pow(this.reconnectConfig.backoffMultiplier, this.reconnectAttempts - 1),
        this.reconnectConfig.maxDelayMs,
      );
      this.setState('reconnecting', `连接丢失（${reason}），${delay}ms 后自动重连（第 ${this.reconnectAttempts}/${this.reconnectConfig.maxAttempts} 次）`);
      this.reconnectTimer = setTimeout(() => { this.doAutoReconnect().catch(() => {}); }, delay);
      this.reconnectTimer.unref();
    } else {
      this.setState('lost', `连接丢失且自动重连已耗尽（${reason}），请手动重连`);
    }
  }

  private async doAutoReconnect(): Promise<void> {
    if (!this.currentAlias || !this.lastHelperDirPath) { this.setState('lost', '无法重连'); return; }
    try {
      this.setState('reconnecting', `正在自动重连 ${this.currentAlias}...`);
      const resolved = resolveHost(this.currentAlias);
      if (!resolved) throw new Error('SSH config 解析失败');
      await this.connectWithBootstrap(resolved, this.lastHelperDirPath);
      this.reconnectAttempts = 0;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.reconnectAttempts++;
      if (this.reconnectAttempts <= this.reconnectConfig.maxAttempts) {
        const delay = Math.min(
          this.reconnectConfig.initialDelayMs * Math.pow(this.reconnectConfig.backoffMultiplier, this.reconnectAttempts - 1),
          this.reconnectConfig.maxDelayMs,
        );
        this.setState('reconnecting', `重连失败（${msg}），${delay}ms 后重试`);
        this.reconnectTimer = setTimeout(() => { this.doAutoReconnect().catch(() => {}); }, delay);
        this.reconnectTimer.unref();
      } else {
        this.setState('lost', `自动重连已耗尽（${msg}），请手动重连`);
      }
    }
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined; }
  }

  private archiveHistoryEntry(): void {
    if (this.currentHistoryEntry) {
      this._history.unshift(this.currentHistoryEntry);
      if (this._history.length > 50) this._history.length = 50;
      this.currentHistoryEntry = undefined;
    }
  }

  private setState(state: ConnectionState, message?: string): void {
    this._state = state;
    this.emit('stateChange', { state, timestamp: new Date().toISOString(), ...(message ? { message } : {}) });
  }
}

/**
 * @file 连接编排与状态机模块
 * @description 管理 SSH 连接的生命周期状态，协调引导→连接→就绪→断开的全流程。
 *              提供可观测的状态机和事件流，供前端订阅连接状态变化。
 *
 * 状态机：
 *   disconnected → connecting → verifying → ready → lost
 *                                          ↘ failed
 */

import { EventEmitter } from 'node:events';
import { Ssh2Connection, type Hello } from './ssh2-connection.js';
import { RemoteBootstrap, type BootstrapResult } from './remote-bootstrap.js';
import type { RemoteHostProfile } from './remote-hosts.js';

/** 连接状态枚举 */
export type ConnectionState = 'disconnected' | 'connecting' | 'verifying' | 'ready' | 'lost' | 'failed';

/** 连接状态变化事件 */
export interface ConnectionEvent {
  /** 当前状态 */
  state: ConnectionState;
  /** 状态变化时间戳（ISO-8601） */
  timestamp: string;
  /** 可选的状态详情或错误消息 */
  message?: string;
}

/**
 * 连接编排器：管理一个远程主机的 SSH 连接生命周期。
 *
 * 职责：
 * - 接收主机档案，执行引导（探测/安装 Node + 上传 helper）
 * - 用引导结果创建 Ssh2Connection
 * - 维护状态机，对外暴露状态变化事件
 * - 连接就绪后提供 Ssh2Connection 实例供下游 provider 使用
 * - 断开时清理资源
 */
export class ConnectionOrchestrator extends EventEmitter {
  /** 当前状态 */
  private _state: ConnectionState = 'disconnected';
  /** 当前连接实例 */
  private connection: Ssh2Connection | undefined;
  /** 引导结果 */
  private bootstrapResult: BootstrapResult | undefined;
  /** 当前绑定的主机档案 */
  private profile: RemoteHostProfile | undefined;

  /** 获取当前状态 */
  get state(): ConnectionState { return this._state; }

  /** 获取当前连接实例（仅 ready 状态可用） */
  get activeConnection(): Ssh2Connection | undefined {
    return this._state === 'ready' ? this.connection : undefined;
  }

  /** 获取当前绑定的主机档案 */
  get activeProfile(): RemoteHostProfile | undefined {
    return this.profile;
  }

  /**
   * 激活一个主机档案的连接
   * @param profile - 主机档案
   * @param helperDirPath - 本地 helper 构建目录路径
   * @returns 连接就绪后的 Hello
   */
  async activate(profile: RemoteHostProfile, helperDirPath: string): Promise<Hello> {
    // 如果已在连接，先断开
    if (this.connection) await this.deactivate();

    this.profile = profile;
    this.setState('connecting', `正在连接 ${profile.host}:${profile.port}`);

    try {
      const bootstrap = new RemoteBootstrap();

      // 如果档案已有 helper 配置，先尝试直接连接
      if (profile.node && profile.helper && profile.helperHash) {
        this.setState('verifying', '正在验证已有配置...');
        try {
          return await this.tryConnect(profile);
        } catch {
          // 已有配置连接失败，执行重新引导
          this.setState('connecting', '已有配置失败，正在重新引导...');
        }
      }

      // 执行引导
      this.setState('verifying', '正在引导远端环境...');
      this.bootstrapResult = await bootstrap.bootstrap(profile, helperDirPath);

      // 用引导结果更新档案
      profile.node = this.bootstrapResult.node;
      profile.helper = this.bootstrapResult.helper;
      profile.helperHash = this.bootstrapResult.helperHash;

      // 建立连接
      this.setState('connecting', '正在建立 SSH 连接...');
      return await this.tryConnect(profile);
    } catch (error) {
      this.setState('failed', error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  /** 断开当前连接，回到 disconnected 状态 */
  async deactivate(): Promise<void> {
    if (this.connection) {
      await this.connection.dispose().catch(() => {});
      this.connection = undefined;
    }
    this.bootstrapResult = undefined;
    this.profile = undefined;
    this.setState('disconnected');
  }

  /**
   * 用主机档案的配置创建 Ssh2Connection 并等待就绪
   * @param profile - 已完成引导的主机档案
   * @returns helper hello
   */
  private async tryConnect(profile: RemoteHostProfile): Promise<Hello> {
    const connection = new Ssh2Connection({
      host: profile.host,
      port: profile.port,
      username: profile.username,
      ...(profile.privateKeyPath ? { privateKeyPath: profile.privateKeyPath } : {}),
      ...(profile.passphrase ? { passphrase: profile.passphrase } : {}),
      ...(profile.password ? { password: profile.password } : {}),
      node: profile.node,
      helper: profile.helper,
      helperHash: profile.helperHash,
      workspace: profile.workspace,
      ...(profile.bootstrapPath ? { bootstrapPath: profile.bootstrapPath } : {}),
      ...(profile.bootstrapHash ? { bootstrapHash: profile.bootstrapHash } : {}),
    });

    this.connection = connection;

    // 等待就绪
    const hello = await connection.ready;
    this.setState('ready', `已连接到 ${profile.host}`);
    return hello;
  }

  /**
   * 更新状态并发送事件
   * @param state - 新状态
   * @param message - 可选状态消息
   */
  private setState(state: ConnectionState, message?: string): void {
    this._state = state;
    const event: ConnectionEvent = {
      state,
      timestamp: new Date().toISOString(),
      ...(message ? { message } : {}),
    };
    this.emit('stateChange', event);
  }
}

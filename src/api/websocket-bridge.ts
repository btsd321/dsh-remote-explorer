/**
 * @file WebSocket 桥接服务
 * @description 将 RemoteHostController 的方法暴露为 WebSocket JSON-RPC 接口，
 *              供前端（HTML 页面或 dsh Web GUI client module）调用。
 *              同时推送连接状态变化事件。
 *
 * 协议：
 * - 请求：{ id: string, method: string, params: object }
 * - 响应：{ id: string, result?: any, error?: { message: string } }
 * - 事件：{ type: 'event', event: string, data: object }
 */

import { WebSocketServer, WebSocket } from 'ws';
import { RemoteHostController } from './remote-host-controller.js';
import type { RemoteConnectionEvent } from './types.js';

/** WebSocket 桥接服务配置 */
export interface BridgeConfig {
  /** 监听端口 */
  port: number;
  /** 监听地址（默认 127.0.0.1） */
  host?: string;
  /** 可选认证 token */
 authToken?: string;
}

/**
 * WebSocket JSON-RPC 桥接服务。
 *
 * 将 RemoteHostController 的方法暴露为 WebSocket 接口，
 * 前端通过 WebSocket 调用方法并接收连接状态变化事件。
 */
export class RemoteHostBridge {
  /** WebSocket 服务器 */
  private wss: WebSocketServer | undefined;
  /** 控制器实例 */
  private readonly controller: RemoteHostController;
  /** 当前配置 */
  private readonly config: BridgeConfig;

  /**
   * @param controller - 远程主机管理控制器
   * @param config - 桥接配置
   */
  constructor(controller: RemoteHostController, config: BridgeConfig) {
    this.controller = controller;
    this.config = config;
  }

  /** 启动 WebSocket 服务 */
  start(): void {
    this.wss = new WebSocketServer({
      port: this.config.port,
      host: this.config.host ?? '127.0.0.1',
    });

    this.wss.on('connection', (ws, req) => {
      // 认证检查
      if (this.config.authToken) {
        const url = new URL(req.url ?? '', `http://${req.headers.host}`);
        const token = url.searchParams.get('token');
        if (token !== this.config.authToken) {
          ws.close(4001, '认证失败');
          return;
        }
      }

      // 订阅连接状态变化
      const unsub = this.controller.subscribeStateChanges((event: RemoteConnectionEvent) => {
        this.send(ws, { type: 'event', event: 'stateChange', data: event });
      });

      // 处理 JSON-RPC 请求
      ws.on('message', async (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString('utf8'));
          const result = await this.handleMethod(msg.method, msg.params);
          this.send(ws, { id: msg.id, result });
        } catch (err) {
          this.send(ws, {
            id: msg?.id,
            error: { message: err instanceof Error ? err.message : String(err) },
          });
        }
      });

      ws.on('close', () => {
        unsub();
      });
    });

    console.log(`远程主机管理 WebSocket 服务已启动: ws://${this.config.host ?? '127.0.0.1'}:${this.config.port}`);
  }

  /** 停止 WebSocket 服务 */
  stop(): void {
    this.wss?.close();
    this.wss = undefined;
  }

  /**
   * 处理 JSON-RPC 方法调用
   * @param method - 方法名
   * @param params - 参数
   * @returns 方法返回值
   */
  private async handleMethod(method: string, params: any): Promise<any> {
    switch (method) {
      case 'list': return await this.controller.list();
      case 'create': return await this.controller.create(params);
      case 'update': return await this.controller.update(params);
      case 'delete': return await this.controller.delete(params);
      case 'probe': return await this.controller.probe(params);
      case 'bootstrap': return await this.controller.bootstrap(params);
      case 'activate': return await this.controller.activate(params);
      case 'deactivate': return await this.controller.deactivate(params);
      case 'status': return await this.controller.status();
      default: throw new Error(`未知方法: ${method}`);
    }
  }

  /**
   * 发送 JSON 消息到 WebSocket
   * @param ws - WebSocket 连接
   * @param msg - 消息对象
   */
  private send(ws: WebSocket, msg: object): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }
}

/**
 * @file Web GUI 集成模块
 * @description 通过 dsh 的 ctx.webServer 注册 HTTP 路由，
 *              将远程主机管理页面挂载到 dsh Web GUI 的同一个 HTTP 服务上。
 *              用户访问 http://127.0.0.1:<dsh-port>/remote-ssh 即可使用。
 *
 * 路由：
 * - GET /remote-ssh → 返回管理页面 HTML
 * - WS  /remote-ssh/ws → WebSocket JSON-RPC 桥接
 */

import type { Context } from '@deepseek-ai/cordis';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { RemoteHostController } from './api/remote-host-controller.js';

/** 插件配置（与 index.ts 的 Config 一致） */
export interface WebGuiConfig {
  /** 本地 helper bundle 目录路径 */
  helperDirPath?: string;
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
 * 获取注入了正确端口的 HTML 页面
 * @param port - dsh webserver 端口
 * @returns HTML 字符串
 */
function getHtml(port: number): string {
  const htmlPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'client', 'index.html');
  let html: string;
  try {
    html = readFileSync(htmlPath, 'utf8');
  } catch {
    try {
      html = readFileSync(join(process.cwd(), 'client', 'index.html'), 'utf8');
    } catch {
      return '<html><body><h1>dsh-remote-ssh: client/index.html not found</h1></body></html>';
    }
  }
  // 注入正确的 WebSocket URL：用 location.host 动态获取端口
  html = html.replace(
    /const port = new URLSearchParams\(location\.search\)\.get\('port'\) \|\| '18900';/,
    `const port = String(location.port || ${port});`
  );
  html = html.replace(
    /ws:\/\/127\.0\.0\.1:\$\{port\}\/ws/g,
    `ws://${'${location.host}'}/remote-ssh/ws`
  );
  return html;
}

/**
 * 在 dsh 的 webServer 上注册远程主机管理路由。
 *
 * 注册两个路由：
 * 1. GET /remote-ssh → 返回管理页面 HTML
 * 2. WS /remote-ssh/ws → WebSocket JSON-RPC 桥接
 *
 * @param ctx - Cordis 上下文（需要 ctx.webServer 可用）
 * @param controller - 远程主机管理 controller
 * @param config - 插件配置
 */
export function registerWebGuiRoutes(ctx: Context, controller: RemoteHostController, config: WebGuiConfig): void {
  const webServer = ctx.get('webServer');
  if (!webServer) {
    console.warn('[dsh-remote-ssh] ctx.webServer 不可用，Web GUI 路由未注册');
    return;
  }

  const port = webServer.port;
  const helperDir = config.helperDirPath || '';

  // 1. 注册 HTTP 路由：GET /remote-ssh → 返回 HTML 页面
  ctx.effect(() => webServer.register({
    kind: 'exact' as const,
    path: '/remote-ssh',
    handler: (_req: IncomingMessage, res: ServerResponse) => {
      const html = getHtml(port);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    },
  }));

  // 2. 注册 WebSocket 升级路由：/remote-ssh/ws
  const wss = new WebSocketServer({ noServer: true });
  ctx.effect(() => webServer.registerUpgrade({
    path: '/remote-ssh/ws',
    handler: (req: IncomingMessage, socket: any, head: Buffer) => {
      wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
        handleWebSocketConnection(ws, controller, helperDir);
      });
    },
  }));

  console.log(`[dsh-remote-ssh] Web GUI 已注册: http://127.0.0.1:${port}/remote-ssh`);
}

/**
 * 处理 WebSocket 连接
 * @param ws - WebSocket 连接
 * @param controller - 远程主机管理 controller
 * @param helperDir - helper 目录路径
 */
function handleWebSocketConnection(ws: WebSocket, controller: RemoteHostController, helperDir: string): void {
  console.log('[dsh-remote-ssh] 前端 WebSocket 已连接');

  // 订阅连接状态变化
  const unsub = controller.subscribeStateChanges((event) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'event', event: 'stateChange', data: event }));
    }
  });

  // 处理 JSON-RPC 请求
  ws.on('message', async (data: Buffer) => {
    try {
      const msg = JSON.parse(data.toString());
      const result = await handleMethod(controller, msg.method, msg.params, helperDir);
      ws.send(JSON.stringify({ id: msg.id, result }));
    } catch (err) {
      ws.send(JSON.stringify({
        id: msg?.id,
        error: { message: err instanceof Error ? err.message : String(err) },
      }));
    }
  });

  ws.on('close', () => {
    unsub();
    console.log('[dsh-remote-ssh] 前端 WebSocket 已断开');
  });
}

/**
 * 处理 JSON-RPC 方法调用
 * @param controller - 远程主机管理 controller
 * @param method - 方法名
 * @param params - 参数
 * @param helperDir - helper 目录路径
 * @returns 方法返回值
 */
async function handleMethod(controller: RemoteHostController, method: string, params: any, helperDir: string): Promise<any> {
  switch (method) {
    case 'list': return await controller.list();
    case 'create': return await controller.create(params);
    case 'update': return await controller.update(params);
    case 'delete': return await controller.delete(params);
    case 'probe': return await controller.probe(params);
    case 'bootstrap': return await controller.bootstrap({ ...params, helperDirPath: helperDir });
    case 'activate': return await controller.activate({ ...params, helperDirPath: helperDir });
    case 'deactivate': return await controller.deactivate(params);
    case 'reconnect': return await controller.reconnect();
    case 'status': return await controller.status();
    case 'history': return controller.getHistory();
    case 'configureReconnect': controller.configureReconnect(params); return true;
    case 'listRemoteDir': return await controller.listRemoteDir(params.path);
    case 'readRemoteFile': return await controller.readRemoteFile(params.path);
    case 'statRemoteFile': return await controller.statRemoteFile(params.path);
    case 'createWorkspace': return await controller.createWorkspace(params.hostId, params.path, params.title);
    case 'listWorkspaces': return controller.listWorkspaces(params?.hostId);
    case 'getWorkspace': return controller.getWorkspace(params.id);
    case 'renameWorkspace': return controller.renameWorkspace(params.id, params.title);
    case 'deleteWorkspace': return controller.deleteWorkspace(params.id);
    case 'attachSession': return controller.attachSessionToWorkspace(params.workspaceId, params.sessionId);
    case 'detachSession': return controller.detachSessionFromWorkspace(params.workspaceId, params.sessionId);
    default: throw new Error(`未知方法: ${method}`);
  }
}

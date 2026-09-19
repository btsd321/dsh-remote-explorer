/**
 * @file Web GUI 集成模块
 * @description 通过 dsh 的 ctx.webServer 注册 WebSocket 路由和 tapIndex，
 *              将远程资源管理器面板直接注入到 dsh Web GUI 中。
 *
 * 功能：
 * 1. 注册 /remote-ssh/ws WebSocket 升级路由 → JSON-RPC 桥接
 * 2. 注册 /remote-ssh HTTP 路由 → 返回独立 HTML 页面（兼容直接访问）
 * 3. 通过 webServer.tapIndex 在 dsh 主页面 </body> 前注入 remote-explorer.js
 */

import type { Context } from '@deepseek-ai/cordis';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { RemoteHostController } from './api/remote-host-controller.js';

/** 插件配置 */
export interface WebGuiConfig {
  helperDirPath?: string;
  hostsFilePath?: string;
  workspacesFilePath?: string;
  reconnect?: {
    enabled?: boolean;
    maxAttempts?: number;
    initialDelayMs?: number;
    backoffMultiplier?: number;
    maxDelayMs?: number;
  };
}

/** 缓存 remote-explorer.js 内容 */
let explorerScriptCache: string | undefined;

/**
 * 读取 remote-explorer.js 脚本内容
 * @returns JS 脚本字符串
 */
function getExplorerScript(): string {
  if (explorerScriptCache) return explorerScriptCache;
  const basePath = dirname(fileURLToPath(import.meta.url));
  const paths = [
    join(basePath, '..', 'client', 'remote-explorer.js'),
    join(process.cwd(), 'client', 'remote-explorer.js'),
  ];
  for (const p of paths) {
    try {
      explorerScriptCache = readFileSync(p, 'utf8');
      return explorerScriptCache;
    } catch { /* 继续尝试下一个路径 */ }
  }
  console.warn('[dsh-remote-ssh] remote-explorer.js 未找到');
  return '';
}

/**
 * 获取独立 HTML 页面（保留给直接 /remote-ssh 访问用）
 */
function getHtml(): string {
  const htmlPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'client', 'index.html');
  try {
    return readFileSync(htmlPath, 'utf8');
  } catch {
    try {
      return readFileSync(join(process.cwd(), 'client', 'index.html'), 'utf8');
    } catch {
      return '<html><body><h1>dsh-remote-ssh: client/index.html not found</h1></body></html>';
    }
  }
}

/**
 * 在 dsh 的 webServer 上注册远程资源管理器。
 *
 * @param ctx - Cordis 上下文（需要 ctx.webServer 可用）
 * @param controller - 远程主机管理 controller
 * @param config - 插件配置
 */
export function registerWebGuiRoutes(ctx: Context, controller: RemoteHostController, config: WebGuiConfig): void {
  const webServer = ctx.get('webServer');
  if (!webServer) {
    console.warn('[dsh-remote-ssh] ctx.webServer 不可用');
    return;
  }

  // 1. 注册 WebSocket 升级路由：/remote-ssh/ws
  const wss = new WebSocketServer({ noServer: true });
  ctx.effect(() => webServer.registerUpgrade({
    path: '/remote-ssh/ws',
    handler: (req: any, socket: any, head: Buffer) => {
      wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
        handleWebSocketConnection(ws, controller);
      });
    },
  }));

  // 2. 注册 HTTP 路由：GET /remote-ssh → 返回独立 HTML 页面
  ctx.effect(() => webServer.register({
    kind: 'exact' as const,
    path: '/remote-ssh',
    handler: (_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(getHtml());
    },
  }));

  // 3. 通过 tapIndex 在 dsh 主页面 </body> 前注入 remote-explorer.js
  ctx.effect(() => webServer.tapIndex((html: string) => {
    const script = getExplorerScript();
    if (!script) return html;
    return html.replace('</body>', '<script>' + script + '</script></body>');
  }));

  console.log('[dsh-remote-ssh] Remote Explorer 已通过 tapIndex 注入');
  console.log('[dsh-remote-ssh] WebSocket: ws://<host>/remote-ssh/ws');
}

/**
 * 处理 WebSocket 连接
 */
function handleWebSocketConnection(ws: WebSocket, controller: RemoteHostController): void {
  console.log('[dsh-remote-ssh] 前端 WebSocket 已连接');

  const unsub = controller.subscribeStateChanges((event) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'event', event: 'stateChange', data: event }));
    }
  });

  ws.on('message', async (data: Buffer) => {
    let msgId: string | undefined;
    try {
      const msg = JSON.parse(data.toString());
      msgId = msg.id;
      const result = await handleMethod(controller, msg.method, msg.params);
      ws.send(JSON.stringify({ id: msg.id, result }));
    } catch (err) {
      ws.send(JSON.stringify({
        id: msgId,
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
 */
async function handleMethod(controller: RemoteHostController, method: string, params: any): Promise<any> {
  switch (method) {
    case 'listSshHosts': return controller.listSshHosts();
    case 'refreshSshConfig': controller.refreshSshConfig(); return true;
    case 'setSshConfigPath': controller.setSshConfigPath(params.path); return true;
    case 'setSshConfigContent': return controller.setSshConfigContent(params.content);
    case 'setMirror': controller.setMirror(params.mirror); return true;
    case 'getMirror': return controller.getMirror();
    case 'activate': return await controller.activate(params.alias);
    case 'deactivate': return await controller.deactivate();
    case 'reconnect': return await controller.reconnect();
    case 'status': return await controller.status();
    case 'history': return controller.getHistory();
    case 'configureReconnect': controller.configureReconnect(params); return true;
    case 'listRemoteDir': return await controller.listRemoteDir(params.path);
    case 'readRemoteFile': return await controller.readRemoteFile(params.path);
    case 'statRemoteFile': return await controller.statRemoteFile(params.path);
    default: throw new Error('未知方法: ' + method);
  }
}

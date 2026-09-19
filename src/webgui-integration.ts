/**
 * @file Web GUI 集成模块
 * @description 通过 dsh 的 ctx.webServer 注册 HTTP 路由和 index injection，
 *              将远程主机管理页面嵌入到 dsh Web GUI 中。
 *
 * 功能：
 * 1. 注册 /remote-ssh HTTP 路由 → 返回管理页面 HTML（不需要正则替换，页面内直接用 location.host）
 * 2. 注册 /remote-ssh/ws WebSocket 升级路由 → JSON-RPC 桥接
 * 3. 通过 webserver/index-inject 事件注入内联 JS → 在 dsh sidebar 底部添加"远程主机"按钮
 * 4. 点击按钮在主内容区弹出 overlay iframe 加载 /remote-ssh 页面
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
 * 获取管理页面 HTML（直接读取，不做正则替换——页面内已用 location.host）
 * @returns HTML 字符串
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
 * 注入到 dsh 主页面的内联 JS 脚本。
 *
 * 功能：
 * 1. 在 dsh sidebar 底部添加"远程主机"按钮
 * 2. 点击按钮在主内容区弹出 overlay iframe 加载 /remote-ssh 页面
 * 3. 再次点击关闭 overlay
 */
const ENTRY_BUTTON_SCRIPT = `
(function() {
  function addRemoteHostButton() {
    // 避免重复添加
    if (document.getElementById('dsh-remote-ssh-btn')) return;

    // 创建按钮
    var btn = document.createElement('button');
    btn.id = 'dsh-remote-ssh-btn';
    btn.title = '远程主机管理';
    btn.style.cssText = [
      'display:flex', 'align-items:center', 'justify-content:center',
      'width:36px', 'height:36px', 'border:none', 'border-radius:8px',
      'background:transparent', 'color:var(--dsw-text-secondary, #aaa)',
      'cursor:pointer', 'font-size:18px', 'transition:background .2s',
      'margin:4px'
    ].join(';');
    btn.innerHTML = '🖥';
    btn.onmouseenter = function() { btn.style.background = 'var(--dsw-surface-hover, #ffffff1a)'; };
    btn.onmouseleave = function() { btn.style.background = 'transparent'; };
    btn.onclick = toggleRemoteHostPanel;

    // 尝试找到 dsh sidebar 底部区域
    var sidebar = document.querySelector('[class*="sidebar"] [class*="footer"]')
      || document.querySelector('[class*="SidebarRoot"] [class*="footer"]')
      || document.querySelector('[class*="sidebar-footer"]')
      || document.querySelector('nav[class*="sidebar"]')
      || document.querySelector('aside')
      || document.querySelector('[class*="sidebar"]');

    if (sidebar) {
      sidebar.appendChild(btn);
    } else {
      // 如果找不到 sidebar，放一个浮动按钮在右下角
      btn.style.position = 'fixed';
      btn.style.bottom = '16px';
      btn.style.right = '16px';
      btn.style.zIndex = '9999';
      btn.style.background = '#16213e';
      btn.style.border = '1px solid #0f3460';
      document.body.appendChild(btn);
    }
  }

  // overlay 容器
  var overlay = null;
  var iframe = null;

  function toggleRemoteHostPanel() {
    if (overlay) {
      closePanel();
    } else {
      openPanel();
    }
  }

  function openPanel() {
    overlay = document.createElement('div');
    overlay.id = 'dsh-remote-ssh-overlay';
    overlay.style.cssText = [
      'position:fixed', 'top:0', 'right:0', 'width:80vw', 'height:100vh',
      'background:#1a1a2e', 'border-left:2px solid #0f3460', 'z-index:99998',
      'box-shadow:-4px 0 20px rgba(0,0,0,.3)', 'display:flex', 'flex-direction:column'
    ].join(';');

    // 顶部栏
    var header = document.createElement('div');
    header.style.cssText = 'padding:10px 16px;background:#16213e;border-bottom:1px solid #0f3460;display:flex;justify-content:space-between;align-items:center;flex-shrink:0;';
    var title = document.createElement('span');
    title.textContent = '远程主机管理';
    title.style.cssText = 'font-size:15px;font-weight:600;color:#e0e0e0;';
    var closeBtn = document.createElement('button');
    closeBtn.textContent = '✕ 关闭';
    closeBtn.style.cssText = 'background:transparent;border:1px solid #0f3460;color:#aaa;padding:4px 12px;border-radius:4px;cursor:pointer;font-size:12px;';
    closeBtn.onmouseenter = function() { closeBtn.style.color = '#e0e0e0'; closeBtn.style.borderColor = '#e94560'; };
    closeBtn.onmouseleave = function() { closeBtn.style.color = '#aaa'; closeBtn.style.borderColor = '#0f3460'; };
    closeBtn.onclick = closePanel;
    header.appendChild(title);
    header.appendChild(closeBtn);
    overlay.appendChild(header);

    // iframe 加载管理页面
    iframe = document.createElement('iframe');
    iframe.src = '/remote-ssh';
    iframe.style.cssText = 'flex:1;border:none;width:100%;';
    overlay.appendChild(iframe);

    document.body.appendChild(overlay);
    document.body.style.overflow = 'hidden';
  }

  function closePanel() {
    if (overlay) {
      document.body.removeChild(overlay);
      overlay = null;
      iframe = null;
      document.body.style.overflow = '';
    }
  }

  // 等待 DOM 加载完成
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() {
      setTimeout(addRemoteHostButton, 500);
    });
  } else {
    setTimeout(addRemoteHostButton, 500);
  }
})();
`;

/**
 * 在 dsh 的 webServer 上注册远程主机管理路由和 index injection。
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

  // 1. 注册 HTTP 路由：GET /remote-ssh → 返回 HTML 页面（直接读取，不做替换）
  ctx.effect(() => webServer.register({
    kind: 'exact' as const,
    path: '/remote-ssh',
    handler: (_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(getHtml());
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

  // 3. 通过 index injection 在 dsh 主页面注入入口按钮脚本
  ctx.on('webserver/index-inject', (table: any[]) => {
    table.push({
      kind: 'script',
      placement: 'body',
      text: ENTRY_BUTTON_SCRIPT,
    });
  });

  console.log(`[dsh-remote-ssh] Web GUI 已注册: http://127.0.0.1:${port}/remote-ssh`);
  console.log(`[dsh-remote-ssh] 入口按钮已注入到 dsh 主界面 sidebar`);
}

/**
 * 处理 WebSocket 连接
 * @param ws - WebSocket 连接
 * @param controller - 远程主机管理 controller
 * @param helperDir - helper 目录路径
 */
function handleWebSocketConnection(ws: WebSocket, controller: RemoteHostController, helperDir: string): void {
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
 * @param controller - 远程主机管理 controller
 * @param method - 方法名
 * @param params - 参数
 * @param helperDir - helper 目录路径
 * @returns 方法返回值
 */
async function handleMethod(controller: RemoteHostController, method: string, params: any): Promise<any> {
  switch (method) {
    // SSH config 主机列表
    case 'listSshHosts': return controller.listSshHosts();
    case 'refreshSshConfig': controller.refreshSshConfig(); return true;
    case 'setSshConfigPath': controller.setSshConfigPath(params.path); return true;
    case 'setMirror': controller.setMirror(params.mirror); return true;
    case 'getMirror': return controller.getMirror();
    // 连接管理
    case 'activate': return await controller.activate(params.alias);
    case 'deactivate': return await controller.deactivate();
    case 'reconnect': return await controller.reconnect();
    case 'status': return await controller.status();
    case 'history': return controller.getHistory();
    case 'configureReconnect': controller.configureReconnect(params); return true;
    // 远端文件操作
    case 'listRemoteDir': return await controller.listRemoteDir(params.path);
    case 'readRemoteFile': return await controller.readRemoteFile(params.path);
    case 'statRemoteFile': return await controller.statRemoteFile(params.path);
    default: throw new Error(`未知方法: ${method}`);
  }
}

/**
 * @file P2 演示启动脚本
 * @description 启动 WebSocket 桥接服务 + 静态 HTML 页面服务，
 *              演示完整的"选主机 → 连接 → 远端开发"流程。
 *
 * 用法：
 *   npx tsx tests/start-demo.cjs --helperDir /path/to/dsh-ssh/lib/bundle
 *   然后在浏览器打开 http://127.0.0.1:18900?helperDir=...
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

// 解析命令行参数
const args = process.argv.slice(2);
let helperDir = '';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--helperDir' && args[i + 1]) helperDir = args[i + 1];
}
if (!helperDir) {
  // 默认路径
  helperDir = path.join(__dirname, '..', '..', 'deepseek-harness', 'packages', 'ssh', 'ssh', 'lib', 'bundle');
}
console.log('helper 目录:', helperDir);
if (!fs.existsSync(path.join(helperDir, 'helper.mjs'))) {
  console.error('helper.mjs 不存在，请指定 --helperDir');
  process.exit(1);
}

const PORT = 18900;

// 创建 controller 和 bridge
async function main() {
  const { RemoteHostController } = require('../src/api/remote-host-controller.ts');
  const { RemoteHostBridge } = require('../src/api/websocket-bridge.ts');

  const controller = new RemoteHostController();
  const bridge = new RemoteHostBridge(controller, { port: PORT });

  // HTTP 静态文件服务（HTML 页面）+ WebSocket 升级
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith('/ws')) return; // WebSocket 路径由 ws 处理
    const htmlPath = path.join(__dirname, '..', 'client', 'index.html');
    const html = fs.readFileSync(htmlPath, 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });

  // 启动 HTTP 服务
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`\n========================================`);
    console.log(` DSH 远程主机管理演示服务已启动`);
    console.log(`========================================`);
    console.log(` Web UI:  http://127.0.0.1:${PORT}?helperDir=${encodeURIComponent(helperDir)}`);
    console.log(` WebSocket: ws://127.0.0.1:${PORT}/ws`);
    console.log(` helperDir: ${helperDir}`);
    console.log(`========================================\n`);
  });

  // WebSocket 服务（挂载到同一个 HTTP server）
  const { WebSocketServer } = require('D:\\Project\\dsh_remote_ssh\\node_modules\\ws');
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws, req) => {
    console.log('前端 WebSocket 已连接');
    // 订阅状态变化
    const unsub = controller.subscribeStateChanges((event) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'event', event: 'stateChange', data: event }));
      }
    });
    // 处理 JSON-RPC 请求
    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString());
        const result = await handleMethod(controller, msg.method, msg.params, helperDir);
        ws.send(JSON.stringify({ id: msg.id, result }));
      } catch (err) {
        ws.send(JSON.stringify({ id: msg?.id, error: { message: err.message } }));
      }
    });
    ws.on('close', () => { unsub(); console.log('前端 WebSocket 已断开'); });
  });
}

/** 处理 JSON-RPC 方法 */
async function handleMethod(controller, method, params, helperDir) {
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
    default: throw new Error(`未知方法: ${method}`);
  }
}

main().catch(err => {
  console.error('启动失败:', err);
  process.exit(1);
});

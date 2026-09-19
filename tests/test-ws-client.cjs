// WebSocket JSON-RPC 客户端测试
const WebSocket = require('D:\\Project\\dsh_remote_ssh\\node_modules\\ws');

const ws = new WebSocket('ws://127.0.0.1:18900/ws');
let reqId = 1;
const pending = new Map();

function rpc(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = String(reqId++);
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

ws.on('open', async () => {
  console.log('✓ WebSocket 已连接');

  // 1. 列出主机
  console.log('\n=== 列出主机 ===');
  const list = await rpc('list');
  console.log('主机列表:', JSON.stringify(list, null, 2));

  if (list.hosts.length > 0) {
    const host = list.hosts[0];
    console.log('\n=== 探测远端 ===');
    try {
      const probe = await rpc('probe', { id: host.id });
      console.log('探测结果:', JSON.stringify(probe, null, 2));
    } catch (e) { console.log('探测失败:', e.message); }

    if (host.bootstrapped) {
      console.log('\n=== 查询连接状态 ===');
      const status = await rpc('status');
      console.log('状态:', JSON.stringify(status, null, 2));

      console.log('\n=== 激活连接 ===');
      try {
        const result = await rpc('activate', { id: host.id });
        console.log('激活结果:', result);
      } catch (e) { console.log('激活失败:', e.message); }

      // 等待状态变化
      await new Promise(r => setTimeout(r, 2000));

      console.log('\n=== 查询连接状态（激活后）===');
      const status2 = await rpc('status');
      console.log('状态:', JSON.stringify(status2, null, 2));

      console.log('\n=== 查询连接历史 ===');
      const history = await rpc('history');
      console.log('历史:', JSON.stringify(history, null, 2));

      console.log('\n=== 断开连接 ===');
      await rpc('deactivate', {});
      console.log('已断开');

      await new Promise(r => setTimeout(r, 500));

      console.log('\n=== 查询连接历史（断开后）===');
      const history2 = await rpc('history');
      console.log('历史:', JSON.stringify(history2, null, 2));
    }
  }

  ws.close();
  process.exit(0);
});

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type === 'event') {
    console.log(`[事件] ${msg.event}:`, JSON.stringify(msg.data));
  } else if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
  }
});

ws.on('error', (e) => { console.error('WebSocket 错误:', e.message); process.exit(1); });

// 测试远程工作区 API（listRemoteDir + readRemoteFile）
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
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type === 'event') { console.log(`[事件] ${msg.event}:`, JSON.stringify(msg.data)); return; }
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
  }
});
ws.on('open', async () => {
  console.log('✓ WebSocket 已连接');
  // 列出主机
  const list = await rpc('list');
  const host = list.hosts[0];
  if (!host) { console.log('无主机'); ws.close(); return; }

  // 激活连接
  console.log('\n=== 激活连接 ===');
  const result = await rpc('activate', { id: host.id });
  console.log('激活:', result);
  await new Promise(r => setTimeout(r, 1000));

  // 测试 listRemoteDir
  console.log('\n=== 浏览远端目录 /home/xlli67 ===');
  const entries = await rpc('listRemoteDir', { path: '/home/xlli67' });
  console.log(`列出 ${entries.length} 个条目:`);
  entries.slice(0, 10).forEach(e => {
    const name = e.name || '?';
    const type = e.type || e.kind || '?';
    console.log(`  ${type === 'directory' ? '📁' : '📄'} ${name} ${e.size ? '(' + e.size + 'B)' : ''}`);
  });
  if (entries.length > 10) console.log(`  ... 还有 ${entries.length - 10} 个`);

  // 测试 readRemoteFile
  console.log('\n=== 读取远端文件 /home/xlli67/.bashrc ===');
  try {
    const content = await rpc('readRemoteFile', { path: '/home/xlli67/.bashrc' });
    console.log(`文件内容 ${content.length} 字节:`);
    console.log(content.slice(0, 300));
    if (content.length > 300) console.log('...(截断)');
  } catch (e) { console.log('读取失败:', e.message); }

  // 断开
  console.log('\n=== 断开 ===');
  await rpc('deactivate', {});
  console.log('已断开');
  ws.close();
  process.exit(0);
});
ws.on('error', e => { console.error('WS错误:', e.message); process.exit(1); });

/**
 * @file 断线检测测试
 * @description 验证 Ssh2Connection 断开时是否通知 ConnectionOrchestrator
 */
const { Ssh2Connection } = require('../src/ssh2-connection.ts');
const { RemoteHostRegistry } = require('../src/remote-hosts.ts');
const { ConnectionOrchestrator } = require('../src/remote-connection.ts');

// 10秒后强制退出
setTimeout(() => { console.log('\n超时退出'); process.exit(0); }, 10000);

async function main() {
  const registry = new RemoteHostRegistry();
  const profile = registry.list().find(h => h.host === '192.168.1.82');
  if (!profile) { console.error('未找到档案'); process.exit(1); }

  const orch = new ConnectionOrchestrator();
  orch.on('stateChange', (e) => console.log(`  [状态] ${e.state}: ${e.message ?? ''}`));

  // 禁用自动重连，避免定时器阻止退出
  orch.configureReconnect({ enabled: false });

  // 激活连接
  console.log('=== 激活连接 ===');
  const helperDir = 'D:\\Project\\deepseek-harness\\packages\\ssh\\ssh\\lib\\bundle';
  await orch.activate(profile, helperDir);
  console.log('当前状态:', orch.state);

  // 模拟远端断开
  console.log('\n=== 模拟连接断开 ===');
  const conn = orch.activeConnection;
  if (conn) {
    conn.emit('closed', new Error('模拟断开'));
  }

  // 等待状态变化
  await new Promise(r => setTimeout(r, 1000));
  console.log('断线后状态:', orch.state);

  // 清理
  await orch.deactivate();
  console.log('清理后状态:', orch.state);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });

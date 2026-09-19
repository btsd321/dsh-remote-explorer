/**
 * @file 端到端连接测试脚本
 * @description 测试完整流程：引导→连接→helper hello 握手→exec 远端命令。
 *              验证 Ssh2Connection 的 RPC 通道和 helper 启动握手。
 */

const { Ssh2Connection } = require('../src/ssh2-connection.ts');
const { RemoteHostRegistry } = require('../src/remote-hosts.ts');
const { ConnectionOrchestrator } = require('../src/remote-connection.ts');
const path = require('path');
const os = require('os');

async function main() {
  const helperDir = path.join(__dirname, '..', '..', 'deepseek-harness', 'packages', 'ssh', 'ssh', 'lib', 'bundle');

  // 从注册表获取已引导的档案
  const registry = new RemoteHostRegistry();
  const hosts = registry.list();
  const profile = hosts.find(h => h.host === '192.168.1.82');
  if (!profile) {
    console.error('未找到 OrangePI 档案，请先运行 test-bootstrap');
    process.exit(1);
  }

  console.log('=== 连接编排器测试 ===');
  console.log('档案:', profile.title, '→', profile.host);
  console.log('Node:', profile.node);
  console.log('Helper:', profile.helper);

  const orchestrator = new ConnectionOrchestrator();

  // 订阅状态变化
  orchestrator.on('stateChange', (event) => {
    console.log(`  [状态] ${event.state}: ${event.message ?? ''}`);
  });

  try {
    console.log('\n激活连接...');
    const hello = await orchestrator.activate(profile, helperDir);
    console.log('\n✓ 连接就绪！');
    console.log('  协议版本:', hello.protocol);
    console.log('  远端 Node:', hello.node);
    console.log('  helper 摘要:', hello.hash.slice(0, 16) + '...');
    console.log('  根目录:', hello.root);
    console.log('  当前状态:', orchestrator.state);

    // 测试 RPC：执行一个简单的远端命令
    const conn = orchestrator.activeConnection;
    if (conn) {
      console.log('\n=== 测试 RPC 请求 ===');
      const { z } = require('zod');
      try {
        const result = await conn.request('executable', { command: 'ls' }, z.string(), undefined, true);
        console.log('✓ executable 查找:', result);
      } catch (err) {
        console.log('RPC 请求结果:', err.message);
      }
    }

    console.log('\n断开连接...');
    await orchestrator.deactivate();
    console.log('当前状态:', orchestrator.state);
  } catch (err) {
    console.error('✗ 测试失败:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('未捕获错误:', err);
  process.exit(1);
});

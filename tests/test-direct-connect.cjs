/**
 * @file 直接连接测试脚本
 * @description 直接用 Ssh2Connection 测试 helper hello 握手，不经过编排器。
 */
const { Ssh2Connection } = require('../src/ssh2-connection.ts');
const { RemoteHostRegistry } = require('../src/remote-hosts.ts');
const { z } = require('zod');

async function main() {
  const registry = new RemoteHostRegistry();
  const hosts = registry.list();
  const profile = hosts.find(h => h.host === '192.168.1.82');
  if (!profile) {
    console.error('未找到 OrangePI 档案');
    process.exit(1);
  }

  console.log('=== 直接连接测试 ===');
  console.log('Node:', profile.node);
  console.log('Helper:', profile.helper);
  console.log('HelperHash:', profile.helperHash);

  const conn = new Ssh2Connection({
    host: profile.host,
    port: profile.port,
    username: profile.username,
    privateKeyPath: profile.privateKeyPath,
    node: profile.node,
    helper: profile.helper,
    helperHash: profile.helperHash,
    workspace: profile.workspace,
    requestTimeoutMs: 15000,
  });

  try {
    console.log('\n等待 helper 就绪...');
    const hello = await conn.ready;
    console.log('✓ Helper 就绪！');
    console.log('  协议版本:', hello.protocol);
    console.log('  远端 Node:', hello.node);
    console.log('  helper 摘要:', hello.hash.slice(0, 32) + '...');
    console.log('  根目录:', hello.root);

    // 测试 RPC 请求
    console.log('\n=== 测试 RPC 请求 ===');
    try {
      const result = await conn.request('executable', { command: 'ls' }, z.string(), undefined, true);
      console.log('✓ executable 查找:', result);
    } catch (err) {
      console.log('RPC 测试:', err.message);
    }

    console.log('\n断开连接...');
    await conn.dispose();
    console.log('✓ 已断开');
  } catch (err) {
    console.error('✗ 失败:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('未捕获:', err);
  process.exit(1);
});

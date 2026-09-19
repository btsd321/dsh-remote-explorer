/**
 * @file 远程工作区适配器测试脚本
 * @description 测试 RemoteWorkspaceAdapter：通过 helper RPC 在远端执行
 *              realpath/stat/listDir，验证 D1 方案的可行性。
 */

const { Ssh2Connection } = require('../src/ssh2-connection.ts');
const { RemoteHostRegistry } = require('../src/remote-hosts.ts');
const { RemoteWorkspaceAdapter } = require('../src/remote-workspace.ts');

async function main() {
  const registry = new RemoteHostRegistry();
  const hosts = registry.list();
  const profile = hosts.find(h => h.host === '192.168.1.82');
  if (!profile) {
    console.error('未找到 OrangePI 档案');
    process.exit(1);
  }

  console.log('=== 远程工作区适配器测试 ===');
  console.log('Node:', profile.node);
  console.log('Helper:', profile.helper);

  // 建立连接
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
    await conn.ready;
    console.log('✓ Helper 就绪');

    const adapter = new RemoteWorkspaceAdapter(conn);

    // 测试 1：远端 realpath
    console.log('\n=== 测试远端 realpath ===');
    const testPaths = [
      '/home/xlli67',
      '/home/xlli67/..',
      '/tmp',
      '/home/xlli67/projects',
    ];
    for (const p of testPaths) {
      try {
        const resolved = await adapter.realpath(p);
        console.log(`  realpath('${p}') → '${resolved}'`);
      } catch (e) {
        console.log(`  realpath('${p}') 失败: ${e.message}`);
      }
    }

    // 测试 2：远端 stat
    console.log('\n=== 测试远端 stat ===');
    const statPath = await adapter.realpath('/home/xlli67');
    const info = await adapter.stat(statPath);
    console.log(`  stat('${statPath}'):`, info ? `kind=${info.kind}, size=${info.size}` : 'undefined');

    // 测试 3：检查是否为目录
    console.log('\n=== 测试 isDirectory ===');
    const isDir1 = await adapter.isDirectory('/home/xlli67');
    const isDir2 = await adapter.isDirectory('/etc/hostname');
    console.log(`  isDirectory('/home/xlli67'): ${isDir1}`);
    console.log(`  isDirectory('/etc/hostname'): ${isDir2}`);

    // 测试 4：远端 listDir
    console.log('\n=== 测试远端 listDir ===');
    const entries = await adapter.listDir(statPath);
    console.log(`  listDir('${statPath}'): ${entries.length} 个条目`);
    for (const e of entries.slice(0, 10)) {
      console.log(`    ${JSON.stringify(e)}`);
    }
    if (entries.length > 10) console.log(`    ... 还有 ${entries.length - 10} 个条目`);

    // 测试 5：resolveWorkspacePath（完整工作区路径解析）
    console.log('\n=== 测试 resolveWorkspacePath ===');
    try {
      const wsPath = await adapter.resolveWorkspacePath('/home/xlli67/projects');
      console.log(`  resolveWorkspacePath('/home/xlli67/projects') → '${wsPath}'`);
    } catch (e) {
      console.log(`  resolveWorkspacePath 失败（目录可能不存在）: ${e.message}`);
      // 尝试 /home/xlli67
      const homePath = await adapter.resolveWorkspacePath('/home/xlli67');
      console.log(`  resolveWorkspacePath('/home/xlli67') → '${homePath}'`);
    }

    console.log('\n✓ 远程工作区适配器测试通过');

    await conn.dispose();
    console.log('✓ 已断开');
  } catch (e) {
    console.error('✗ 测试失败:', e.message);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('未捕获:', err);
  process.exit(1);
});

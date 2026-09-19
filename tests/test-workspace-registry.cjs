/**
 * @file 远程工作区注册表测试脚本
 * @description 测试 RemoteWorkspaceRegistry：通过 helper RPC 在远端规范化路径，
 *              创建/列表/查找/重命名/删除工作区，绑定/解绑 session。
 */

const { Ssh2Connection } = require('../src/ssh2-connection.ts');
const { RemoteHostRegistry } = require('../src/remote-hosts.ts');
const { RemoteWorkspaceAdapter } = require('../src/remote-workspace.ts');
const { RemoteWorkspaceRegistry } = require('../src/remote-workspace-registry.ts');

async function main() {
  const registry = new RemoteHostRegistry();
  const hosts = registry.list();
  const profile = hosts.find(h => h.host === '192.168.1.82');
  if (!profile) { console.error('未找到 OrangePI 档案'); process.exit(1); }

  console.log('=== 远程工作区注册表测试 ===');

  // 建立连接
  const conn = new Ssh2Connection({
    host: profile.host, port: profile.port, username: profile.username,
    privateKeyPath: profile.privateKeyPath,
    node: profile.node, helper: profile.helper, helperHash: profile.helperHash,
    workspace: profile.workspace, requestTimeoutMs: 15000,
  });

  try {
    await conn.ready;
    console.log('✓ Helper 就绪');
    const adapter = new RemoteWorkspaceAdapter(conn);
    const wsRegistry = new RemoteWorkspaceRegistry();

    // 1. 创建工作区
    console.log('\n=== 创建远程工作区 ===');
    const ws1 = await wsRegistry.create(adapter, {
      hostId: profile.id,
      path: '/home/xlli67',
      title: 'OrangePI Home',
    });
    console.log('✓ 创建工作区:', ws1.title, '→', ws1.path);

    // 2. 重复创建同路径（应返回已存在）
    const ws1dup = await wsRegistry.create(adapter, {
      hostId: profile.id,
      path: '/home/xlli67',
    });
    console.log('✓ 重复创建返回已存在:', ws1dup.id === ws1.id ? '同一ID' : '不同ID');

    // 3. 创建第二个工作区
    const ws2 = await wsRegistry.create(adapter, {
      hostId: profile.id,
      path: '/tmp',
      title: 'TMP Directory',
    });
    console.log('✓ 创建工作区:', ws2.title, '→', ws2.path);

    // 4. 列出工作区
    console.log('\n=== 列出远程工作区 ===');
    const list = wsRegistry.list(profile.id);
    console.log(`主机下 ${list.length} 个工作区:`);
    for (const ws of list) {
      console.log(`  - ${ws.title} (${ws.id.slice(0,8)}): ${ws.path}, sessions: ${ws.sessionIds.length}`);
    }

    // 5. 按路径查找
    console.log('\n=== 按路径查找 ===');
    const found = wsRegistry.getByPath(profile.id, '/home/xlli67');
    console.log('✓ 找到:', found?.title);

    // 6. 重命名
    console.log('\n=== 重命名 ===');
    wsRegistry.rename(ws2.id, 'TMP Dir');
    console.log('✓ 重命名为:', wsRegistry.get(ws2.id)?.title);

    // 7. 绑定 session
    console.log('\n=== 绑定 session ===');
    wsRegistry.attachSession(ws1.id, 'session-001');
    wsRegistry.attachSession(ws1.id, 'session-002');
    console.log('✓ 绑定后 session 数:', wsRegistry.get(ws1.id)?.sessionIds.length);

    // 8. 解绑 session
    wsRegistry.detachSession(ws1.id, 'session-001');
    console.log('✓ 解绑后 session 数:', wsRegistry.get(ws1.id)?.sessionIds.length);

    // 9. 删除工作区
    console.log('\n=== 删除工作区 ===');
    const deleted = wsRegistry.delete(ws2.id);
    console.log('✓ 删除', ws2.title, ':', deleted);
    console.log('删除后工作区数:', wsRegistry.list(profile.id).length);

    // 10. 持久化验证
    console.log('\n=== 持久化验证 ===');
    const wsRegistry2 = new RemoteWorkspaceRegistry();
    console.log('重新加载后工作区数:', wsRegistry2.list(profile.id).length);
    const persisted = wsRegistry2.get(ws1.id);
    console.log('持久化记录:', persisted?.title, '→', persisted?.path, ', sessions:', persisted?.sessionIds.length);

    // 清理测试数据
    wsRegistry.delete(ws1.id);
    console.log('\n✓ 测试完成，已清理测试数据');

    await conn.dispose();
    console.log('✓ 已断开');
  } catch (e) {
    console.error('✗ 测试失败:', e.message);
    process.exit(1);
  }
}

main().catch(err => { console.error('未捕获:', err); process.exit(1); });

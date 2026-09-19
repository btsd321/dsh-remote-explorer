/**
 * @file 引导测试脚本
 * @description 测试 RemoteBootstrap：探测远端环境 + 自动安装 Node + 上传 helper。
 *              使用 OrangePI 测试主机。
 */

const { RemoteBootstrap } = require('../src/remote-bootstrap.ts');
const { RemoteHostRegistry } = require('../src/remote-hosts.ts');
const path = require('path');
const os = require('os');

async function main() {
  // 找到 dsh-ssh 的 helper 打包目录（自包含 bundle）
  const helperDir = path.join(__dirname, '..', '..', 'deepseek-harness', 'packages', 'ssh', 'ssh', 'lib', 'bundle');
  const fs = require('fs');
  if (!fs.existsSync(path.join(helperDir, 'helper.mjs'))) {
    console.error('helper.mjs 不存在:', helperDir);
    console.error('请先运行: tsdown --config tsdown.bundle.config.ts');
    process.exit(1);
  }
  console.log('helper bundle 目录:', helperDir);

  // 创建主机档案
  const registry = new RemoteHostRegistry();
  const profile = registry.create({
    title: 'OrangePI',
    host: '192.168.1.82',
    port: 22,
    username: 'xlli67',
    privateKeyPath: path.join(os.homedir(), '.ssh', 'xlli67'),
    workspace: '/home/xlli67/projects',
    proxy: 'http://127.0.0.1:18890',
  });
  console.log('主机档案已创建:', profile.id);

  // 探测远端
  const bootstrap = new RemoteBootstrap();
  console.log('\n=== 探测远端环境 ===');
  const probe = await bootstrap.probe(profile);
  console.log('操作系统:', probe.os);
  console.log('架构:', probe.arch);
  console.log('Node 路径:', probe.nodePath);
  console.log('Node 版本:', probe.nodeVersion);
  console.log('Node 是否满足:', probe.nodeSufficient);
  console.log('helper 已安装:', probe.helperInstalled);

  // 执行全自动引导
  console.log('\n=== 执行全自动引导 ===');
  const result = await bootstrap.bootstrap(profile, helperDir);
  console.log('引导结果:');
  console.log('  Node 路径:', result.node);
  console.log('  helper 路径:', result.helper);
  console.log('  helper 摘要:', result.helperHash);
  console.log('  Node 新安装:', result.nodeInstalled);
  console.log('  helper 新上传:', result.helperUploaded);

  // 更新档案
  registry.update(profile.id, {
    node: result.node,
    helper: result.helper,
    helperHash: result.helperHash,
  });
  console.log('\n✓ 主机档案已更新');
}

main().catch(err => {
  console.error('测试失败:', err);
  process.exit(1);
});

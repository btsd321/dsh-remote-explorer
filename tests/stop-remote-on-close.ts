/**
 * @file Ctrl-C 停远端行为的验证脚本
 * @description Windows 后台进程收不到合成 SIGINT（Node 只能监听不能发送），
 *              无法自动化「按键」那一步。此脚本直接走 Ctrl-C 处理器的同一条
 *              终点路径——openSession 后 close({ stopRemote: true })——
 *              验证「断开即停止远端 dsh」的关闭逻辑本身。
 *
 * 用法：npx tsx tests/stop-remote-on-close.ts <主机别名>
 */

import { openSession } from '../src/session/session-manager.js';

const alias = process.argv[2] ?? 'OrangePI';

const session = await openSession({
  hostAlias: alias,
  remoteCwd: '/tmp',
  localPort: 18966,
});

console.log(`会话就绪：远端 pid ${session.remotePid}，端口 ${session.remotePort}`);

// 模拟 Ctrl-C 后 connect.ts 的关闭调用
console.log('调用 close({ stopRemote: true })…');
await session.close({ stopRemote: true });
console.log('close 返回。请检查远端进程是否已退出（脚本外用 kill -0 验证）');
process.exit(0);

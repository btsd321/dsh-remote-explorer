/**
 * @file slash 命令注册
 * @description 用户侧入口：`/remote-ssh <子动作>` 单命令多子动作，
 *              在 dsh 聊天输入框里管理远程会话。
 *
 * 子动作：
 * - `hosts`                          列出 ~/.ssh/config 的主机别名
 * - `connect <别名> [远端目录]`       后台发起连接（立即返回，进度看 status）
 * - `status`                         会话表（含其他本机进程的 external 视图）
 * - `disconnect <别名|会话id> [--keep-remote]`
 *                                    断开；默认连远端 dsh 一起停（对齐 CLI Ctrl-C 语义）
 *
 * 命名纪律（scripts/check-plugin.ts 强制）：命令名必须匹配
 * /^[a-z][a-z0-9_-]*$/——非法字符会让整个 dsh 启动失败（参考插件踩过：
 * 带点号的命令名掀翻了 Desktop）。`remote-ssh` 与内置命令（compact/feedback/goal）
 * 及第三方 dsh-remote 插件（remote/remote-*）都不冲突。
 *
 * commands 是可选服务（headless 组合可能没有）：ctx.get 取不到就静默跳过，
 * 绝不属性直取——那会在缺服务的组合里直接抛错。
 */

import type { Context } from '@deepseek-ai/cordis';
// 激活 ctx.commands 的类型增广（CommandsHost.register）
import type {} from '@deepseek-ai/dsh-commands';
import { listHosts, refreshConfig } from '../hosts/ssh-config-parser.js';
import { toErrorMessage } from '../util/errors.js';
import { SessionSupervisor, SupervisorError, type SessionSnapshot } from './supervisor.js';

/**
 * 注册 /remote-ssh 命令。
 *
 * @param ctx - 插件上下文
 * @param supervisor - 会话监督器
 * @returns 清理函数（commands 服务缺席时为空操作）
 */
export function registerCommands(ctx: Context, supervisor: SessionSupervisor): () => void {
  const commands = ctx.get('commands');
  if (commands === undefined) return () => { /* 该组合没有命令服务，跳过 */ };

  return commands.register({
    name: 'remote-ssh',
    description: '管理远程 dsh 会话：hosts | connect <别名> [远端目录] | status | disconnect <别名|会话id> [--keep-remote]',
    input: { hint: '<hosts|connect|status|disconnect> …' },
    handler: async ({ rawInput }) => {
      const args = rawInput.trim().split(/\s+/).filter(part => part !== '');
      const action = args[0] ?? 'help';
      try {
        switch (action) {
          case 'hosts':
            return { kind: 'success', text: renderHosts() };
          case 'connect':
            return { kind: 'success', text: doConnect(supervisor, args.slice(1)) };
          case 'status':
            return { kind: 'success', text: renderStatus(supervisor) };
          case 'disconnect':
            return { kind: 'success', text: await doDisconnect(supervisor, args.slice(1)) };
          default:
            return { kind: 'success', text: USAGE };
        }
      } catch (error) {
        return { kind: 'error', text: toErrorMessage(error) };
      }
    },
  });
}

/** 用法文本（无参数或未知子动作时返回） */
const USAGE = [
  '/remote-ssh — 管理远程 dsh 会话',
  '  hosts                             列出 ~/.ssh/config 的主机别名',
  '  connect <别名> [远端目录]          后台连接并启动远端 dsh（进度看 status）',
  '  status                            会话列表与状态',
  '  disconnect <别名|会话id> [--keep-remote]   断开（默认连远端一起停）',
  '远端目录示例：/home/youruser（Git Bash 里用双斜杠 //home/youruser）',
].join('\n');

/**
 * 渲染主机列表。
 *
 * @returns 文本
 */
function renderHosts(): string {
  // 长驻进程里 config 可能被用户改过——每次列表前刷新缓存（读文件很便宜）
  refreshConfig();
  const hosts = listHosts();
  if (hosts.length === 0) return '~/.ssh/config 里没有 Host 条目';
  const lines = hosts.map(host =>
    `  ${host.alias}  →  ${host.user === '' ? '' : `${host.user}@`}${host.hostName}:${host.port}`
    + (host.hasProxyJump ? `（经 ${host.proxyJump ?? '跳板机'}）` : ''));
  return `可用主机（${hosts.length} 台）：\n${lines.join('\n')}`;
}

/**
 * 发起连接子动作。
 *
 * @param supervisor - 监督器
 * @param args - [别名, 远端目录?]
 * @returns 结果文本
 */
function doConnect(supervisor: SessionSupervisor, args: string[]): string {
  const alias = args[0];
  if (alias === undefined) {
    throw new SupervisorError('bad_usage', '用法：/remote-ssh connect <别名> [远端目录]（hosts 子命令可列别名）');
  }
  const snapshot = supervisor.startConnect({
    hostAlias: alias,
    ...(args[1] !== undefined ? { cwd: args[1] } : {}),
  });
  return `已在后台发起连接 ${snapshot.hostAlias}（会话 ${snapshot.sessionId.slice(0, 12)}…）。\n`
    + '用 /remote-ssh status 查看进度；就绪后浏览器打开会话 URL（Web 面板 Settings → 远程 SSH 会话 亦可）。';
}

/**
 * 渲染会话状态表。
 *
 * @param supervisor - 监督器
 * @returns 文本
 */
function renderStatus(supervisor: SessionSupervisor): string {
  const snapshots = supervisor.list();
  if (snapshots.length === 0) {
    return '当前没有会话。用 /remote-ssh connect <别名> [远端目录] 发起连接';
  }
  const lines = snapshots.map(snapshot => {
    const state = describeSnapshot(snapshot);
    const port = snapshot.localPort !== undefined ? `本机端口 ${snapshot.localPort}` : '端口未分配';
    const external = snapshot.external === true ? '［其他本机进程维持，只读］' : '';
    const url = snapshot.url !== undefined ? `\n    ${snapshot.url}` : '';
    return `  ${snapshot.hostAlias} → ${snapshot.remoteCwd === '' ? '~' : snapshot.remoteCwd}\n`
      + `    ${state}，${port}${external}${url}`;
  });
  return `会话（${snapshots.length} 个）：\n${lines.join('\n')}`;
}

/**
 * 断开子动作。
 *
 * @param supervisor - 监督器
 * @param args - [目标, ...旗标]
 * @returns 结果文本
 */
async function doDisconnect(supervisor: SessionSupervisor, args: string[]): Promise<string> {
  const target = args[0];
  if (target === undefined) {
    throw new SupervisorError('bad_usage', '用法：/remote-ssh disconnect <别名|会话id> [--keep-remote]');
  }
  const keepRemote = args.includes('--keep-remote');
  const sessionId = await supervisor.disconnect(target, !keepRemote);
  return keepRemote
    ? `已断开 ${sessionId.slice(0, 12)}…（远端 dsh 保留，下次连接可复用）`
    : `已断开 ${sessionId.slice(0, 12)}… 并停止远端 dsh`;
}

/**
 * 把快照的状态翻成一句中文描述。
 *
 * @param snapshot - 会话快照
 * @returns 状态文本
 */
function describeSnapshot(snapshot: SessionSnapshot): string {
  if (snapshot.connecting) return '连接中';
  if (snapshot.connectError !== undefined) return `连接失败：${snapshot.connectError}`;
  switch (snapshot.state.tag) {
    case 'connected':
      return `已连接（远端 pid ${snapshot.remotePid ?? '?'}）`;
    case 'heartbeat-missed':
      return `心跳丢失 ${snapshot.state.missedHeartbeats} 次`;
    case 'reconnecting':
      return `重连中（第 ${snapshot.state.reconnectAttempts} 次）`;
    case 'reconnect-failed':
      return `重连失败（还剩余量，最近错误：${snapshot.state.lastError ?? '未知'}）`;
    case 'reconnect-exhausted':
      return '重连次数用尽，会话终结';
    case 'disconnected':
      return '已断开';
    default:
      return snapshot.state.tag;
  }
}

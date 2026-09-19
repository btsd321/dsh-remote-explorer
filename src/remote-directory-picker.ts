/**
 * @file 远程目录选择器适配
 * @description 当 SSH 连接就绪时，替换 dsh 的 ctx.directoryPicker 的 list 方法
 *              为远端目录列表，让 dsh 主界面的"添加工作区"和目录选择器
 *              自动浏览远端目录而非本地目录。
 *
 * 实现方式：通过 ctx.inject(['directoryPicker']) 获取已有的 directoryPicker 服务，
 * 然后用 ctx.provide 覆盖它的 capability 对象，让 list 方法走 SSH RPC。
 * 当 SSH 断开时恢复原始的本地 list 方法。
 */

import type { Context } from '@deepseek-ai/cordis';
import type { RemoteHostController } from './api/remote-host-controller.js';
import type { ConnectionEvent } from './remote-connection.js';

/**
 * 安装远程目录选择器适配
 *
 * 当 SSH 连接就绪时，包装 ctx.directoryPicker 让它走远端目录列表。
 * 当 SSH 断开时，恢复本地目录列表。
 *
 * @param ctx - Cordis 上下文
 * @param controller - 远程主机管理 controller
 */
export function installRemoteDirectoryPicker(ctx: Context, controller: RemoteHostController): void {
  let originalCapability: any = null;

  function switchToRemote(): void {
    const picker = ctx.get('directoryPicker');
    if (!picker) return;
    const cap = picker.capability();
    if (cap.kind !== 'browse') return;

    // 保存原始 capability
    if (!originalCapability) {
      originalCapability = {
        kind: 'browse',
        list: cap.list,
        createDirectory: cap.createDirectory,
      };
    }

    // 替换 list 为远端列表
    cap.list = async (path: string | undefined, signal?: AbortSignal) => {
      const conn = controller.connectionOrchestrator.activeConnection;
      if (!conn) throw new Error('SSH 连接未就绪');

      // 通过 SSH RPC 列出远端目录
      const remotePath = path || '.';
      const entries = await conn.request('fs.list', {
        target: { targetKey: remotePath, displayPath: remotePath },
      }, (await import('zod')).z.array((await import('zod')).z.object({}).passthrough()));

      // 转换为 DirectoryListing 格式
      const dirs = entries.filter((e: any) => (e.type || e.kind) === 'directory');
      return {
        path: path || '/home',
        home: '/home',
        crumbs: buildCrumbs(path || '/home'),
        entries: dirs.map((e: any) => ({
          name: e.name || e.target?.displayPath?.split('/').pop() || '?',
          path: e.target?.displayPath || (path ? path + '/' + (e.name || '') : e.name || ''),
          hidden: (e.name || '').startsWith('.'),
        })),
        truncated: false,
      };
    };

    // createDirectory 暂不支持远端创建
    cap.createDirectory = async (path: string, name: string) => {
      throw new Error('远端目录创建暂不支持');
    };

    console.log('[dsh-remote-ssh] 目录选择器已切换到远端模式');
  }

  function switchToLocal(): void {
    const picker = ctx.get('directoryPicker');
    if (!picker || !originalCapability) return;
    const cap = picker.capability();
    if (cap.kind !== 'browse') return;

    cap.list = originalCapability.list;
    cap.createDirectory = originalCapability.createDirectory;
    console.log('[dsh-remote-ssh] 目录选择器已切换回本地模式');
  }

  // 监听连接状态变化
  const unsub = controller.subscribeStateChanges((event: ConnectionEvent) => {
    if (event.state === 'ready') {
      switchToRemote();
    } else if (event.state === 'disconnected' || event.state === 'lost' || event.state === 'failed') {
      switchToLocal();
    }
  });

  // 在 ctx 销毁时取消订阅
  ctx.effect(() => () => unsub());
}

/** 构建路径面包屑 */
function buildCrumbs(path: string): { name: string; path: string; hidden: boolean }[] {
  const crumbs: { name: string; path: string; hidden: boolean }[] = [];
  const parts = path.split('/').filter(Boolean);
  let current = '';
  for (const part of parts) {
    current += '/' + part;
    crumbs.push({ name: part, path: current, hidden: false });
  }
  if (crumbs.length === 0) crumbs.push({ name: '/', path: '/', hidden: false });
  return crumbs;
}

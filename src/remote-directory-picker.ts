/**
 * @file 远程目录选择器适配
 * @description 当 SSH 连接就绪时，把 dsh 的 ctx.directoryPicker 的 browse 能力
 *              重定向到远端主机，让主界面的"添加工作区"和目录选择器浏览远端目录
 *              而非本地目录；连接断开时还原为本地实现。
 *
 * 前置条件：directoryPicker 必须是 browse 后端。
 * directory-picker-auto 在 Windows/macOS + 回环绑定下会解析为 native 后端，
 * 而 native 能力只有 pick(signal)——在宿主机屏幕上弹操作系统文件对话框，
 * 语义上无法浏览远端目录。因此本插件的 cordis.patch.yml 禁用了 auto 行并
 * 直接钉住 browse 的后端与前端界面。若检测到 native，这里会打印告警并放弃接管。
 *
 * 实现方式：browse 能力对象在服务生命周期内是稳定引用（seam 契约如此声明），
 * 且 DirectoryPickerController 每次 wire 调用都重新取 capability()，
 * 所以这里原地改写该对象的 list/createDirectory，断开时再把原实现写回。
 *
 * 远端路径的两个坑：
 * 1. helper 的 fs.resolve 不展开 `~`（传 `~` 得到 `<cwd>/~`），必须用绝对路径，
 *    起点从 ConnectionOrchestrator.currentRemoteHome 取。
 * 2. fs.list 返回的条目类型字段是 `type`（不是本地 fs 的 `kind`），
 *    路径在 `target.targetKey` / `target.displayPath`。
 */

import { z } from 'zod';
import type { Context } from '@deepseek-ai/cordis';
import type { RemoteHostController } from './api/remote-host-controller.js';
import type { ConnectionEvent } from './remote-connection.js';

/** 目录条目（与 dsh 的 DirectoryEntry 对应） */
interface DirectoryEntry {
  /** 条目显示名 */
  name: string;
  /** 绝对路径 */
  path: string;
  /** 是否按平台约定隐藏（POSIX 下以 . 开头） */
  hidden: boolean;
}

/** 一层目录列表（与 dsh 的 DirectoryListing 对应） */
interface DirectoryListing {
  /** 被列出目录的绝对路径 */
  path: string;
  /** 远端账户的 home 目录 */
  home: string;
  /** 从根到当前目录（含）的祖先链，每一节都可跳转 */
  crumbs: DirectoryEntry[];
  /** 直接子目录，按名称排序 */
  entries: DirectoryEntry[];
  /** 是否因后端上限截断了 entries */
  truncated: boolean;
}

/** fs.list 返回的单个远端条目（字段放宽，远端 helper 可能多带字段） */
const remoteEntrySchema = z.object({
  name: z.string().optional(),
  type: z.string().optional(),
  kind: z.string().optional(),
  target: z.object({
    targetKey: z.string().optional(),
    displayPath: z.string().optional(),
  }).passthrough().optional(),
}).passthrough();

/** fs.list 响应 schema */
const remoteEntriesSchema = z.array(remoteEntrySchema);

/** 原始 browse 能力的备份（用于断开时还原） */
interface OriginalCapability {
  list: (path?: string, signal?: AbortSignal) => Promise<DirectoryListing>;
  createDirectory: (path: string, name: string) => Promise<string>;
}

/**
 * 规范化远端 POSIX 路径：折叠重复斜杠、解析 . 和 ..、去掉末尾斜杠。
 *
 * 不能用 node:path 的 posix.normalize 之外的接口——宿主可能是 Windows，
 * 用 join/resolve 会产出反斜杠并按本地盘符解析。
 *
 * @param path - 远端绝对路径
 * @returns 规范化后的绝对路径（根目录返回 "/"）
 */
function normalizeRemotePath(path: string): string {
  const segments: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') { segments.pop(); continue; }
    segments.push(part);
  }
  return '/' + segments.join('/');
}

/**
 * 构建从根到目标目录（含）的面包屑链。
 *
 * 契约要求第一节是文件系统根，且每节 hidden 恒为 false。
 *
 * @param path - 已规范化的远端绝对路径
 * @returns 面包屑列表
 */
function buildCrumbs(path: string): DirectoryEntry[] {
  const crumbs: DirectoryEntry[] = [{ name: '/', path: '/', hidden: false }];
  let current = '';
  for (const part of path.split('/')) {
    if (part === '') continue;
    current += '/' + part;
    crumbs.push({ name: part, path: current, hidden: false });
  }
  return crumbs;
}

/**
 * 安装远程目录选择器适配。
 *
 * 连接就绪时接管 browse 能力走远端，断开/失败时还原本地实现。
 * 安装时若连接已就绪，立即接管（避免错过已发生的 ready 事件）。
 *
 * @param ctx - Cordis 上下文（需要 ctx.directoryPicker 可用）
 * @param controller - 远程主机管理 controller
 */
export function installRemoteDirectoryPicker(ctx: Context, controller: RemoteHostController): void {
  /** 原始本地实现备份；非空表示当前处于远端模式 */
  let original: OriginalCapability | undefined;

  /**
   * 列出远端目录的一层（替换 browse.list）
   *
   * @param path - 远端绝对路径；缺省列出远端 home
   * @param signal - 调用方生命周期信号
   * @returns 该层目录列表
   */
  async function listRemote(path?: string, signal?: AbortSignal): Promise<DirectoryListing> {
    const orchestrator = controller.connectionOrchestrator;
    const conn = orchestrator.activeConnection;
    if (!conn) throw new Error('SSH 连接未就绪，无法浏览远端目录');

    const home = orchestrator.currentRemoteHome;
    if (!home) throw new Error('远端 home 目录未知，无法浏览远端目录');

    // 远端是 POSIX：只接受绝对路径，缺省用 home。
    // 不接受相对路径——远端 fs.resolve 会把它挂到 helper 的 cwd 下。
    if (path !== undefined && !path.startsWith('/')) {
      throw new Error(`无法列出 "${path}"：远端路径必须是绝对路径`);
    }
    const target = normalizeRemotePath(path ?? home);

    const entries = await conn.request(
      'fs.list',
      { target: { targetKey: target, displayPath: target } },
      remoteEntriesSchema,
      signal,
    );

    const dirs: DirectoryEntry[] = [];
    for (const entry of entries) {
      // 远端返回 type，兼容可能的 kind
      if ((entry.type ?? entry.kind) !== 'directory') continue;
      const childPath = entry.target?.targetKey ?? entry.target?.displayPath
        ?? (entry.name ? normalizeRemotePath(target + '/' + entry.name) : undefined);
      if (!childPath) continue;
      const name = entry.name ?? childPath.slice(childPath.lastIndexOf('/') + 1);
      dirs.push({ name, path: childPath, hidden: name.startsWith('.') });
    }
    dirs.sort((a, b) => a.name.localeCompare(b.name));

    return {
      path: target,
      home,
      crumbs: buildCrumbs(target),
      entries: dirs,
      // helper 的 fs.list 返回完整一层，这里不做截断
      truncated: false,
    };
  }

  /**
   * 远端创建目录（替换 browse.createDirectory）
   *
   * 远端 helper 的 fs.* 方法里没有 mkdir 原语，因此该能力在远端模式下不可用。
   * 明确抛错而不是静默失败，让前端把失败原因展示给用户。
   */
  function createDirectoryRemote(): Promise<string> {
    return Promise.reject(new Error('远端模式下暂不支持创建目录：helper 未提供 mkdir 原语，请在远端主机上手动创建'));
  }

  /** 接管为远端模式 */
  function switchToRemote(): void {
    const picker = ctx.get('directoryPicker');
    if (!picker) return;
    const cap = picker.capability() as any;
    if (cap.kind !== 'browse') {
      console.warn(
        `[dsh-remote-ssh] ctx.directoryPicker 是 "${cap.kind}" 后端，无法重定向到远端。`
        + ' native 后端只能在宿主机屏幕弹本地对话框；'
        + ' 请确认已加载本插件的 cordis.patch.yml（它会钉住 browse 后端）。',
      );
      return;
    }
    if (original) return; // 已处于远端模式

    original = { list: cap.list, createDirectory: cap.createDirectory };
    cap.list = listRemote;
    cap.createDirectory = createDirectoryRemote;
    console.log('[dsh-remote-ssh] 目录选择器已切换到远端模式');
  }

  /** 还原为本地模式 */
  function switchToLocal(): void {
    if (!original) return;
    const picker = ctx.get('directoryPicker');
    if (picker) {
      const cap = picker.capability() as any;
      if (cap.kind === 'browse') {
        cap.list = original.list;
        cap.createDirectory = original.createDirectory;
        console.log('[dsh-remote-ssh] 目录选择器已切换回本地模式');
      }
    }
    original = undefined;
  }

  // 安装时连接可能已经就绪（ready 事件早于本次 inject 触发），立即补一次接管
  if (controller.connectionOrchestrator.state === 'ready') switchToRemote();

  const unsub = controller.subscribeStateChanges((event: ConnectionEvent) => {
    if (event.state === 'ready') {
      switchToRemote();
    } else if (event.state === 'disconnected' || event.state === 'lost' || event.state === 'failed') {
      switchToLocal();
    }
  });

  // ctx 销毁时取消订阅并还原本地实现，避免留下指向已断连接的 list
  ctx.effect(() => () => {
    unsub();
    switchToLocal();
  });
}

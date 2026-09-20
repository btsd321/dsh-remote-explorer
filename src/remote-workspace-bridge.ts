/**
 * @file 远程工作区桥接
 * @description 让 dsh 的 ctx.workspaceRegistry 能在远端 POSIX 路径上创建工作区。
 *              SSH 连接就绪时接管路径解析，断开时还原本地实现。
 *
 * 为什么需要这个模块：
 * dsh 的 WorkspaceRegistry 把路径校验和规范化硬编码在 node:fs 上，两处都拦住远端路径：
 * 1. fullyQualifiedWorkspacePath 按**宿主平台**判定。宿主是 Windows 时走 win32 分支，
 *    而 `/home/user/proj` 的 root 正是 `/`，被显式拒绝，报
 *    "Workspace path is not fully qualified"。
 * 2. 即使放过校验，realpathNormalize 紧接着调本地 realpath 解析，远端路径必然 ENOENT。
 * WorkspaceRegistry 不走 ctx.fs 接缝（它直接 import { stat } from 'node:fs/promises'），
 * 所以组合官方的 fs-ssh provider 也绕不过去。
 *
 * 接管方式：
 * 原地改写 registry 实例的 create/resolveByPath，以及远端工作区 entity 的
 * attachSession/status，把路径解析换成 helper RPC；持久化仍复用 dsh 自己的
 * createCanonical/mutate，不重写事务逻辑（记录写入、pendingMutation 回滚都保持原语义）。
 *
 * 这里访问了 dsh 标记为 private 的成员（createCanonical、enqueueOperation、entities、
 * host、mutate）。它们是 TypeScript 的 private 关键字而非 ECMAScript # 私有字段，
 * 仅在编译期约束，运行时可访问。这是插件侧不改 harness 源码的代价：
 * dsh 升级若重命名这些成员，本模块需要同步跟进。
 */

import type { Context } from '@deepseek-ai/cordis';
import type { RemoteHostController } from './api/remote-host-controller.js';
import { RemoteWorkspaceAdapter } from './remote-workspace.js';
import type { ConnectionEvent } from './remote-connection.js';

/** dsh 的 Workspace 实体（只列本模块用到的成员） */
interface WorkspaceLike {
  /** 工作区规范路径 */
  readonly path: string;
  /** 绑定的 session ID 列表 */
  readonly sessionIds: readonly string[];
  /** 绑定一个 session */
  attachSession(sessionId: string): Promise<void>;
  /** 工作区目录当前是否可用 */
  status(): Promise<'ok' | 'missing-dir'>;
}

/** 被接管前的 registry 原始方法 */
interface OriginalRegistry {
  create: (path: string, title?: string) => Promise<WorkspaceLike>;
  resolveByPath: (path: string) => Promise<WorkspaceLike | undefined>;
}

/** 被接管前的 entity 原始方法 */
interface OriginalEntity {
  attachSession: (sessionId: string) => Promise<void>;
  status: () => Promise<'ok' | 'missing-dir'>;
}

/** 标记已被接管的 entity，避免重复包裹 */
const PATCHED = Symbol('dsh-remote-ssh.patched');

/**
 * 安装远程工作区桥接。
 *
 * 连接就绪时接管 registry 的路径解析，断开时还原。
 *
 * @param ctx - Cordis 上下文（需要 ctx.workspaceRegistry 可用）
 * @param controller - 远程主机管理 controller
 */
export function installRemoteWorkspaceBridge(ctx: Context, controller: RemoteHostController): void {
  /** registry 原始方法备份；非空表示当前处于远端模式 */
  let original: OriginalRegistry | undefined;
  /** 已接管的 entity 及其原始方法，用于断开时还原 */
  const patchedEntities = new Map<WorkspaceLike, OriginalEntity>();

  /**
   * 取当前可用的远端工作区适配器
   * @returns 适配器；连接未就绪时返回 undefined
   */
  function adapter(): RemoteWorkspaceAdapter | undefined {
    const conn = controller.connectionOrchestrator.activeConnection;
    return conn ? new RemoteWorkspaceAdapter(conn) : undefined;
  }

  /**
   * 判断该路径是否应按远端解析。
   *
   * 远端是 POSIX，路径必以 `/` 开头。宿主是 Windows 时这类路径不可能是合法本地
   * 工作区路径（win32 判定会拒绝 root 为 `/` 的路径），可直接判定为远端；
   * 宿主是 POSIX 时无法只靠拼写区分，远端解析失败会回落到本地实现。
   *
   * @param path - 待判断路径
   * @returns 是否按远端解析
   */
  function looksRemote(path: string): boolean {
    return adapter() !== undefined && path.startsWith('/');
  }

  /**
   * 接管一个远端工作区 entity 的 attachSession/status。
   *
   * 这两个方法在原实现里都走本地 node:fs，对远端路径必然失败：
   * attachSession 会拒绝挂载 session，status 会把工作区报成 missing-dir。
   *
   * @param entity - dsh 的工作区实体
   * @returns 同一个 entity（原地改写，便于链式返回）
   */
  function patchEntity(entity: WorkspaceLike): WorkspaceLike {
    const target = entity as WorkspaceLike & { [PATCHED]?: true };
    if (target[PATCHED]) return entity;

    const host = (entity as any).host;
    const originalAttach = entity.attachSession.bind(entity);
    const originalStatus = entity.status.bind(entity);
    patchedEntities.set(entity, { attachSession: originalAttach, status: originalStatus });

    (entity as any).attachSession = async (sessionId: string): Promise<void> => {
      const fs = adapter();
      // 连接已断开时回落原实现，让它按本地语义报错
      if (!fs) { await originalAttach(sessionId); return; }

      // 已记账的 session 不重复校验：cwd 事实在首次挂载时已验证，
      // 且 header cwd 与工作区路径都不可变（与 dsh 原实现的判断一致）
      if (!entity.sessionIds.includes(sessionId)) {
        const header = await host.readSessionHeader(sessionId);
        if (header.cwd === undefined) {
          throw new Error(
            `无法把 session '${sessionId}' 挂载到远端工作区 '${entity.path}'：`
            + '它的存档 header 没有 cwd 可供校验',
          );
        }
        let cwd: string;
        try {
          cwd = await fs.realpath(String(header.cwd));
        } catch (error) {
          throw new Error(
            `无法把 session '${sessionId}' 挂载到远端工作区 '${entity.path}'：`
            + `它的 cwd '${String(header.cwd)}' 在远端无法解析`,
            { cause: error },
          );
        }
        if (cwd !== entity.path) {
          throw new Error(
            `无法把 session '${sessionId}' 挂载到远端工作区 '${entity.path}'：`
            + `它的 cwd 解析为 '${cwd}'`,
          );
        }
        // 写入 registry 的 session 路径索引，否则 mutate 的剪枝会把它裁掉
        host.rememberSessionPath(sessionId, cwd);
      }
      // 复用 dsh 自己的写链，保持 updatedAt 戳与剪枝语义
      await (entity as any).mutate((record: any) => record.sessionIds.includes(sessionId)
        ? record
        : { ...record, sessionIds: [sessionId, ...record.sessionIds] });
    };

    (entity as any).status = async (): Promise<'ok' | 'missing-dir'> => {
      const fs = adapter();
      if (!fs) return await originalStatus();
      try {
        return (await fs.isDirectory(entity.path)) ? 'ok' : 'missing-dir';
      } catch {
        // 任何远端探测失败都表示该目录此刻不可用；记录本身不变
        return 'missing-dir';
      }
    };

    target[PATCHED] = true;
    return entity;
  }

  /**
   * 把远端工作区已记账的 session 重新写入 registry 的路径索引。
   *
   * registry 启动时用本地 realpathNormalize 建索引，远端路径会全部落入
   * invalidSessionPaths，导致下一次 mutate 的剪枝把这些 session 从工作区裁掉。
   * 这些 session 的 cwd 事实在首次挂载时已验证，且 header cwd 与工作区路径都不可变，
   * 所以这里按记录直接回填。
   *
   * @param registry - dsh 的工作区 registry
   */
  function reseedSessionPaths(registry: any): void {
    const host = registry.host;
    for (const entity of registry.entities.values() as Iterable<WorkspaceLike>) {
      if (!entity.path.startsWith('/')) continue;
      const record = (entity as any).record;
      for (const sessionId of record?.sessionIds ?? []) {
        host.rememberSessionPath(sessionId, entity.path);
      }
    }
  }

  /** 接管为远端模式 */
  function switchToRemote(): void {
    const registry: any = ctx.get('workspaceRegistry');
    if (!registry || original) return;

    original = {
      create: registry.create.bind(registry),
      resolveByPath: registry.resolveByPath.bind(registry),
    };
    const local = original;

    registry.create = async (path: string, title?: string): Promise<WorkspaceLike> => {
      const fs = adapter();
      if (!fs || !looksRemote(path)) return await local.create(path, title);
      let canonical: string;
      try {
        // 远端规范化 + 目录校验（helper RPC 的 fs.resolve + fs.stat）
        canonical = await fs.resolveWorkspacePath(path);
      } catch (error) {
        // 宿主是 POSIX 时该路径可能确实是本地路径，回落本地实现
        if (process.platform !== 'win32') return await local.create(path, title);
        throw error;
      }
      // 持久化复用 dsh 自己的事务：写记录、pendingMutation 回滚都保持原语义
      const entity: WorkspaceLike = await registry.enqueueOperation(
        () => registry.createCanonical(canonical, title),
      );
      return patchEntity(entity);
    };

    registry.resolveByPath = async (path: string): Promise<WorkspaceLike | undefined> => {
      const fs = adapter();
      if (!fs || !looksRemote(path)) return await local.resolveByPath(path);
      let canonical: string;
      try {
        canonical = await fs.realpath(path);
      } catch (error) {
        if (process.platform !== 'win32') return await local.resolveByPath(path);
        throw error;
      }
      for (const entity of registry.entities.values() as Iterable<WorkspaceLike>) {
        if (entity.path === canonical) return patchEntity(entity);
      }
      return undefined;
    };

    // 接管已存在的远端工作区（重启后 registry 会重建 entity）
    for (const entity of registry.entities.values() as Iterable<WorkspaceLike>) {
      if (entity.path.startsWith('/')) patchEntity(entity);
    }
    reseedSessionPaths(registry);

    console.log('[dsh-remote-ssh] 工作区注册表已切换到远端模式');
  }

  /** 还原为本地模式 */
  function switchToLocal(): void {
    if (!original) return;
    const registry: any = ctx.get('workspaceRegistry');
    if (registry) {
      registry.create = original.create;
      registry.resolveByPath = original.resolveByPath;
      for (const [entity, methods] of patchedEntities) {
        (entity as any).attachSession = methods.attachSession;
        (entity as any).status = methods.status;
        delete (entity as any)[PATCHED];
      }
      console.log('[dsh-remote-ssh] 工作区注册表已切换回本地模式');
    }
    patchedEntities.clear();
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

  // ctx 销毁时取消订阅并还原，避免留下指向已断连接的方法
  ctx.effect(() => () => {
    unsub();
    switchToLocal();
  });
}

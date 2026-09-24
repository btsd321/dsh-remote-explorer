/**
 * @file 远端插件包管理
 * @description 从 supervisor.ts 拆出的独立模块：list/install/remove/toggle
 *              四个公开操作 + 三个私有辅助（remotePluginRows / remoteRegistry /
 *              sessionIo）。对 SessionSupervisor 的依赖经回调注入，不直接 import。
 *
 * 关注点分离：supervisor 负责会话簿记（登记表/快照/回调接线/查找），本模块
 * 只关心「在已就绪会话上操作远端 pnpm store」。两者可独立演进。
 */

import type { RemoteSession } from '../session/session-manager.js';
import { toErrorMessage } from '../util/errors.js';
import { quote } from '../util/shell-quote.js';
import {
  readPluginStoreManifest, syncSessionManifest, writePluginStoreManifest,
  type ManifestIo,
} from '../provision/plugin-store.js';
import type { RemotePluginInfo, SupervisorErrorCode } from './supervisor.js';

/** 远端插件 pnpm 操作超时（毫秒）。装一个中型包分钟级足够 */
const REMOTE_PLUGIN_TIMEOUT_MS = 600_000;

/**
 * 监督器向本模块注入的最小能力接口。
 *
 * 设计意图：避免 RemotePluginStore 直接依赖 SessionSupervisor 类，
 * 让两个模块可以独立测试与演进。
 */
export interface PluginStoreHost {
  /**
   * 取一个本进程登记且已就绪的会话。
   *
   * @param sessionId - 会话 id
   * @returns 会话对象
   * @throws 带 code 的错误（not_found / still_connecting）
   */
  getReadySession(sessionId: string): RemoteSession;

  /**
   * 向会话日志缓冲追加一条记录。
   *
   * @param sessionId - 会话 id
   * @param kind - 日志类别
   * @param text - 内容
   */
  pushLog(sessionId: string, kind: 'info' | 'error', text: string): void;

  /**
   * 构造监督器错误（保持错误类型统一，消费方可按 code 分支）。
   *
   * @param code - 错误类别
   * @param message - 中文消息
   */
  makeError(code: SupervisorErrorCode, message: string): Error;
}

/**
 * 远端插件包管理器。
 *
 * 承接原 supervisor.ts 中的 listRemotePlugins / installRemotePlugin /
 * removeRemotePlugin / toggleRemotePlugin 四个公开方法及三个私有辅助。
 * 对会话的访问经 PluginStoreHost 接口注入，不持有会话登记簿。
 */
export class RemotePluginStore {
  constructor(private readonly host: PluginStoreHost) {}

  /**
   * 远端插件清单：读远端 profile 的 manifest 与 node_modules 版本/bundle 标记。
   *
   * @param sessionId - 会话 id
   * @returns 清单
   */
  async listRemotePlugins(sessionId: string): Promise<RemotePluginInfo[]> {
    const session = this.host.getReadySession(sessionId);
    const io = this.sessionIo(session);
    const manifest = await readPluginStoreManifest(io, session.remotePaths);
    const rows = await this.remotePluginRows(session, session.remotePaths.pluginsStoreNodeModules);
    const bundles = manifest.dsh?.profile?.bundles ?? [];
    // 清单 = deps ∪ bundles：不经 pnpm 的直落包（handoff）只在 bundles 里
    const names = new Set([...Object.keys(manifest.dependencies ?? {}), ...bundles]);
    const result: RemotePluginInfo[] = [];
    for (const name of names) {
      const row = rows.get(name);
      result.push({
        name,
        version: row?.version ?? manifest.dependencies?.[name] ?? '?',
        bundle: row?.bundle ?? bundles.includes(name),
        enabled: bundles.includes(name),
      });
    }
    return result;
  }

  /**
   * 远端安装插件：profile 目录内 pnpm add，成功后本地复刻 reconcile 语义
   * （声明 dsh.bundle.patch 的新依赖追加进 bundles，hmr 热加载）。
   *
   * @param sessionId - 会话 id
   * @param spec - pnpm 安装规格（包名@版本等）
   * @returns 安装后的清单
   */
  async installRemotePlugin(sessionId: string, spec: string): Promise<RemotePluginInfo[]> {
    const session = this.host.getReadySession(sessionId);
    const paths = session.remotePaths;
    this.host.pushLog(sessionId, 'info', `远端安装插件 ${spec}`);
    const registry = await this.remoteRegistry(session);
    const command = [
      `cd ${quote(paths.pluginsStore)}`,
      // pnpm 不认 npm 的 --no-audit/--no-fund（实测 Unknown options）；
      // pnpm add 默认不审计不fund，只传 registry
      `pnpm add ${quote(spec)}${registry ? ` --registry=${quote(registry)}` : ''}`,
    ].join('\n');
    try {
      await session.exec(command, {
        pathPrefix: session.provisionResult.node.binDir,
        timeoutMs: REMOTE_PLUGIN_TIMEOUT_MS,
      });
    } catch (error) {
      this.host.pushLog(sessionId, 'error', `远端安装插件失败：${toErrorMessage(error)}`);
      throw this.host.makeError('remote_plugin', `远端安装 ${spec} 失败：${toErrorMessage(error)}`);
    }
    // reconcile：新依赖里声明 bundle 的追加进 store bundles；再合并进本机活
    // 会话 manifest（hmr 热加载 bundle 层）。其他会话下次连接时同步
    const io = this.sessionIo(session);
    const manifest = await readPluginStoreManifest(io, paths);
    const rows = await this.remotePluginRows(session, paths.pluginsStoreNodeModules);
    const bundles = manifest.dsh?.profile?.bundles ?? [];
    let changed = false;
    for (const name of Object.keys(manifest.dependencies ?? {})) {
      if (rows.get(name)?.bundle === true && !bundles.includes(name)) {
        bundles.push(name);
        changed = true;
      }
    }
    if (changed) {
      await writePluginStoreManifest(io, paths, {
        ...manifest,
        dsh: { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles } },
      });
    }
    const synced = await syncSessionManifest(io, paths, sessionId);
    this.host.pushLog(sessionId, 'info', `远端插件 ${spec} 安装完成`
      + (synced ? '（本会话已 hmr 热生效；其他会话下次连接同步）' : ''));
    return this.listRemotePlugins(sessionId);
  }

  /**
   * 远端卸载插件：pnpm remove + 从 bundles 摘除。
   *
   * 启用中的 bundle 被摘除后由 hmr 热卸载（base bundle 默认启用 hmr）；
   * 若远端 dsh 老于 hmr 引入，表现为需重连会话才生效（文档注明）。
   *
   * @param sessionId - 会话 id
   * @param name - 包名
   * @returns 卸载后的清单
   */
  async removeRemotePlugin(sessionId: string, name: string): Promise<RemotePluginInfo[]> {
    const session = this.host.getReadySession(sessionId);
    const paths = session.remotePaths;
    this.host.pushLog(sessionId, 'info', `远端卸载插件 ${name}`);
    try {
      await session.exec(`cd ${quote(paths.pluginsStore)}\npnpm remove ${quote(name)}`, {
        pathPrefix: session.provisionResult.node.binDir,
        timeoutMs: REMOTE_PLUGIN_TIMEOUT_MS,
      });
    } catch (error) {
      this.host.pushLog(sessionId, 'error', `远端卸载插件失败：${toErrorMessage(error)}`);
      throw this.host.makeError('remote_plugin', `远端卸载 ${name} 失败：${toErrorMessage(error)}`);
    }
    const io = this.sessionIo(session);
    const manifest = await readPluginStoreManifest(io, paths);
    const bundles = manifest.dsh?.profile?.bundles ?? [];
    if (bundles.includes(name)) {
      await writePluginStoreManifest(io, paths, {
        ...manifest,
        dsh: {
          ...manifest.dsh,
          profile: { ...manifest.dsh?.profile, bundles: bundles.filter(item => item !== name) },
        },
      });
    }
    const synced = await syncSessionManifest(io, paths, sessionId);
    this.host.pushLog(sessionId, 'info', `远端插件 ${name} 已卸载`
      + (synced ? '（本会话已 hmr 热卸载；其他会话下次连接同步）' : ''));
    return this.listRemotePlugins(sessionId);
  }

  /**
   * 远端插件启停：只改 profile 清单的 bundles 列表，hmr 热生效。
   *
   * @param sessionId - 会话 id
   * @param name - 包名
   * @param enabled - true 启用 / false 停用
   * @returns 操作后的清单
   */
  async toggleRemotePlugin(sessionId: string, name: string, enabled: boolean): Promise<RemotePluginInfo[]> {
    const session = this.host.getReadySession(sessionId);
    const paths = session.remotePaths;
    const io = this.sessionIo(session);
    const manifest = await readPluginStoreManifest(io, paths);
    const bundles = manifest.dsh?.profile?.bundles ?? [];
    const has = bundles.includes(name);
    if (has === enabled) return this.listRemotePlugins(sessionId);
    await writePluginStoreManifest(io, paths, {
      ...manifest,
      dsh: {
        ...manifest.dsh,
        profile: {
          ...manifest.dsh?.profile,
          bundles: enabled ? [...bundles, name] : bundles.filter(item => item !== name),
        },
      },
    });
    await syncSessionManifest(io, paths, sessionId);
    this.host.pushLog(sessionId, 'info', `远端插件 ${name} 已${enabled ? '启用' : '停用'}（本会话 hmr 热生效）`);
    return this.listRemotePlugins(sessionId);
  }

  /**
   * 会话的窄 IO 适配：经 RemoteSession 的 exec/writeRemoteFile 委托
   * 读写 store 与 session manifest，不触碰 transport 本体。
   *
   * @param session - 就绪会话
   * @returns ManifestIo 适配器
   */
  private sessionIo(session: RemoteSession): ManifestIo {
    return {
      exec: (command, options) => session.exec(command, options),
      writeFile: (path, content) => session.writeRemoteFile(path, content),
    };
  }

  /**
   * 某 node_modules 目录的 名称→版本/bundle标记 投影（一条远端脚本取全）。
   *
   * @param session - 就绪会话
   * @param nodeModules - 目标目录（store 的 node_modules）
   * @returns 映射；目录缺失时为空
   */
  private async remotePluginRows(session: RemoteSession, nodeModules: string): Promise<Map<string, { version: string; bundle: boolean }>> {
    const script = [
      `cd ${quote(nodeModules)} 2>/dev/null || exit 0`,
      `for d in */ @*/*/; do`,
      `  [ -f "$d/package.json" ] || continue`,
      `  v=$(sed -n 's/^  "version": "\\([^"]*\\)".*/\\1/p' "$d/package.json" | head -1)`,
      `  b=no`,
      `  grep -q '"dsh"' "$d/package.json" && grep -q '"patch"' "$d/package.json" && b=yes`,
      `  printf '%s\\t%s\\t%s\\n' "$d" "$v" "$b"`,
      `done`,
    ].join('\n');
    const result = await session.exec(script, { allowNonZeroExit: true });
    const map = new Map<string, { version: string; bundle: boolean }>();
    for (const line of result.stdout.split('\n')) {
      const parts = line.split('\t');
      const name = (parts[0] ?? '').replace(/\/$/, '').trim();
      if (name === '') continue;
      map.set(name, { version: (parts[1] ?? '').trim(), bundle: (parts[2] ?? '').trim() === 'yes' });
    }
    return map;
  }

  /**
   * 远端 npm registry 偏好：读引导期 mirror-cache 的 npm 选中项。
   *
   * @param session - 就绪会话
   * @returns baseUrl；缓存缺失时 undefined（pnpm 用自身默认）
   */
  private async remoteRegistry(session: RemoteSession): Promise<string | undefined> {
    try {
      const result = await session.exec(`cat ${quote(session.remotePaths.mirrorCache)}`, {
        allowNonZeroExit: true,
      });
      const cache = JSON.parse(result.stdout) as { npm?: { baseUrl?: string } };
      return cache.npm?.baseUrl;
    } catch {
      return undefined;
    }
  }
}

/**
 * @file 远程工作区注册表
 * @description 管理远程工作区的持久化记录，使用 RemoteWorkspaceAdapter 做远端路径规范化，
 *              替代 WorkspaceRegistry 中硬依赖 node:fs/promises 的 realpathNormalize。
 *
 * 与 WorkspaceRegistry 的区别：
 * - 路径规范化通过 helper RPC 的 fs.resolve 在远端执行（不依赖本地 node:fs）
 * - 目录验证通过 helper RPC 的 fs.stat 在远端执行
 * - 持久化到 ~/.dsh/remote-workspaces.json
 * - 每个工作区绑定一个主机档案 ID，支持多主机多工作区
 * - session 绑定记录（可选，供后续 session 管理使用）
 *
 * 数据模型：
 * - RemoteWorkspaceRecord: id, hostId, path(远端规范路径), title, sessionIds, createdAt, updatedAt
 * - 同一主机下同一规范路径只允许一个工作区
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import type { RemoteWorkspaceAdapter } from './remote-workspace.js';

/** 远程工作区记录（持久化） */
export interface RemoteWorkspaceRecord {
  /** 唯一标识符（UUID） */
  id: string;
  /** 绑定的主机档案 ID */
  hostId: string;
  /** 远端规范化路径（通过 RemoteWorkspaceAdapter.realpath 获取） */
  path: string;
  /** 显示标题 */
  title: string;
  /** 绑定的 session ID 列表（按顺序） */
  sessionIds: string[];
  /** 创建时间（ISO-8601） */
  createdAt: string;
  /** 最后更新时间（ISO-8601） */
  updatedAt: string;
}

/** 创建远程工作区的输入 */
export interface CreateRemoteWorkspaceInput {
  /** 主机档案 ID */
  hostId: string;
  /** 远端路径（绝对路径，将通过 RPC 规范化） */
  path: string;
  /** 可选显示标题（不填则用路径末尾段） */
  title?: string;
}

/** 远程工作区列表项（前端投影） */
export interface RemoteWorkspaceValue {
  /** 工作区 ID */
  id: string;
  /** 主机档案 ID */
  hostId: string;
  /** 远端规范化路径 */
  path: string;
  /** 显示标题 */
  title: string;
  /** 绑定的 session 数量 */
  sessionCount: number;
  /** 绑定的 session ID 列表 */
  sessionIds: string[];
  /** 创建时间 */
  createdAt: string;
  /** 最后更新时间 */
  updatedAt: string;
}

/**
 * 远程工作区注册表。
 *
 * 持久化到 ~/.dsh/remote-workspaces.json，内存缓存列表/查找/删除操作。
 * 路径规范化通过 RemoteWorkspaceAdapter（helper RPC）在远端执行，
 * 不依赖本地 node:fs/promises。
 */
export class RemoteWorkspaceRegistry {
  /** 工作区记录列表（内存缓存） */
  private workspaces: RemoteWorkspaceRecord[] = [];
  /** 持久化文件路径 */
  private readonly filePath: string;

  /**
   * @param filePath - 持久化文件路径（默认 ~/.dsh/remote-workspaces.json）
   */
  constructor(filePath?: string) {
    this.filePath = filePath ?? join(homedir(), '.dsh', 'remote-workspaces.json');
    this.load();
  }

  /**
   * 创建或复用一个远程工作区
   *
   * 使用 RemoteWorkspaceAdapter 在远端规范化路径并验证目录存在性，
   * 然后持久化工作区记录。同一主机下同一规范路径返回已存在的工作区。
   *
   * @param adapter - 远程工作区适配器（需要连接就绪）
   * @param input - 创建输入
   * @returns 创建的工作区记录
   * @throws 远端路径不存在或不是目录时抛出错误
   */
  async create(adapter: RemoteWorkspaceAdapter, input: CreateRemoteWorkspaceInput): Promise<RemoteWorkspaceRecord> {
    // 1. 远端路径规范化 + 验证目录
    const canonical = await adapter.resolveWorkspacePath(input.path);

    // 2. 检查是否已有同主机同路径的工作区
    const existing = this.workspaces.find(
      ws => ws.hostId === input.hostId && ws.path === canonical,
    );
    if (existing) return existing;

    // 3. 创建新记录
    const now = new Date().toISOString();
    const title = input.title ?? (basename(canonical) || canonical);
    const record: RemoteWorkspaceRecord = {
      id: crypto.randomUUID(),
      hostId: input.hostId,
      path: canonical,
      title,
      sessionIds: [],
      createdAt: now,
      updatedAt: now,
    };
    this.workspaces.unshift(record);
    this.save();
    return record;
  }

  /**
   * 列出所有远程工作区（可按主机过滤）
   * @param hostId - 可选主机 ID 过滤
   * @returns 工作区列表（按创建顺序倒序，新的在前）
   */
  list(hostId?: string): RemoteWorkspaceRecord[] {
    if (hostId) return this.workspaces.filter(ws => ws.hostId === hostId);
    return [...this.workspaces];
  }

  /**
   * 按 ID 获取工作区
   * @param id - 工作区 ID
   * @returns 工作区记录，不存在返回 undefined
   */
  get(id: string): RemoteWorkspaceRecord | undefined {
    return this.workspaces.find(ws => ws.id === id);
  }

  /**
   * 按主机和路径查找工作区
   * @param hostId - 主机 ID
   * @param path - 远端路径（必须是规范化后的路径）
   * @returns 工作区记录，不存在返回 undefined
   */
  getByPath(hostId: string, path: string): RemoteWorkspaceRecord | undefined {
    return this.workspaces.find(ws => ws.hostId === hostId && ws.path === path);
  }

  /**
   * 更新工作区标题
   * @param id - 工作区 ID
   * @param title - 新标题
   * @returns 更新后的记录，不存在返回 undefined
   */
  rename(id: string, title: string): RemoteWorkspaceRecord | undefined {
    const record = this.workspaces.find(ws => ws.id === id);
    if (!record) return undefined;
    record.title = title;
    record.updatedAt = new Date().toISOString();
    this.save();
    return record;
  }

  /**
   * 删除一个远程工作区（不影响远端文件和 session 日志）
   * @param id - 工作区 ID
   * @returns 是否删除成功
   */
  delete(id: string): boolean {
    const index = this.workspaces.findIndex(ws => ws.id === id);
    if (index === -1) return false;
    this.workspaces.splice(index, 1);
    this.save();
    return true;
  }

  /**
   * 绑定 session 到工作区
   * @param workspaceId - 工作区 ID
   * @param sessionId - session ID
   * @returns 更新后的记录，不存在返回 undefined
   */
  attachSession(workspaceId: string, sessionId: string): RemoteWorkspaceRecord | undefined {
    const record = this.workspaces.find(ws => ws.id === workspaceId);
    if (!record) return undefined;
    if (!record.sessionIds.includes(sessionId)) {
      record.sessionIds.unshift(sessionId);
      record.updatedAt = new Date().toISOString();
      this.save();
    }
    return record;
  }

  /**
   * 解绑 session
   * @param workspaceId - 工作区 ID
   * @param sessionId - session ID
   * @returns 更新后的记录，不存在返回 undefined
   */
  detachSession(workspaceId: string, sessionId: string): RemoteWorkspaceRecord | undefined {
    const record = this.workspaces.find(ws => ws.id === workspaceId);
    if (!record) return undefined;
    record.sessionIds = record.sessionIds.filter(id => id !== sessionId);
    record.updatedAt = new Date().toISOString();
    this.save();
    return record;
  }

  /**
   * 将记录转换为前端投影
   * @param record - 内部记录
   * @returns 前端安全投影
   */
  toValue(record: RemoteWorkspaceRecord): RemoteWorkspaceValue {
    return {
      id: record.id,
      hostId: record.hostId,
      path: record.path,
      title: record.title,
      sessionCount: record.sessionIds.length,
      sessionIds: [...record.sessionIds],
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  /** 从持久化文件加载 */
  private load(): void {
    try {
      if (existsSync(this.filePath)) {
        const data = readFileSync(this.filePath, 'utf8');
        this.workspaces = JSON.parse(data);
      }
    } catch {
      this.workspaces = [];
    }
  }

  /** 保存到持久化文件 */
  private save(): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(this.workspaces, null, 2), 'utf8');
  }
}

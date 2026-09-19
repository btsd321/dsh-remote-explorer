/**
 * @file 远程工作区适配模块
 * @description 在 SSH 连接就绪后，通过 helper RPC 的 fs.resolve/fs.stat 实现远端路径规范化，
 *              替代 workspace 核心包中硬依赖 node:fs/promises 的 realpathNormalize。
 *
 * D1 方案的核心思路：
 * - 不修改 deepseek-harness 的 workspace 核心包（避免上游 PR 风险）
 * - 在插件侧提供远端 realpath 规范化能力
 * - 通过 Ssh2Connection 的 RPC 请求（fs.resolve/fs.stat）在远端执行路径解析
 * - 供连接编排器和 API controller 在 SSH 组合下使用
 *
 * 工作流程：
 * 1. 用户通过 Web GUI 选择远端工作目录
 * 2. 远程工作区适配器通过 helper RPC 在远端执行 realpath 和 stat
 * 3. 返回规范化的远端路径，用于 session cwd 和 workspace 注册
 */

import { z } from 'zod';
import type { Ssh2Connection } from './ssh2-connection.js';

/** 远端文件信息（与 dsh-ssh 的 fs.stat 返回值对应） */
export interface RemoteFsInfo {
  /** 文件类型 */
  kind: 'file' | 'directory' | 'symlink' | 'other';
  /** 文件大小 */
  size: number;
  /** 修改时间 */
  mtime: number;
  /** 版本标识 */
  version: string;
}

/** 远端路径解析结果（与 dsh-ssh 的 fs.resolve 返回值对应） */
export interface RemoteFsTarget {
  /** 规范化的远端路径标识 */
  targetKey: string;
}

/** fs.resolve 响应 schema */
const targetSchema = z.object({
  targetKey: z.string(),
}).passthrough();

/** fs.stat 响应 schema（完全放宽，远端返回格式可能与本地不同） */
const infoSchema = z.object({}).passthrough();

/** fs.list 响应 schema（完全放宽，远端返回的条目字段可能与本地不同） */
const entriesSchema = z.array(z.object({}).passthrough());

/** 目录条目 */
export interface RemoteDirEntry {
  /** 条目名称 */
  name: string;
  /** 条目类型 */
  kind: 'file' | 'directory' | 'symlink' | 'other';
  /** 条目大小 */
  size: number;
}

/**
 * 远程工作区适配器。
 *
 * 通过 Ssh2Connection 的 helper RPC 实现远端路径规范化、
 * 文件信息查询和目录列举，替代本地 node:fs/promises 的 realpath/stat/readdir。
 * 用于在 SSH 连接就绪后为 workspace 注册、session cwd 和目录选择器提供远端能力。
 */
export class RemoteWorkspaceAdapter {
  /**
   * @param connection - 已就绪的 SSH 连接实例
   */
  constructor(private readonly connection: Ssh2Connection) {}

  /**
   * 规范化远端路径（替代本地 realpathNormalize）
   *
   * 通过 helper RPC 的 fs.resolve 在远端解析路径，
   * 解析 trailing slashes、.. 和 symlinks，返回规范化的绝对路径。
   *
   * @param path - 远端路径（绝对或相对路径）
   * @param cwd - 可选的工作目录（用于解析相对路径）
   * @returns 规范化的远端绝对路径
   */
  async realpath(path: string, cwd?: string): Promise<string> {
    const target = await this.connection.request<RemoteFsTarget>(
      'fs.resolve',
      { path, ...(cwd ? { cwd } : {}) },
      targetSchema,
    );
    return target.targetKey;
  }

  /**
   * 查询远端文件/目录信息（替代本地 stat）
   *
   * @param target - 已解析的远端路径目标（通过 realpath 获取）
   * @returns 文件信息，不存在则返回 undefined
   */
  async stat(target: RemoteFsTarget | string): Promise<RemoteFsInfo | undefined> {
    // FsTarget 需要 targetKey 和 displayPath 两个字段
    const targetParam = typeof target === 'string'
      ? { targetKey: target, displayPath: target }
      : target;
    const result = await this.connection.request<RemoteFsInfo | null>(
      'fs.stat',
      { target: targetParam },
      infoSchema.nullable(),
    );
    return result ?? undefined;
  }

  /**
   * 检查远端路径是否为目录
   *
   * @param path - 远端路径
   * @returns 是否为目录
   */
  async isDirectory(path: string): Promise<boolean> {
    const resolved = await this.realpath(path);
    const info = await this.stat(resolved);
    // 远端返回的字段可能是 kind 或 type，兼容两种
    const kind = (info as any)?.kind ?? (info as any)?.type;
    return kind === 'directory';
  }

  /**
   * 列举远端目录内容（用于远程目录选择器）
   *
   * @param target - 已解析的远端路径目标
   * @returns 目录条目列表
   */
  async listDir(target: RemoteFsTarget | string): Promise<RemoteDirEntry[]> {
       const targetParam = typeof target === 'string'
      ? { targetKey: target, displayPath: target }
      : target;
    const entries = await this.connection.request<RemoteDirEntry[]>(
      'fs.list',
      { target: targetParam },
      entriesSchema,
    );
    return entries;
  }

  /**
   * 创建工作区：规范化路径 + 验证目录 + 返回规范路径
   *
   * 这是 workspace.create 的远端等价物：
   * 1. 通过远端 helper 规范化路径
   * 2. 验证规范化路径是目录
   * 3. 返回规范路径供 session cwd 使用
   *
   * @param path - 远端路径
   * @returns 规范化的远端绝对路径
   * @throws 路径不存在或不是目录时抛出错误
   */
  async resolveWorkspacePath(path: string): Promise<string> {
    // 1. 远端路径规范化
    const resolved = await this.realpath(path);
    // 2. 验证是目录
    const info = await this.stat(resolved);
    if (!info) throw new Error(`远端路径不存在: ${path}`);
    // 远端返回的字段可能是 kind 或 type，兼容两种
    const kind = (info as any)?.kind ?? (info as any)?.type;
    if (kind !== 'directory') throw new Error(`远端路径不是目录: ${path}`);
    return resolved;
  }
}

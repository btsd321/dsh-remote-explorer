/**
 * @file 远程主机档案注册表模块
 * @description 管理用户的远程主机配置档案，包括增删改查和持久化。
 *              每个档案包含连接信息（地址/端口/用户/密钥）、远端环境配置
 *              （Node 路径/helper 路径/默认 workspace）等。密钥通过文件路径
 *              引用，不落明文到配置文件。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';

/** 远程主机档案：描述一台可连接的远程开发主机 */
export interface RemoteHostProfile {
  /** 唯一标识符（UUID） */
  id: string;
  /** 显示名称 */
  title: string;
  /** 远程主机地址 */
  host: string;
  /** SSH 端口 */
  port: number;
  /** 登录用户名 */
  username: string;
  /** 私钥文件路径（可选，与 password 二选一） */
  privateKeyPath?: string;
  /** 私钥口令（可选） */
  passphrase?: string;
  /** 密码认证（可选，与 privateKeyPath 二选一） */
  password?: string;
  /** 远端 Node 可执行文件路径（引导后自动填充） */
  node: string;
  /** 远端 helper 入口文件路径（引导后自动填充） */
  helper: string;
  /** helper 入口文件 SHA-256（引导后自动填充） */
  helperHash: string;
  /** 远端默认工作目录绝对路径 */
  workspace: string;
  /** 可选：PTC bootstrap 入口路径 */
  bootstrapPath?: string;
  /** PTC bootstrap SHA-256 */
  bootstrapHash?: string;
  /** 远端 HTTP 代理地址（用于下载 Node 等，如 http://127.0.0.1:18890） */
  proxy?: string;
  /** 创建时间（ISO-8601） */
  createdAt: string;
  /** 最后更新时间（ISO-8601） */
  updatedAt: string;
}

/** 创建主机档案的输入 */
export interface CreateHostInput {
  /** 显示名称 */
  title: string;
  /** 远程主机地址 */
  host: string;
  /** SSH 端口（默认 22） */
  port?: number;
  /** 登录用户名 */
  username: string;
  /** 私钥文件路径 */
  privateKeyPath?: string;
  /** 私钥口令 */
  passphrase?: string;
  /** 密码 */
  password?: string;
  /** 远端默认工作目录 */
  workspace: string;
  /** 远端 HTTP 代理地址（用于下载 Node 等，如 http://127.0.0.1:18890） */
  proxy?: string;
}

/** 更新主机档案的输入（所有字段可选） */
export type UpdateHostInput = Partial<Omit<CreateHostInput, 'host'>> & {
  /** 更新 Node 路径 */
  node?: string;
  /** 更新 helper 路径 */
  helper?: string;
  /** 更新 helper 摘要 */
  helperHash?: string;
  /** 更新 bootstrap */
  bootstrapPath?: string;
  bootstrapHash?: string;
  /** 更新代理地址 */
  proxy?: string;
};

/**
 * 远程主机档案注册表。
 *
 * 持久化到 ~/.dsh/remote-hosts.json，内存缓存列表/查找/删除操作。
 * 密钥文件路径存储在档案中，但私钥内容不落配置文件。
 */
export class RemoteHostRegistry {
  /** 档案列表（内存缓存，与持久化文件同步） */
  private hosts: RemoteHostProfile[] = [];
  /** 持久化文件路径 */
  private readonly filePath: string;

  /**
   * @param filePath - 持久化文件路径（默认 ~/.dsh/remote-hosts.json）
   */
  constructor(filePath?: string) {
    this.filePath = filePath ?? join(homedir(), '.dsh', 'remote-hosts.json');
    this.load();
  }

  /**
   * 创建或复用一个主机档案
   * @param input - 创建输入
   * @returns 新创建的档案
   */
  create(input: CreateHostInput): RemoteHostProfile {
    // 检查是否已有同 host+username 的档案
    const existing = this.hosts.find(h => h.host === input.host && h.username === input.username);
    if (existing) return existing;

    const now = new Date().toISOString();
    const profile: RemoteHostProfile = {
      id: crypto.randomUUID(),
      title: input.title,
      host: input.host,
      port: input.port ?? 22,
      username: input.username,
      ...(input.privateKeyPath ? { privateKeyPath: input.privateKeyPath } : {}),
      ...(input.passphrase ? { passphrase: input.passphrase } : {}),
      ...(input.password ? { password: input.password } : {}),
      // 引导前为空，引导后自动填充
      node: '',
      helper: '',
      helperHash: '',
      workspace: input.workspace,
      ...(input.proxy ? { proxy: input.proxy } : {}),
      createdAt: now,
      updatedAt: now,
    };
    this.hosts.push(profile);
    this.save();
    return profile;
  }

  /**
   * 列出所有主机档案
   * @returns 档案列表（按创建顺序）
   */
  list(): RemoteHostProfile[] {
    return [...this.hosts];
  }

  /**
   * 按 ID 获取档案
   * @param id - 档案 ID
   * @returns 档案，不存在则返回 undefined
   */
  get(id: string): RemoteHostProfile | undefined {
    return this.hosts.find(h => h.id === id);
  }

  /**
   * 更新一个档案
   * @param id - 档案 ID
   * @param input - 更新输入
   * @returns 更新后的档案，不存在则返回 undefined
   */
  update(id: string, input: UpdateHostInput): RemoteHostProfile | undefined {
    const profile = this.hosts.find(h => h.id === id);
    if (!profile) return undefined;
    if (input.title !== undefined) profile.title = input.title;
    if (input.port !== undefined) profile.port = input.port;
    if (input.username !== undefined) profile.username = input.username;
    if (input.privateKeyPath !== undefined) profile.privateKeyPath = input.privateKeyPath;
    if (input.passphrase !== undefined) profile.passphrase = input.passphrase;
    if (input.password !== undefined) profile.password = input.password;
    if (input.workspace !== undefined) profile.workspace = input.workspace;
    if (input.node !== undefined) profile.node = input.node;
    if (input.helper !== undefined) profile.helper = input.helper;
    if (input.helperHash !== undefined) profile.helperHash = input.helperHash;
    if (input.bootstrapPath !== undefined) profile.bootstrapPath = input.bootstrapPath;
    if (input.bootstrapHash !== undefined) profile.bootstrapHash = input.bootstrapHash;
    if (input.proxy !== undefined) profile.proxy = input.proxy;
    profile.updatedAt = new Date().toISOString();
    this.save();
    return profile;
  }

  /**
   * 删除一个档案（不影响远端文件）
   * @param id - 档案 ID
   * @returns 是否删除成功
   */
  delete(id: string): boolean {
    const index = this.hosts.findIndex(h => h.id === id);
    if (index === -1) return false;
    this.hosts.splice(index, 1);
    this.save();
    return true;
  }

  /** 从持久化文件加载 */
  private load(): void {
    try {
      if (existsSync(this.filePath)) {
        const data = readFileSync(this.filePath, 'utf8');
        this.hosts = JSON.parse(data);
      }
    } catch {
      // 文件损坏或不存在，从空列表开始
      this.hosts = [];
    }
  }

  /** 保存到持久化文件 */
  private save(): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(this.hosts, null, 2), 'utf8');
  }
}

/**
 * 计算文件的 SHA-256 摘要
 * @param filePath - 文件路径
 * @returns 小写十六进制 SHA-256
 */
export function sha256File(filePath: string): string {
  const data = readFileSync(filePath);
  return createHash('sha256').update(data).digest('hex');
}

/**
 * 计算 Buffer 的 SHA-256 摘要
 * @param data - 数据
 * @returns 小写十六进制 SHA-256
 */
export function sha256Buffer(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

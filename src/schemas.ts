/**
 * @file SSH helper 协议的 Zod schema 定义
 * @description 与 dsh-ssh 的 schemas.ts 对应，定义 helper RPC 返回值的验证 schema。
 */

import { z } from 'zod';

/** 流端点：helper 返回的流转发坐标 */
export const streamEndpointSchema = z.object({
  /** 远端 Unix 域套接字路径 */
  path: z.string(),
  /** 每流 256-bit TLS-PSK 密钥（十六进制） */
  capability: z.string(),
}).strict();

/** 流端点类型 */
export type SshStreamEndpoint = z.infer<typeof streamEndpointSchema>;

/** helper 启动后返回的进程准备结果 */
export const preparedSchema = z.object({
  /** 远端进程 ID */
  id: z.string(),
  /** 各标准流的端点坐标 */
  streams: z.record(z.string(), streamEndpointSchema),
}).strict();

/** 进程准备结果类型 */
export type Prepared = z.infer<typeof preparedSchema>;

/** 进程完成结果 */
export const doneSchema = z.object({
  outcome: z.object({
    exitCode: z.number().nullable(),
    signal: z.string().nullable(),
  }).strict(),
  collected: z.object({
    stdout: z.object({ tail: z.string(), totalBytes: z.number() }).strict().optional(),
    stderr: z.object({ tail: z.string(), totalBytes: z.number() }).strict().optional(),
  }).strict().optional(),
  spills: z.object({
    stdout: z.string().optional(),
    stderr: z.string().optional(),
  }).strict().optional(),
}).strict();

/** 完成结果类型 */
export type Done = z.infer<typeof doneSchema>;

/** 远端文件路径 */
export const remotePath = z.string();

/** 文件信息 */
export const infoSchema = z.object({
  kind: z.enum(['file', 'directory', 'symlink', 'other']),
  size: z.number(),
  mtime: z.number(),
  version: z.string(),
}).strict();

/** 路径信息 */
export const pathInfoSchema = z.object({
  kind: z.enum(['file', 'directory', 'symlink', 'other']),
  size: z.number(),
}).strict();

/** 目录条目 */
export const entriesSchema = z.array(z.object({
  name: z.string(),
  kind: z.enum(['file', 'directory', 'symlink', 'other']),
  size: z.number(),
}).strict());

/** 文件目标解析结果 */
export const targetSchema = z.object({
  targetKey: z.string(),
}).strict();

/** 写入结果 */
export const writeResultSchema = z.object({
  version: z.string(),
}).strict();

/** 编辑结果 */
export const editResultSchema = z.object({
  version: z.string(),
}).strict();

/** 文本流 ID */
export const textStreamIdSchema = z.string();

/** 前台进程信息 */
export const foregroundSchema = z.object({
  pid: z.number().positive(),
  argv: z.array(z.string()).optional(),
}).strict().nullable();

/** 终端活动信息 */
export const terminalActivitySchema = z.object({
  active: z.boolean(),
  lastActivity: z.number(),
}).strict();

/** 输出快照 */
export const outputSnapshotSchema = z.object({
  tail: z.string(),
  totalBytes: z.number(),
}).strict();

/** 输出快照帧限制 */
export function outputSnapshotFrameLimit(maxBytes: number): number {
  return maxBytes;
}

/** 远端进程 ID 类型 */
export type SshProcessId = string;

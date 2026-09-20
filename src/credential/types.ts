/**
 * @file 凭据策略接口
 * @description 定义「远端 dsh 如何拿到模型调用凭据」的抽象。
 *
 * 首版只有一个实现：反向隧道代理（key 只留本机，远端回打）。接口本身是
 * 预留的扩展位——日后若要支持「远端专用 key」（Coder 口中的 BYOK 模式，
 * 支持离线续跑），新增一个实现即可，编排层不动。
 *
 * 分层约束：本文件属能力层，不得 import 编排层（session/）。
 */

import type { Duplex } from 'node:stream';

/** 一条 patch 覆盖条目（与 provision 层的 PatchEntry 结构兼容） */
export interface CredentialPatchEntry {
  /** 目标条目 id */
  id: string;
  /** 要覆盖的配置字段 */
  config: Record<string, string | number | boolean>;
}

/** 凭据策略契约 */
export interface CredentialStrategy {
  /** 策略种类；`remote-key` 为预留位，首版不实现 */
  readonly kind: 'tunnel-proxy' | 'remote-key';

  /** 需要注入远端 dsh 进程的环境变量（占位凭据等） */
  remoteEnv(): Record<string, string>;

  /** 需要写进会话 patch 的覆盖条目（如 baseURL 指向反向端口） */
  remotePatches(): CredentialPatchEntry[];

  /** 需要占用远端的反向监听端口；不需要反向隧道的策略为 undefined */
  readonly reversePort: number | undefined;

  /** 反向隧道收到一条连接时由编排层调用 */
  handleReverseConnection(stream: Duplex): void;

  /** 启动策略持有的本机资源；幂等 */
  start(): Promise<void>;

  /** 释放策略持有的本机资源；幂等 */
  stop(): Promise<void>;
}

/**
 * @file 命令级主机认证装配
 * @description 把「解析主机 → 应用命令行认证覆盖 → 校验 → 构造密码提供器」
 *              收成一步，供 doctor/provision/kill/clean 四个直连命令共用
 *              （connect 走 session 层，见 session-manager 的 open/reconnectOnce）。
 *
 * 优先级：--private-key > --password > config IdentityFile > 交互式密码提示。
 * 跳板机不受 --private-key/--password 影响，仍来自 config（或交互提示）。
 *
 * 分层：本文件属入口层，可用基础层（hosts/util）与传输层的类型。
 */

import {
  assertConnectable,
  resolveHostWithAuth,
  type AuthOverrides,
  type ResolvedHostWithJump,
} from '../hosts/ssh-config-parser.js';
import { PasswordProvider } from '../util/password-prompt.js';

/** 命令选项中的认证旗标（--private-key / --password） */
export interface AuthFlagOptions {
  /** 私钥文件路径（--private-key）：优先于 config 的 IdentityFile */
  privateKey?: string;
  /** 固定密码（--password）：显式走密码认证；只存内存不落盘 */
  password?: string;
}

/** prepareHostAuth 的装配结果 */
export interface HostAuth {
  /** 应用认证覆盖后的主机配置（跳板机不受覆盖影响） */
  resolved: ResolvedHostWithJump;
  /**
   * 密码提供器：--password 走固定值，否则交互提示并缓存。
   * 命令结束时调 clear() 丢弃缓存引用
   */
  passwords: PasswordProvider;
}

/**
 * 解析主机并装配密码认证。
 *
 * @param alias - 主机别名或 user@host[:port] 直连语法
 * @param flags - 命令行认证旗标
 * @returns 主机配置与密码提供器
 * @throws RemoteError 主机不存在、配置缺字段或端口非法（详见 hosts 层）
 */
export function prepareHostAuth(alias: string, flags: AuthFlagOptions): HostAuth {
  // --private-key 与 --password 同给时密钥优先（密码不再生效）——与
  // resolveHostWithAuth 的内部优先级保持一致
  const auth: AuthOverrides = {
    ...(flags.privateKey ? { privateKey: flags.privateKey } : {}),
    ...(flags.password !== undefined && flags.privateKey === undefined
      ? { password: flags.password }
      : {}),
  };
  const resolved = resolveHostWithAuth(alias, auth);
  assertConnectable(resolved, alias, { passwordAuth: auth.password !== undefined });
  return {
    resolved,
    passwords: new PasswordProvider(
      auth.password !== undefined ? { fixed: auth.password } : undefined,
    ),
  };
}

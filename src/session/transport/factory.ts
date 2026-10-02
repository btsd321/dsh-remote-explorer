/**
 * @file 传输实例化工厂
 * @description 会话入口 → 传输实例的实例化与 SSH/WSL 认证准备：认证覆盖
 *              计算、SSH 主机解析与可连接性校验、按传输类型分发创建传输
 *              实例、连接阶段的文案。open 流水线（open-pipeline/prepare）
 *              与重连（session-manager 的 reconnectOnce）共用同一套规则
 *              ——认证优先级、WSL 用户名判据只在这一处收口。
 *
 * 原为 session-manager.ts 模块私有，拆分后为同层导出。
 *
 * 分层：本文件属编排层（session/transport/ 子目录），向下使用基础层
 * （hosts 主机解析）与传输层（SSH/WSL 传输实现）。
 */

import {
  assertConnectable, isConfigHost, resolveHostWithAuth, resolveJumpChain,
  type AuthOverrides, type JumpEntry, type ResolvedHost, type ResolvedHostWithJump,
} from '../../hosts/ssh-config-parser.js';
import { SshTransport } from '../../transport/ssh-transport.js';
import { WslTransport } from '../../transport/wsl-transport.js';
import { RemoteError } from '../../util/errors.js';
import { createLogger } from '../../util/logger.js';
import type { RemoteTransport } from '../../transport/types.js';
import type { OpenSessionOptions, TransportType } from '../options.js';

const log = createLogger('transport-factory');

/**
 * 合法 WSL 用户名判据。
 *
 * 用户名会拼进 PowerShell 单引号字符串（remote-process 的 Start-Process），
 * 只允许 POSIX 用户名安全字符集——引号、空白、分号等会把字符串截断，
 * 等于给宿主 PowerShell 开了命令注入面。校验收敛在传输创建入口，
 * open 与重连（重建传输）共用同一份规则。
 */
const WSL_USER_PATTERN = /^[A-Za-z_][A-Za-z0-9._-]*$/;

/** SSH 传输准备上下文（仅 SSH 路径需要） */
export interface SshPrepareContext {
  /** SSH 主机解析结果（含跳板机链、认证配置） */
  resolved: ResolvedHostWithJump;
  /** 密码获取回调 */
  getPassword: (hostKey: string, label: string, attempt: number) => Promise<string | undefined>;
}

/**
 * 从会话选项计算认证覆盖。
 *
 * --private-key 与 --password 同给时密钥优先（密码不再生效）——与
 * resolveHostWithAuth 的内部优先级保持一致，open 与重连共用同一份规则。
 *
 * @param options - 会话选项
 * @returns 认证覆盖
 */
export function authOverridesOf(options: OpenSessionOptions): AuthOverrides {
  return {
    ...(options.privateKey ? { privateKey: options.privateKey } : {}),
    ...(options.password !== undefined && options.privateKey === undefined
      ? { password: options.password }
      : {}),
  };
}

/** 跳板机生效计划（分流规则的唯一真源） */
export interface JumpPlan {
  /** 链的来源：config = ssh config 的 ProxyJump；panel = 面板配置（直连主机）；none = 无跳板机 */
  source: 'config' | 'panel' | 'none';
  /** 生效跳板机链（按连接顺序；none 时空数组） */
  chain: ResolvedHost[];
  /** 覆盖被忽略的说明（config 主机带面板覆盖时给出，连接日志展示用） */
  ignoredOverride?: string;
}

/**
 * 计算某主机的生效跳板机链。
 *
 * 分流规则（用户拍板）：config 别名主机 → ssh config 的 ProxyJump 为准，
 * 面板覆盖被忽略（UI 不提供编辑入口，此处为防御性兜底）；user@host[:port]
 * 直连主机 → 面板配置的条目链；直连主机未配置 → 无跳板机。
 *
 * open 与重连共用（resolveSshHost 调用），插件层的连接日志（connect-summary）
 * 也调用它做只读展示——两边共享同一份分流规则，不会漂移。
 *
 * @param hostAlias - 主机标识（别名或 user@host[:port]）
 * @param panelJumps - 面板配置的跳板机条目（OpenSessionOptions.jumpHosts，
 *                    含连接请求携带的内存态密码）
 * @returns 生效计划
 * @throws RemoteError 面板条目无法解析（HOST_NOT_FOUND 等）——连接路径上
 *         应当失败（配置了坏条目）；只读展示路径由调用方 try/catch
 */
export function planJumpHosts(hostAlias: string, panelJumps?: JumpEntry[]): JumpPlan {
  const configHost = isConfigHost(hostAlias);
  if (configHost) {
    const resolved = resolveHostWithAuth(hostAlias, {});
    const plan: JumpPlan = { source: 'config', chain: resolved.jumpHosts };
    if (panelJumps !== undefined && panelJumps.length > 0) {
      plan.ignoredOverride = `主机 ${hostAlias} 在 ssh config 中已有定义，跳板机以 config 的 ProxyJump 为准（面板配置的跳板机被忽略）`;
      log.warn(plan.ignoredOverride);
    }
    return plan;
  }
  if (panelJumps !== undefined && panelJumps.length > 0) {
    return { source: 'panel', chain: resolveJumpChain(panelJumps) };
  }
  return { source: 'none', chain: [] };
}

/**
 * 解析 SSH 主机配置并校验可连接性。
 *
 * 只做主机解析，不涉及密码提供器的生命周期管理（密码提供器由调用方持有，
 * 需要在会话关闭时清理引用）。跳板机按 {@link planJumpHosts} 的分流规则
 * 生效——直连主机应用面板覆盖，config 主机维持 config 链。
 *
 * @param options - 会话打开选项
 * @returns SSH 主机解析结果
 */
export function resolveSshHost(options: OpenSessionOptions): ResolvedHostWithJump {
  const auth = authOverridesOf(options);
  const resolved = resolveHostWithAuth(options.hostAlias, auth);
  // 面板跳板机覆盖：仅直连主机生效（分流与告警语义见 planJumpHosts）
  const jumpPlan = planJumpHosts(options.hostAlias, options.jumpHosts);
  const effective: ResolvedHostWithJump = jumpPlan.source === 'panel'
    ? { ...resolved, jumpHosts: jumpPlan.chain }
    : resolved;
  assertConnectable(effective, options.hostAlias, {
    passwordAuth: auth.password !== undefined,
  });
  return effective;
}

/**
 * 根据会话选项创建对应的传输实例。
 *
 * 每种传输类型的准备逻辑由各自的 prepare* 函数完成，本函数只做分发。
 * 新增传输类型时：添加对应的 case 分支 + prepare 函数，不影响已有分支。
 *
 * @param options - 会话打开选项
 * @param sshCtx - SSH 准备上下文（仅 transportType='ssh' 时使用）
 * @returns 传输实例（尚未 connect）
 */
export function createTransport(
  options: OpenSessionOptions,
  sshCtx: SshPrepareContext,
): RemoteTransport {
  const type: TransportType = options.transportType ?? 'ssh';
  switch (type) {
    case 'wsl': {
      if (!options.distroName) {
        throw new RemoteError(
          'CONNECT_FAILED',
          'transportType=wsl 时必须指定 distroName（WSL 发行版名称）',
          { hostAlias: options.hostAlias },
        );
      }
      if (options.wslUser !== undefined && !WSL_USER_PATTERN.test(options.wslUser)) {
        throw new RemoteError(
          'CONNECT_FAILED',
          `WSL 用户名 ${options.wslUser} 含非法字符：只允许字母、数字、点、下划线、连字符，`
            + '且以字母或下划线开头（该值会拼进远端启动命令）',
          { hostAlias: options.hostAlias },
        );
      }
      return new WslTransport({
        distroName: options.distroName,
        ...(options.wslUser ? { user: options.wslUser } : {}),
      });
    }
    case 'ssh': {
      return new SshTransport(options.hostAlias, sshCtx.resolved, {
        getPassword: sshCtx.getPassword,
      });
    }
    default: {
      // 编译期穷尽检查：新增 TransportType 成员时此处报错提醒补充分支
      const _exhaustive: never = type;
      throw new RemoteError(
        'CONNECT_FAILED',
        `不支持的传输类型: ${_exhaustive as string}`,
        { hostAlias: options.hostAlias },
      );
    }
  }
}

/**
 * 获取传输类型的阶段描述文案。
 *
 * @param transportType - 传输类型
 * @returns 中文阶段描述
 */
export function transportStageLabel(transportType: TransportType | undefined): string {
  switch (transportType ?? 'ssh') {
    case 'wsl': return '连接 WSL 发行版';
    case 'ssh': return '建立 SSH 连接';
    default: return '建立连接';
  }
}

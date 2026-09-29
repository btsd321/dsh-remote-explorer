/**
 * @file 打开流水线·准备阶段
 * @description open() 流水线的第一阶段：按传输类型准备上下文（SSH 需主机
 *              解析 + 密码提供器，WSL 不需要），创建传输实例并完成连接。
 *
 *              本文件同时承载各阶段的数据契约类型（探测/引导阶段的上下文
 *              形状）：open-pipeline 内各阶段模块从这里 `import type`，
 *              避免阶段模块之间互相 import 对方的返回类型（依赖方向单一
 *              向本文件收敛，无环）。
 *
 * 原为 session-manager.ts 的 RemoteSession 私有静态方法与内联返回类型，
 * 拆分后为同层导出。
 *
 * 分层：本文件属编排层（session/open-pipeline/ 子目录），向下使用能力层
 * 与传输层的实例化入口（session/transport/factory.js）。
 */

import { PasswordProvider } from '../../util/password-prompt.js';
import {
  authOverridesOf, createTransport, resolveSshHost, transportStageLabel,
  type SshPrepareContext,
} from '../transport/factory.js';
import { createLogger } from '../../util/logger.js';
import type { RemoteTransport } from '../../transport/types.js';
import type { OpenSessionOptions } from '../options.js';
import type { RemotePaths } from '../../provision/remote-paths.js';
import type { ProxySecret } from '../../credential/proxy-secret.js';
import type { RemoteProcessInfo } from '../remote-process.js';
import type { ReverseListener } from '../../tunnel/reverse-listener.js';
import type { ProvisionResult } from '../../provision/provisioner.js';
import type { TunnelProxyCredential } from '../../credential/tunnel-proxy.js';

const log = createLogger('open-pipeline-prepare');

/**
 * 探测阶段上下文（probe 阶段产物，后续各阶段的共同输入）。
 *
 * 字段集合与原 probeAndReadCredentials 的内联返回类型逐字一致，
 * 提为具名接口供 probe/provision 阶段与 session-manager 编排引用。
 */
export interface ProbeStageContext {
  /** 远端路径集合（远端家目录探测派生） */
  paths: RemotePaths;
  /** 凭据材料；undefined 表示该会话不带凭据路径 */
  secret: ProxySecret | undefined;
  /** 既有远端进程信息；undefined 表示需要启动 */
  processInfo: RemoteProcessInfo | undefined;
  /** 预分配的 web 端口（仅在需要启动时使用） */
  webPort: number | undefined;
  /** 本次连接新生成了凭据材料（需要落盘） */
  secretIsNew: boolean;
  /** WSL 反向监听（分配即绑定，已绑定成功）；SSH 路径为 undefined */
  reverseListener: ReverseListener | undefined;
  /** 反向端口相对落盘值变化（幽灵占用换端口后需重写材料） */
  reversePortChanged: boolean;
}

/**
 * 引导与配置阶段上下文（provision 阶段产物）。
 *
 * 字段集合与原 provisionAndConfigure 的内联返回类型逐字一致。
 */
export interface ProvisionStageContext {
  /** 引导结果（Node/dsh 安装位置、profile、版本信息） */
  provisioned: ProvisionResult;
  /** 凭据策略实例；无凭据路径时 undefined */
  credential: TunnelProxyCredential | undefined;
}

/**
 * 准备传输实例并建立连接。
 *
 * 按传输类型各自准备上下文（SSH 需主机解析+密码提供器，WSL 不需要），
 * 创建传输实例并完成连接。
 *
 * @param options - 会话打开选项
 * @returns 已连接的传输实例与密码提供器
 */
export async function prepareTransport(
  options: OpenSessionOptions,
): Promise<{ transport: RemoteTransport; passwords: PasswordProvider | undefined }> {
  // 按传输类型各自准备上下文：SSH 需要主机解析+密码提供器，WSL 不需要。
  // 新增传输类型时在此添加对应 case，不影响已有分支
  let sshCtx: SshPrepareContext;
  let passwords: PasswordProvider | undefined;
  switch (options.transportType ?? 'ssh') {
    case 'ssh': {
      const resolved = resolveSshHost(options);
      const auth = authOverridesOf(options);
      passwords = new PasswordProvider({
        ...(auth.password !== undefined ? { fixed: auth.password } : {}),
        ...(options.promptPassword ? { prompt: options.promptPassword } : {}),
      });
      sshCtx = {
        resolved,
        getPassword: (hostKey, label, attempt) => passwords!.get(hostKey, label, attempt),
      };
      break;
    }
    case 'wsl': {
      // WSL 无需 SSH 主机解析与密码提供器；createTransport 内部校验 distroName
      sshCtx = { resolved: undefined as never, getPassword: async () => undefined };
      break;
    }
  }

  options.onStageStart?.(transportStageLabel(options.transportType));
  const transport = createTransport(options, sshCtx);
  log.info(`transport 创建完成: type=${options.transportType ?? 'ssh'}, hostAlias=${transport.hostAlias}`);
  await transport.connect();
  log.info(`transport 连接成功: platform=${transport.platform.rawOs}/${transport.platform.rawArch}`);
  options.onStageDone?.(`${transport.platform.rawOs} ${transport.platform.rawArch}`);

  return { transport, passwords };
}

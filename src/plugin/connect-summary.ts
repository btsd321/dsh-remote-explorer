/**
 * @file 连接选项日志渲染（纯函数）
 * @description 把「本次连接生效的全部高级选项」渲染成多行中文日志，供
 *              supervisor 在连接发起时双落（面板日志缓冲 + 宿主进程日志）
 *              ——用户排查「连的是什么」时一眼可见。
 *
 * 安全约束（渲染纪律）：
 * - 环境变量**只打键名不打值**（值可能含代理认证信息或敏感 token）
 * - 代理 URL 的 userinfo（user:pass@）打码为 user:***@（地址可打，凭据不打）
 * - 跳板机条目只打 user@host:port 与认证途径（私钥/密码/交互），**绝不打
 *   密码值与私钥路径**（路径含本机用户目录结构，非必要不外泄）
 * - 私钥覆盖只打「有/无」
 *
 * 形态约束：代理与私钥覆盖两行**SSH 专属**（transportType='ssh' 才渲染）
 * ——WSL 不支持这两项配置，渲染「代理: 未配置」「私钥覆盖: 无」会误导
 * 用户以为可配。跳板机行同规则（既有语义）。
 *
 * 分层：本文件属插件层，类型上依赖编排层（JumpPlan）与基础层（ResolvedHost），
 * 均为纯类型导入，不做任何 IO——渲染逻辑独立成模块的目的就是可单测。
 */

import type { JumpPlan } from '../session/transport/factory.js';
import type { ResolvedHost } from '../hosts/ssh-config-parser.js';

/** 连接选项汇总的输入（生效值由调用方算好，本模块只渲染） */
export interface ConnectSummaryInput {
  /** 主机标识（别名或 user@host[:port]） */
  hostAlias: string;
  /** 传输类型 */
  transportType: 'ssh' | 'wsl';
  /** WSL 发行版名（transportType='wsl' 时展示） */
  distroName?: string;
  /** 生效跳板机计划（SSH 且解析成功时提供） */
  jumpPlan?: JumpPlan;
  /** 跳板机计划解析失败的原因（条目坏值等；面板提示后连接仍会以原错误失败） */
  jumpPlanError?: string;
  /** 注入的环境变量（只渲染键名） */
  envKeys: string[];
  /** 面板代理（原文传入，渲染时打码 userinfo）；undefined = 未配置；仅 SSH 渲染该行 */
  proxy?: string;
  /** 生效的本机端口（0 = OS 分配） */
  localPort: number;
  /** 生效的 Node 版本覆盖 */
  nodeVersion?: string;
  /** 生效的 dsh 版本覆盖 */
  dshVersion?: string;
  /** 生效的强制重启标记 */
  forceRestart: boolean;
  /** 生效的重测镜像标记 */
  refreshMirrors: boolean;
  /** 是否带私钥路径覆盖（仅 SSH 渲染该段） */
  privateKey: boolean;
}

/**
 * 渲染连接选项日志行。
 *
 * 行序固定（主机 → 跳板机 → 环境变量 → 代理 → 其余选项），消费方逐行
 * push 进日志缓冲即可；首行带「连接选项:」前缀便于日志检索。跳板机/代理/
 * 私钥覆盖是 SSH 专属行（WSL 不支持，不渲染占位行免误导，见文件头形态
 * 约束）。
 *
 * @param input - 生效值汇总
 * @returns 日志行（非空，至少一行）
 */
export function renderConnectSummary(input: ConnectSummaryInput): string[] {
  const lines: string[] = [];
  const kind = input.transportType === 'wsl'
    ? `WSL ${input.distroName ?? '(未知名)'}` : 'SSH';
  lines.push(`连接选项: 主机 ${input.hostAlias}（${kind}）`);

  // 跳板机（SSH 专属；WSL 无跳板机概念）
  if (input.transportType === 'ssh') {
    if (input.jumpPlanError !== undefined) {
      lines.push(`  跳板机: 解析失败（${input.jumpPlanError}）`);
    } else if (input.jumpPlan === undefined || input.jumpPlan.chain.length === 0) {
      lines.push('  跳板机: 无（直连）');
    } else {
      const source = input.jumpPlan.source === 'config' ? 'config 识别' : '面板配置';
      const chain = input.jumpPlan.chain.map(describeJump).join(' → ');
      lines.push(`  跳板机: ${chain} [${source}]`);
    }
    if (input.jumpPlan?.ignoredOverride !== undefined) {
      lines.push(`  注意: ${input.jumpPlan.ignoredOverride}`);
    }
  }

  // 环境变量：只打键名（值可能含密）
  lines.push(input.envKeys.length > 0
    ? `  环境变量: ${input.envKeys.join(', ')}`
    : '  环境变量: 未配置');

  // 代理（SSH 专属；WSL 不支持代理配置，不渲染「未配置」占位行免误导）
  if (input.transportType === 'ssh') {
    lines.push(input.proxy !== undefined && input.proxy !== ''
      ? `  代理: ${maskProxyUrl(input.proxy)}`
      : '  代理: 未配置');
  }

  // 其余选项（值非敏感：端口/版本/开关）；私钥覆盖为 SSH 专属（WSL 无
  // 私钥认证概念，不拼进该行）
  lines.push(`  本地端口: ${input.localPort === 0 ? 'OS 分配' : input.localPort}`
    + ` / Node: ${input.nodeVersion ?? '默认'}`
    + ` / dsh: ${input.dshVersion ?? '默认'}`
    + ` / 强制重启: ${input.forceRestart ? '是' : '否'}`
    + ` / 重测镜像: ${input.refreshMirrors ? '是' : '否'}`
    + (input.transportType === 'ssh' ? ` / 私钥覆盖: ${input.privateKey ? '有' : '无'}` : ''));
  return lines;
}

/**
 * 描述单个跳板机（认证途径只打种类，密码与私钥路径不打）。
 *
 * @param jump - 跳板机解析结果
 * @returns `user@host:port（私钥|密码|交互）` 形态的短描述
 */
function describeJump(jump: ResolvedHost): string {
  const endpoint = `${jump.username}@${jump.host}:${jump.port}`;
  const auth = jump.identityFile !== undefined
    ? '私钥' : jump.password !== undefined ? '密码' : '交互';
  return `${endpoint}（${auth}）`;
}

/**
 * 打码代理 URL 的 userinfo。
 *
 * `http://user:pass@host:port` → `http://user:***@host:port`；无 userinfo
 * 原样返回。解析失败也原样返回（渲染不抛错，值本身已过存储校验）。
 *
 * @param proxy - 代理 URL 原文
 * @returns 打码后的展示形态
 */
function maskProxyUrl(proxy: string): string {
  try {
    const url = new URL(proxy);
    if (url.username === '') return proxy;
    url.password = '***';
    return url.href;
  } catch {
    return proxy;
  }
}

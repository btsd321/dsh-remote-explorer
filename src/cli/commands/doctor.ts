/**
 * @file doctor 命令
 * @description 诊断某台主机的引导条件：连接、平台、基础命令、镜像延迟、
 *              已装运行时、磁盘余量、Node 稳定性、通道配额、落盘隔离。
 *
 * 这个命令不是锦上添花——远程开发的故障大多出在环境而非代码，
 * VS Code 的故障排查文档也把"先确认环境"列为首要步骤。把诊断做成一等命令，
 * 用户能自己看出问题在哪，而不是拿着一句"引导失败"来问。
 *
 * 它同时是 P1 阶段唯一能端到端验证传输层与探测层的手段。
 */

import { SshTransport } from '../../transport/ssh-transport.js';
import { WslTransport } from '../../transport/wsl-transport.js';
import type { RemoteTransport } from '../../transport/types.js';
import type { TransportType } from '../../session/session-manager.js';
import {
  checkNodeStability as probeNodeStability,
  probeRemote,
  type ProbeResult,
} from '../../provision/probe.js';
import { selectMirror, type MirrorProbeResult } from '../../provision/mirror-selector.js';
import { createRemotePaths, type RemotePaths } from '../../provision/remote-paths.js';
import type { RemoteContext } from '../../provision/remote-context.js';
import { isWslAvailable, listWslDistros } from '../../hosts/wsl-distro-parser.js';
import { toErrorMessage } from '../../util/errors.js';
import { quote } from '../../util/shell-quote.js';
import { prepareHostAuth } from '../host-auth.js';
import { bold, cyan, dim, green, println, printTable, red, yellow, ProgressReporter } from '../output.js';

/** doctor 命令选项 */
export interface DoctorOptions {
  /** 主机别名或 user@host[:port] 直连语法（WSL 模式时为 wsl:<发行版>） */
  alias: string;
  /** 强制重测镜像，忽略缓存 */
  refreshMirrors: boolean;
  /** 传输类型；默认 'ssh' */
  transportType?: TransportType;
  /** WSL 发行版名称（transportType='wsl' 时必需） */
  distroName?: string;
  /** WSL 用户名（transportType='wsl' 时可选） */
  wslUser?: string;
  /** 私钥文件路径覆盖（--private-key） */
  privateKey?: string;
  /** 固定密码（--password）：显式走密码认证 */
  password?: string;
}

/** 单项检查的结论 */
type Verdict = 'ok' | 'warn' | 'fail';

/** 一条诊断结果 */
interface Finding {
  /** 检查项名称 */
  item: string;
  /** 结论 */
  verdict: Verdict;
  /** 详情 */
  detail: string;
}

/**
 * 执行 doctor 命令。
 *
 * @param options - 命令选项
 * @returns 进程退出码：0 全部通过或仅有警告，1 存在致命问题
 */
export async function runDoctor(options: DoctorOptions): Promise<number> {
  const progress = new ProgressReporter();
  const findings: Finding[] = [];
  const targetLabel = options.transportType === 'wsl' ? 'WSL 发行版' : '主机';

  println(bold(`诊断${targetLabel} ${cyan(options.alias)}`));
  println();

  let transport: RemoteTransport;
  /** SSH 模式的密码提供器清理回调；WSL 模式为 undefined */
  let clearPasswords: (() => void) | undefined;

  switch (options.transportType ?? 'ssh') {
    case 'wsl': {
      // WSL 模式：检查 WSL 可用性与发行版存在性
      const wslFatal = await checkWslAvailability(progress, findings);
      if (wslFatal) { report(findings); return 1; }

      const distroFatal = await checkDistro(options.distroName ?? '', progress, findings);
      if (distroFatal) { report(findings); return 1; }

      transport = new WslTransport({
        distroName: options.distroName ?? '',
        ...(options.wslUser ? { user: options.wslUser } : {}),
      });
      break;
    }
    case 'ssh': {
      // SSH 模式：解析主机配置、构建传输
      const { resolved, passwords } = prepareHostAuth(options.alias, options);
      findings.push({
        item: 'ssh config',
        verdict: 'ok',
        detail: `${resolved.target.username}@${resolved.target.host}:${resolved.target.port}`
          + (resolved.jumpHosts.length > 0 ? `，${resolved.jumpHosts.length} 级跳板机` : '，直连'),
      });

      transport = new SshTransport(options.alias, resolved, {
        getPassword: (hostKey, label, attempt) => passwords.get(hostKey, label, attempt),
      });
      clearPasswords = () => passwords.clear();
      break;
    }
  }

  try {
    // 建立连接并记录平台信息
    const connFatal = await checkConnection(transport, progress, findings);
    if (connFatal) { report(findings); return 1; }

    // 探测远端环境（home 目录、基础工具等）
    const probe = await checkProbe(transport, progress, findings);
    if (!probe) { report(findings); return 1; }

    const paths = createRemotePaths(probe.homeDir);
    const ctx: RemoteContext = { transport, paths };

    // 基础命令检查
    checkBasicCommands(probe, findings);

    // 磁盘余量
    checkDiskSpace(probe, findings);

    // 已装运行时
    checkInstalledRuntimes(probe, findings);

    // Node 稳定性自检
    await checkNodeStabilityChecks(transport, probe, progress, findings);

    // 镜像测速
    await checkMirror(ctx, options, progress, findings);

    // 通道配额（仅 SSH）
    checkChannelQuota(transport, findings);

    // SFTP 子系统
    await checkSftp(transport, progress, findings);

    // 隔离检查
    findings.push(await checkIsolation(ctx));

    println();
    report(findings);
    println();
    println(dim(`远端根目录：${paths.base}`));

    return findings.some(f => f.verdict === 'fail') ? 1 : 0;
  } finally {
    await transport.dispose();
    // 短命进程，清空是仪式性 hygiene，但与 session 路径保持一致
    clearPasswords?.();
  }
}

// ---------------------------------------------------------------------------
// 各诊断检查函数
// ---------------------------------------------------------------------------

/**
 * 检查 WSL 可用性。
 *
 * @returns true 表示致命错误，runDoctor 应提前退出
 */
async function checkWslAvailability(
  progress: ProgressReporter,
  findings: Finding[],
): Promise<boolean> {
  progress.start('检查 WSL 可用性');
  const wslOk = await isWslAvailable();
  if (!wslOk) {
    progress.fail('WSL 不可用');
    findings.push({ item: 'WSL 可用性', verdict: 'fail', detail: 'wsl.exe 不存在或无法响应；请确认 WSL 已安装并启用' });
    return true;
  }
  progress.done('WSL 可用');
  findings.push({ item: 'WSL 可用性', verdict: 'ok', detail: 'wsl.exe 正常响应' });
  return false;
}

/**
 * 检查指定 WSL 发行版是否存在。
 *
 * @returns true 表示致命错误，runDoctor 应提前退出
 */
async function checkDistro(
  distroName: string,
  progress: ProgressReporter,
  findings: Finding[],
): Promise<boolean> {
  progress.start(`检查发行版 ${distroName}`);
  const distros = await listWslDistros();
  const found = distros.find(d => d.name === distroName);
  if (!found) {
    progress.fail(`发行版 ${distroName} 不存在`);
    const available = distros.map(d => d.name).join('、') || '无';
    findings.push({ item: '发行版存在性', verdict: 'fail', detail: `未找到 ${distroName}；可用：${available}` });
    return true;
  }
  progress.done(`${found.state}（WSL ${found.version}）`);
  findings.push({
    item: '发行版存在性',
    verdict: 'ok',
    detail: `${found.name} ${found.state}（WSL ${found.version}${found.isDefault ? '，默认' : ''}）`,
  });
  return false;
}

/**
 * 建立传输连接并记录平台信息。
 *
 * @returns true 表示致命错误，runDoctor 应提前退出
 */
async function checkConnection(
  transport: RemoteTransport,
  progress: ProgressReporter,
  findings: Finding[],
): Promise<boolean> {
  const label = transport instanceof WslTransport ? '连接 WSL 发行版' : '建立 SSH 连接';
  progress.start(label);
  try {
    await transport.connect();
    progress.done(`${transport.platform.rawOs} ${transport.platform.rawArch}`);
    findings.push({
      item: '连接与平台',
      verdict: 'ok',
      detail: `${transport.platform.os}/${transport.platform.arch}`
        + `（uname: ${transport.platform.rawOs} ${transport.platform.rawArch}）`,
    });
    return false;
  } catch (error) {
    progress.fail(toErrorMessage(error));
    findings.push({ item: '连接与平台', verdict: 'fail', detail: toErrorMessage(error) });
    return true;
  }
}

/**
 * 探测远端环境（home 目录、基础工具清单等）。
 *
 * @returns 探测结果；null 表示致命错误
 */
async function checkProbe(
  transport: RemoteTransport,
  progress: ProgressReporter,
  findings: Finding[],
): Promise<ProbeResult | null> {
  progress.start('探测远端环境');
  try {
    const probe = await probeRemote(transport);
    progress.done(`home=${probe.homeDir}`);
    return probe;
  } catch (error) {
    progress.fail(toErrorMessage(error));
    findings.push({ item: '远端环境', verdict: 'fail', detail: toErrorMessage(error) });
    return null;
  }
}

/**
 * 检查远端基础命令（curl/wget、tar、xz）是否可用。
 */
function checkBasicCommands(probe: ProbeResult, findings: Finding[]): void {
  const missing: string[] = [];
  if (!probe.tools.hasCurl && !probe.tools.hasWget) missing.push('curl/wget');
  if (!probe.tools.hasTar) missing.push('tar');
  if (!probe.tools.hasXz) missing.push('xz');
  findings.push({
    item: '基础命令',
    verdict: missing.length === 0 ? 'ok' : 'warn',
    detail: missing.length === 0
      ? [
          probe.tools.hasCurl ? 'curl' : '',
          probe.tools.hasWget ? 'wget' : '',
          'tar',
          probe.tools.hasXz ? 'xz' : '',
        ].filter(Boolean).join('、')
      : `缺少 ${missing.join('、')}`,
  });
}

/**
 * 检查家目录磁盘余量。
 */
function checkDiskSpace(probe: ProbeResult, findings: Finding[]): void {
  if (probe.availableBytes !== undefined) {
    const gb = probe.availableBytes / 1_000_000_000;
    findings.push({
      item: '磁盘余量',
      verdict: gb >= 1.5 ? 'ok' : 'fail',
      detail: `家目录可用 ${gb.toFixed(1)} GB`
        + (gb >= 1.5 ? dim('（引导需约 0.7 GB）') : '，不足以引导（需约 0.7 GB 并留余量）'),
    });
  }
}

/**
 * 报告已安装的 Node 与 dsh 运行时版本。
 */
function checkInstalledRuntimes(probe: ProbeResult, findings: Finding[]): void {
  findings.push({
    item: '已装 Node',
    verdict: probe.managedNodes.length > 0 ? 'ok' : 'warn',
    detail: probe.managedNodes.length > 0
      ? probe.managedNodes.map(node => node.version).join('、')
      : '尚未安装（首次 connect 时会自动装）',
  });
  findings.push({
    item: '已装 dsh',
    verdict: probe.managedDsh.length > 0 ? 'ok' : 'warn',
    detail: probe.managedDsh.length > 0
      ? probe.managedDsh.map(dsh => dsh.version).join('、')
      : '尚未安装（首次 connect 时会自动装）',
  });
}

/**
 * 对每个已安装的 Node 版本执行稳定性自检。
 */
async function checkNodeStabilityChecks(
  transport: RemoteTransport,
  probe: ProbeResult,
  progress: ProgressReporter,
  findings: Finding[],
): Promise<void> {
  for (const node of probe.managedNodes) {
    progress.start(`Node ${node.version} 稳定性自检`);
    try {
      const stability = await probeNodeStability(transport, node.path);
      if (stability.isStable) {
        progress.done(`${stability.attempts} 次全部成功`);
        findings.push({
          item: `Node ${node.version} 稳定性`,
          verdict: 'ok',
          detail: `起进程 ${stability.attempts} 次，0 次失败`,
        });
      } else {
        const rate = Math.round((stability.failures / stability.attempts) * 100);
        progress.fail(`${stability.failures}/${stability.attempts} 次失败`);
        findings.push({
          item: `Node ${node.version} 稳定性`,
          verdict: 'fail',
          detail: `起进程 ${stability.attempts} 次失败 ${stability.failures} 次（${rate}%）。`
            + 'aarch64 上的已知问题，会导致 npm install 失败，请改用 v24 系',
        });
      }
    } catch (error) {
      progress.fail(toErrorMessage(error));
      findings.push({
        item: `Node ${node.version} 稳定性`,
        verdict: 'warn',
        detail: `自检未能完成：${toErrorMessage(error)}`,
      });
    }
  }
}

/**
 * 镜像测速（Node 发行版 + npm registry）。
 */
async function checkMirror(
  ctx: RemoteContext,
  options: DoctorOptions,
  progress: ProgressReporter,
  findings: Finding[],
): Promise<void> {
  const { transport, paths } = ctx;
  for (const kind of ['node', 'npm'] as const) {
    const label = kind === 'node' ? 'Node 发行版镜像' : 'npm registry';
    progress.start(`${label}测速`);
    try {
      const selection = await selectMirror(transport, kind, {
        cachePath: paths.mirrorCache,
        force: options.refreshMirrors,
      });
      if (selection.fromCache) {
        progress.skip(`命中缓存：${selection.selected.name}`);
        findings.push({
          item: label,
          verdict: 'ok',
          detail: `${selection.selected.name}（缓存；加 --refresh-mirrors 重测）`,
        });
      } else {
        progress.done(`选中 ${selection.selected.name}`);
        findings.push({
          item: label,
          verdict: 'ok',
          detail: formatMirrorResults(selection.results),
        });
      }
    } catch (error) {
      progress.fail(toErrorMessage(error));
      findings.push({
        item: label,
        verdict: 'fail',
        detail: toErrorMessage(error).split('\n').join(' '),
      });
    }
  }
}

/**
 * 检查 SSH 通道配额使用情况（仅 SSH 传输有通道配额概念）。
 */
function checkChannelQuota(transport: RemoteTransport, findings: Finding[]): void {
  if (transport instanceof SshTransport) {
    const usage = transport.channelUsage;
    findings.push({
      item: 'SSH 通道',
      verdict: 'ok',
      detail: `管理类已用 ${usage.admin}，转发类已用 ${usage.forward}，无等待`,
    });
  }
}

/**
 * 探测 SFTP 子系统是否可用。
 */
async function checkSftp(
  transport: RemoteTransport,
  progress: ProgressReporter,
  findings: Finding[],
): Promise<void> {
  progress.start('SFTP 子系统探测');
  try {
    await transport.checkSftp();
    progress.done('可用');
    findings.push({
      item: 'SFTP 子系统',
      verdict: 'ok',
      detail: '可用（会话已池化，内部文件传输走主路径）',
    });
  } catch (error) {
    progress.fail(toErrorMessage(error));
    findings.push({
      item: 'SFTP 子系统',
      verdict: 'warn',
      detail: `不可用（${toErrorMessage(error).split('\n').join(' ')}）；`
        + '文本写入将回退 printf-over-exec，大文件与二进制传输不可用',
    });
  }
}

// ---------------------------------------------------------------------------
// 辅助函数
// ---------------------------------------------------------------------------

/**
 * 隔离检查：本工具在远端的落盘清单，以及对官方 dsh 家目录的确认。
 *
 * 隔离契约（对标 VS Code 的 ~/.vscode-server 单根自治模型）：
 * 本工具在远端的一切落盘都在 `~/.dsh-remote-explorer/btsd321/` 内；远端 `~/.dsh`（官方 dsh
 * 的家）与 `~/.npm` 从不被本工具写入。检测 `~/.dsh` 是否存在只是给用户
 * 提示「这台机器上有别人在用官方 dsh」——存在与否都不改变本工具的行为。
 *
 * @param ctx - 远端执行上下文
 * @returns 诊断条目
 */
async function checkIsolation(
  ctx: RemoteContext,
): Promise<Finding> {
  const { transport, paths } = ctx;
  // 一条命令拿齐：本工具占用 + 官方 dsh 家的存在性
  const script = [
    `printf 'FOOTPRINT=%s\\n' "$(du -sh ${quote(paths.base)} 2>/dev/null | cut -f1)"`,
    `[ -d "\$HOME/.dsh" ] && printf 'OFFICIAL=present\\n' || printf 'OFFICIAL=absent\\n'`,
  ].join('\n');
  const result = await transport.exec(script, { allowNonZeroExit: true });
  const footprint = /^FOOTPRINT=(.+)$/m.exec(result.stdout)?.[1]?.trim() ?? '未知';
  const official = result.stdout.includes('OFFICIAL=present') ? 'present' : 'absent';

  const detail = `占用 ${footprint}（全部在 ${paths.base} 内）；`
    + (official === 'present'
      ? '远端 ~/.dsh 存在（他人/官方在用，本工具从不写入它）'
      : '远端 ~/.dsh 不存在（本工具也从不写入它）')
    + `；完全卸载 = rm -rf ${paths.base}`;

  return { item: '隔离检查', verdict: 'ok', detail };
}

/**
 * 把镜像测速结果格式化成单行摘要。
 *
 * @param results - 测速结果（已按耗时升序）
 * @returns 摘要文本
 */
function formatMirrorResults(results: readonly MirrorProbeResult[]): string {
  if (results.length === 0) return '无测速数据';
  return results
    .map(result => result.isUsable
      ? `${result.candidate.name} ${result.seconds?.toFixed(3)}s`
      : `${result.candidate.name} ${dim('不可用')}`)
    .join('，');
}

/**
 * 打印诊断结论表。
 *
 * @param findings - 诊断结果
 */
function report(findings: readonly Finding[]): void {
  printTable(
    ['', '检查项', '详情'],
    findings.map(finding => [markOf(finding.verdict), finding.item, finding.detail]),
  );

  const failed = findings.filter(f => f.verdict === 'fail');
  println();
  if (failed.length > 0) {
    println(red(`${failed.length} 项检查未通过，引导前需先解决`));
  } else if (findings.some(f => f.verdict === 'warn')) {
    println(yellow('存在提示项，但不阻塞引导'));
  } else {
    println(green('全部检查通过'));
  }
}

/**
 * 结论对应的标记符号。
 *
 * @param verdict - 结论
 * @returns 带颜色的符号
 */
function markOf(verdict: Verdict): string {
  if (verdict === 'ok') return green('✓');
  if (verdict === 'warn') return yellow('!');
  return red('✗');
}

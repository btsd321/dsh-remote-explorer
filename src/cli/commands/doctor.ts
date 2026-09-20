/**
 * @file doctor 命令
 * @description 诊断某台主机的引导条件：连接、平台、基础命令、镜像延迟、
 *              已装运行时、磁盘余量、Node 稳定性、通道配额。
 *
 * 这个命令不是锦上添花——远程开发的故障大多出在环境而非代码，
 * VS Code 的故障排查文档也把"先确认环境"列为首要步骤。把诊断做成一等命令，
 * 用户能自己看出问题在哪，而不是拿着一句"引导失败"来问。
 *
 * 它同时是 P1 阶段唯一能端到端验证传输层与探测层的手段。
 */

import { assertConnectable, resolveHost } from '../../hosts/ssh-config-parser.js';
import { SshTransport } from '../../transport/ssh-transport.js';
import {
  checkNodeStability,
  probeRemote,
  type ProbeResult,
} from '../../provision/probe.js';
import { getCandidates, selectMirror, type MirrorProbeResult } from '../../provision/mirror-selector.js';
import { createRemotePaths } from '../../provision/remote-paths.js';
import { RemoteError, toErrorMessage } from '../../util/errors.js';
import { bold, cyan, dim, green, println, printTable, red, yellow, ProgressReporter } from '../output.js';

/** doctor 命令选项 */
export interface DoctorOptions {
  /** 主机别名 */
  alias: string;
  /** 强制重测镜像，忽略缓存 */
  refreshMirrors: boolean;
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

  // 1. 解析 ssh config（纯本地，失败直接退出）
  const resolved = resolveHost(options.alias);
  assertConnectable(resolved, options.alias);
  findings.push({
    item: 'ssh config',
    verdict: 'ok',
    detail: `${resolved.target.username}@${resolved.target.host}:${resolved.target.port}`
      + (resolved.jumpHosts.length > 0 ? `，${resolved.jumpHosts.length} 级跳板机` : '，直连'),
  });

  println(bold(`诊断主机 ${cyan(options.alias)}`));
  println();

  const transport = new SshTransport(options.alias, resolved);
  try {
    // 2. 建立连接
    progress.start('建立 SSH 连接');
    try {
      await transport.connect();
      progress.done(`${transport.platform.rawOs} ${transport.platform.rawArch}`);
      findings.push({
        item: '连接与平台',
        verdict: 'ok',
        detail: `${transport.platform.os}/${transport.platform.arch}`
          + `（uname: ${transport.platform.rawOs} ${transport.platform.rawArch}）`,
      });
    } catch (error) {
      progress.fail(toErrorMessage(error));
      findings.push({ item: '连接与平台', verdict: 'fail', detail: toErrorMessage(error) });
      report(findings);
      return 1;
    }

    // 3. 探测远端环境
    progress.start('探测远端环境');
    let probe: ProbeResult;
    try {
      probe = await probeRemote(transport);
      progress.done(`home=${probe.homeDir}`);
    } catch (error) {
      progress.fail(toErrorMessage(error));
      findings.push({ item: '远端环境', verdict: 'fail', detail: toErrorMessage(error) });
      report(findings);
      return 1;
    }

    const paths = createRemotePaths(probe.homeDir);

    // 基础命令
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

    // 磁盘
    if (probe.availableBytes !== undefined) {
      const gb = probe.availableBytes / 1_000_000_000;
      findings.push({
        item: '磁盘余量',
        verdict: gb >= 1.5 ? 'ok' : 'fail',
        detail: `家目录可用 ${gb.toFixed(1)} GB`
          + (gb >= 1.5 ? dim('（引导需约 0.7 GB）') : '，不足以引导（需约 0.7 GB 并留余量）'),
      });
    }

    // 已装运行时
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

    // 4. Node 稳定性自检（只有装了才能测）
    for (const node of probe.managedNodes) {
      progress.start(`Node ${node.version} 稳定性自检`);
      try {
        const stability = await checkNodeStability(transport, node.path);
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

    // 5. 镜像测速
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

    // 6. 通道配额
    const usage = transport.channelUsage;
    findings.push({
      item: 'SSH 通道',
      verdict: 'ok',
      detail: `管理类已用 ${usage.admin}，转发类已用 ${usage.forward}，无等待`,
    });

    println();
    report(findings);
    println();
    println(dim(`远端根目录：${paths.base}`));

    return findings.some(f => f.verdict === 'fail') ? 1 : 0;
  } finally {
    await transport.dispose();
  }
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

/**
 * 校验候选镜像清单非空（防止误删后静默失效）。
 *
 * @throws RemoteError('MIRROR_ALL_UNREACHABLE') 清单为空
 */
export function assertMirrorCandidates(): void {
  for (const kind of ['node', 'npm'] as const) {
    if (getCandidates(kind).length === 0) {
      throw new RemoteError('MIRROR_ALL_UNREACHABLE', `${kind} 的候选镜像清单为空`);
    }
  }
}

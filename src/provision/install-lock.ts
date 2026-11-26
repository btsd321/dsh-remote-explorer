/**
 * @file 远端引导安装临界区锁
 * @description 多人经本工具连同一主机（同一远端账号）时，并发引导会同时写
 *              版本目录（`node/<v>`、`base/node_modules` 的 dsh 安装树）：npm
 *              写竞态、以及 node 解包段的 `rm -rf 目标 && mv` 互删。远端内核
 *              flock 可用（已实测），用一把文件锁把安装临界区串起来。
 *
 * 锁文件在本工具远端根的 tmp/ 下（隔离契约内）。等待超时给明确报错而非
 * 静默排队到天荒地老——引导是分钟级操作，等锁方需要知道自己在等谁。
 *
 * 只锁「写版本目录」的命令段（node 解包、dsh npm install、pnpm 全局装）；
 * 下载进 pid+主机名命名的临时目录不锁（互不覆盖），测速/探测只读不锁。
 */

import { quote } from '../util/shell-quote.js';
import type { RemotePaths } from './remote-paths.js';

/** 等锁超时（秒）。覆盖「慢链路首次无缓存安装 dsh」的最坏观察值 */
export const INSTALL_LOCK_WAIT_SECONDS = 900;

/**
 * 等锁超时时 flock 的专用退出码（`-E`）。
 *
 * util-linux 的 flock 等锁超时**不打任何输出**（2.37 实测：stderr 为空、
 * 退出码默认 1），与「被锁命令自己以 1 退出」完全无法区分。用 `-E` 把超时
 * 单列成 75，超时才有可判据的信号。
 *
 * `-E` 需要 util-linux ≥ 2.30（2017）。dsh 本身要求 Node 20+，而 Node 20
 * 需要 glibc ≥ 2.28（RHEL/CentOS 8 = util-linux 2.32 起），目标主机实际都满足；
 * 万一遇到更旧的宿主，{@link installLockHint} 有「invalid option」分支给出
 * 明确提示，不至于只剩一条原始报错。
 */
export const LOCK_TIMEOUT_EXIT_CODE = 75;

/**
 * 等锁超时的 stderr 标记行。
 *
 * 生产端（{@link lockInstallCommand} 的包装脚本）与识别端
 * （{@link installLockHint}）共用这一个常量：标记文案只写一份，改措辞不会
 * 让识别静默失效。
 */
export const LOCK_TIMEOUT_MARKER = 'flock: 等锁超时';

/**
 * 把一条安装命令包进远端 flock 临界区。
 *
 * **先创建锁文件父目录**：existing 模式不下载 Node，`base/tmp` 不会像 auto
 * 模式那样由下载临时目录顺带创建；直接 `flock <base>/tmp/install.lock` 会因
 * 父目录不存在立即失败。
 *
 * **超时补一行 stderr**：只有被锁命令自己退出 75 时才可能来自 flock 的
 * `-E`，此时补 `flock: 等锁超时`，上层 {@link installLockHint} 据此给出
 * 「另一引导正在进行」的说明。不能用「错误文本里出现 flock」来猜——命令
 * 预览本身就含 flock，那样任何失败都会被误报成等锁超时。
 *
 * @param paths - 远端路径集合（取锁文件位置）
 * @param command - 原始 shell 命令（未转义整体，作为 flock -c 的单一参数）
 * @returns 加锁后的命令字符串
 */
export function lockInstallCommand(paths: RemotePaths, command: string): string {
  const locked = `mkdir -p ${quote(paths.tmpRoot)} && `
    + `flock -w ${INSTALL_LOCK_WAIT_SECONDS} -E ${LOCK_TIMEOUT_EXIT_CODE} `
    + `${quote(paths.installLockFile)} -c ${quote(command)}`;
  // `(exit …)` 用子 shell 传递退出码，不结束外层 shell——调用方若在本命令后
  // 追加语句（当前没有，但别把这层悄悄变成陷阱），行为仍然可预期。
  return `${locked} || { rc=$?; [ "$rc" = ${LOCK_TIMEOUT_EXIT_CODE} ] && echo ${quote(LOCK_TIMEOUT_MARKER)} >&2; (exit "$rc"); }`;
}

/**
 * 等锁超时的报错归一：flock 拿不到锁时，把「另一引导正在进行」这层语义补进
 * 错误消息，避免用户对着 npm 的半截报错猜。
 *
 * 入参是传输层拼好的整条错误消息（含**命令预览** + stderr 预览），所以判据
 * 一律锚在 `flock:` 上：命令预览里的 `flock -w …` 没有冒号，不会被误认；
 * 而 util-linux 自己的诊断与本模块的超时标记都以 `flock:` 开头。
 *
 * @param stderr - 远端命令的 stderr（或含 stderr 预览的错误消息）
 * @returns 补充说明；不像锁相关失败时 undefined
 */
export function installLockHint(stderr: string): string | undefined {
  // 缺命令的措辞随 shell 而异，三种都要认：bash/zsh 的
  // `flock: command not found`、dash/busybox 的 `flock: not found`、
  // zsh 反序的 `command not found: flock`。
  if (/flock: (?:command )?not found|command not found: flock/i.test(stderr)) {
    return '（远端缺少 flock 命令，无法串行化安装；请安装 util-linux 后重试）';
  }
  if (/flock: (?:invalid|unrecognized) option/i.test(stderr)) {
    return '（远端 flock 过旧，缺少 -E 选项：需要 util-linux ≥ 2.30，请升级 util-linux）';
  }
  if (/flock: .*(?:cannot open lock file|no such file or directory|permission denied)/i.test(stderr)) {
    return '（flock 锁文件不可写：请确认远端安装根目录存在且当前用户有写权限）';
  }
  if (stderr.split('\n').some(line => line.trim() === LOCK_TIMEOUT_MARKER)) {
    return '（flock 等锁超时：同一远端账号下另一引导正在进行，稍后重试）';
  }
  return undefined;
}

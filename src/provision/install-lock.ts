/**
 * @file 远端引导安装临界区锁
 * @description 多人经本工具连同一主机（同一远端账号）时，并发引导会同时写
 *              版本目录（`node/<v>`、`versions/dsh-<v>`）：npm 写竞态、以及
 *              node 解包段的 `rm -rf 目标 && mv` 互删。远端内核 flock 可用
 *              （已实测），用一把文件锁把安装临界区串起来。
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
 * 把一条安装命令包进远端 flock 临界区。
 *
 * @param paths - 远端路径集合（取锁文件位置）
 * @param command - 原始 shell 命令（未转义整体，作为 flock -c 的单一参数）
 * @returns 加锁后的命令字符串
 */
export function lockInstallCommand(paths: RemotePaths, command: string): string {
  return `flock -w ${INSTALL_LOCK_WAIT_SECONDS} ${quote(paths.installLockFile)} -c ${quote(command)}`;
}

/**
 * 等锁超时的报错归一：flock 拿不到锁退出非零时，把「另一引导正在进行」
 * 这层语义补进错误消息，避免用户对着 npm 的半截报错猜。
 *
 * @param stderr - 远端命令 stderr
 * @returns 补充说明；不像锁超时时 undefined
 */
export function installLockHint(stderr: string): string | undefined {
  return /flock/i.test(stderr)
    ? '（flock 等锁超时：同一远端账号下另一引导正在进行，稍后重试）'
    : undefined;
}

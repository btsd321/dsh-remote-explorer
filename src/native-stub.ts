/**
 * @file 生成 node-addon-system stub 包
 * @description 为远端创建 @deepseek-ai/node-addon-system 的 stub 实现，
 *              提供与原生包相同的导出接口但不依赖原生二进制。
 *              沙箱不强制执行 landlock，但 helper 能正常启动和运行。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { DependencyFile } from './dependency-collector.js';

/**
 * 生成 stub 包文件列表
 * @returns stub 包文件列表（可直接上传到远端 node_modules）
 */
export function createNodeAddonStub(): DependencyFile[] {
  const pkgName = '@deepseek-ai/node-addon-system';

  // stub landlock-run 模块
  const landlockStub = `/**
 * landlock-run stub：不依赖原生二进制，提供 no-op 实现。
 * 沙箱不强制执行 landlock，但 helper 能正常启动和运行。
 */
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 启动器二进制文件名 */
export const LAUNCHER_BIN = 'landlock-run';

/** 启动器失败退出码 */
export const LAUNCHER_FAILURE_EXIT = 125;

/**
 * 返回启动器二进制路径（stub：返回空路径，实际不调用）
 * @returns 二进制路径
 */
export function launcherPath() {
  return '/usr/bin/true';
}

/**
 * 构建 landlock 授权参数（stub：返回空参数列表）
 * @param grants - 授权配置
 * @returns 空 argv 前缀
 */
export function grantArgs(grants) {
  return [];
}

/**
 * 探测 landlock 支持（stub：返回不可用）
 * @returns 探测结果，available 为 false
 */
export function probe() {
  return { available: false, reason: 'stub: native binary not installed' };
}
`;

  // stub flock 模块
  const flockStub = `/**
 * flock stub：不依赖原生 .node 加载，提供 no-op 实现。
 * 文件锁定不生效，但不会阻止 helper 运行。
 */
let binding = null;

function loadBinding() {
  return null;
}

/**
 * 异步文件锁（stub：直接调用回调，不实际锁定）
 * @param fd - 文件描述符
 * @param operation - 锁操作
 * @param callback - 回调函数
 */
export function flock(fd, operation, callback) {
  setImmediate(() => callback(null));
}

/**
 * 同步文件锁（stub：直接返回，不实际锁定）
 * @param fd - 文件描述符
 * @param operation - 锁操作
 */
export function flockSync(fd, operation) {
  // no-op
}
`;

  // package.json
  const packageJson = JSON.stringify({
    name: pkgName,
    version: '0.0.0-stub',
    type: 'module',
    description: 'Stub: no native binaries, no-op implementations',
    exports: {
      './landlock-run': {
        default: './lib/index.js',
      },
      './flock': {
        default: './lib/flock.js',
      },
      './package.json': './package.json',
    },
  }, null, 2);

  return [
    {
      remotePath: `node_modules/${pkgName}/package.json`,
      data: Buffer.from(packageJson),
    },
    {
      remotePath: `node_modules/${pkgName}/lib/index.js`,
      data: Buffer.from(landlockStub),
    },
    {
      remotePath: `node_modules/${pkgName}/lib/flock.js`,
      data: Buffer.from(flockStub),
    },
  ];
}

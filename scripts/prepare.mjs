#!/usr/bin/env node
/**
 * @file npm/pnpm prepare 生命周期脚本
 * @description git clone 后 pnpm install 自动触发：检测到 .git/ 目录时
 *              安装 pre-commit hook；非 git 环境（如 git-hosted tarball
 *              安装、CI 无 .git）静默跳过。
 *
 * 注意：此脚本不做构建——lib/ 已纳入版本控制，构建由 pre-commit hook
 * 或手动 pnpm run build:plugin 完成。这避免了 pnpm 11 对 git-hosted
 * 包的 ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED 拦截。
 */

import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// 非 git 仓库（tarball 安装、CI 浅克隆等）直接跳过
if (!existsSync(resolve(REPO_ROOT, '.git'))) {
  process.exit(0);
}

try {
  execSync('node scripts/setup-hooks.mjs', {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
} catch {
  // hook 安装失败不应阻塞 install
  console.warn('[prepare] ⚠️  git hooks 安装失败，可稍后手动运行 pnpm run setup:hooks');
}

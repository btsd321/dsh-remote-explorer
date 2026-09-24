#!/usr/bin/env node
/**
 * @file 安装 git hooks
 * @description 将 scripts/pre-commit.mjs 链接/复制到 .git/hooks/pre-commit。
 *              优先创建符号链接（改动实时生效）；Windows 无权限时回退复制。
 */

import { copyFileSync, chmodSync, lstatSync, unlinkSync, symlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOOK_SRC = resolve(REPO_ROOT, 'scripts', 'pre-commit.mjs');
const HOOK_DST = resolve(REPO_ROOT, '.git', 'hooks', 'pre-commit');

// 移除已有的 hook（可能是旧文件或旧链接）
try {
  const stat = lstatSync(HOOK_DST);
  if (stat.isFile() || stat.isSymbolicLink()) {
    unlinkSync(HOOK_DST);
  }
} catch {
  // 不存在，忽略
}

// 优先符号链接
let linked = false;
try {
  symlinkSync(HOOK_SRC, HOOK_DST);
  linked = true;
  console.log('✅ pre-commit hook 已安装（符号链接）');
} catch {
  // Windows 无开发者模式或权限不足时回退复制
  try {
    copyFileSync(HOOK_SRC, HOOK_DST);
    chmodSync(HOOK_DST, 0o755);
    console.log('✅ pre-commit hook 已安装（复制）');
  } catch (err) {
    console.error('❌ 安装 pre-commit hook 失败:', err.message);
    process.exit(1);
  }
}

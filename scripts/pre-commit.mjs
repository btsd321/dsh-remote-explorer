#!/usr/bin/env node
/**
 * @file git pre-commit 钩子
 * @description 检测暂存区是否包含 src/ 或 scripts/ 下的文件改动；若有则
 *              自动跑 build:plugin 并将产物 lib/ 加入暂存区。
 *              插件入口（src/plugin/、src/plugin-client/）会 import src/ 下
 *              各层模块，只检查 plugin 目录会漏掉间接依赖的改动。
 *              无相关改动时跳过。
 *
 * 用法：
 *   手动安装：cp scripts/pre-commit.mjs .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit
 *   或由 setup:hooks 脚本自动安装（见 package.json）
 */

import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 触发重新构建的路径前缀 */
const TRIGGER_PREFIXES = [
  'src/',
  'scripts/',
  'tests/',
];

/**
 * 检查暂存区是否有触发构建的文件改动
 */
function hasPluginChanges() {
  try {
    // --cached --name-only 只列暂存区的文件名（含新增/修改/删除）
    const staged = execSync('git diff --cached --name-only', {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
    }).trim();

    if (!staged) return false;

    const files = staged.split('\n');
    return files.some((f) =>
      TRIGGER_PREFIXES.some((prefix) => f.startsWith(prefix))
    );
  } catch {
    // git 命令失败时保守地认为有改动
    return true;
  }
}

/**
 * 执行构建并将 lib/ 加入暂存区
 */
function buildAndStage() {
  console.log('[pre-commit] 检测到插件源码改动，正在构建 lib/ ...');

  try {
    execSync('pnpm run build:plugin', {
      cwd: REPO_ROOT,
      stdio: 'inherit',
    });
  } catch (err) {
    console.error('[pre-commit] ❌ 插件构建失败，提交已中止');
    process.exit(1);
  }

  // 将构建产物加入暂存区
  try {
    execSync('git add lib/', {
      cwd: REPO_ROOT,
      stdio: 'inherit',
    });
    console.log('[pre-commit] ✅ 插件构建完成，lib/ 已加入暂存区');
  } catch {
    console.error('[pre-commit] ⚠️  lib/ 加入暂存区失败，请手动 git add lib/');
    // 不中止提交——构建已成功，产物存在，只是暂存步骤出了问题
  }
}

// 主逻辑
if (hasPluginChanges()) {
  buildAndStage();
} else {
  console.log('[pre-commit] 无插件源码改动，跳过构建');
}

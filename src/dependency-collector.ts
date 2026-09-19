/**
 * @file 依赖收集器
 * @description 递归收集 helper 所需的所有 npm 依赖文件（构建产物），
 *              包括所有传递依赖，用于上传到远端 node_modules 目录。
 *              通过读取每个包的 package.json dependencies 字段递归收集。
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';

/** 依赖文件：远端相对路径 → 文件内容 */
export interface DependencyFile {
  /** 远端 node_modules 下的相对路径 */
  remotePath: string;
  /** 文件内容 */
  data: Buffer;
}

/** 需要排除的文件模式 */
const EXCLUDE_PATTERNS = [
  /\.d\.ts$/,
  /\.d\.ts\.map$/,
  /\.test\.js$/,
  /\.spec\.js$/,
  /\/tests?\//,
  /\/__tests__\//,
  /\/test\//,
  /\/docs?\//,
  /\/examples?\//,
  /\/benchmark/i,
  /README/i,
  /CHANGELOG/i,
  /LICENSE/i,
  /\.md$/i,
  /\.map$/i,
];

/** 已经收集过的包（避免重复） */
const collectedPackages = new Set<string>();

/**
 * 解析一个 npm 包的实际安装路径
 * @param pkgName - 包名
 * @param fromDir - 解析起点目录
 * @returns 包根目录路径，未找到返回 null
 */
function resolvePackageDir(pkgName: string, fromDir: string): string | null {
  try {
    const require = createRequire(join(fromDir, 'package.json'));
    const resolved = require.resolve(pkgName);
    let dir = dirname(resolved);
    while (dir !== dirname(dir)) {
      if (existsSync(join(dir, 'package.json'))) {
        const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
        if (pkg.name === pkgName) return dir;
      }
      dir = dirname(dir);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 收集一个 npm 包的构建产物文件
 * @param pkgDir - 包根目录
 * @param pkgName - 包名
 * @returns 依赖文件列表
 */
function collectPackageFiles(pkgDir: string, pkgName: string): DependencyFile[] {
  const files: DependencyFile[] = [];
  const packageJson = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));

  // 确定主入口和导出目录
  const mainFile = packageJson.main || packageJson.exports?.['.']?.default || packageJson.exports?.['.'] || 'index.js';
  const mainDir = dirname(typeof mainFile === 'string' ? mainFile : 'index.js');

  // 收集 lib 目录或 main 目录下的所有 .js/.mjs/.cjs 文件
  const libDirs = [
    join(pkgDir, mainDir),
    join(pkgDir, 'lib'),
    join(pkgDir, 'dist'),
  ].filter(d => existsSync(d));

  for (const libDir of libDirs) {
    walkDir(libDir, pkgName, pkgDir, files);
  }

  // 确保 package.json 也上传（Node 模块解析需要）
  if (!files.some(f => f.remotePath === `node_modules/${pkgName}/package.json`)) {
    files.push({
      remotePath: `node_modules/${pkgName}/package.json`,
      data: readFileSync(join(pkgDir, 'package.json')),
    });
  }

  return files;
}

/**
 * 递归遍历目录收集 JS 文件
 * @param dir - 当前目录
 * @param pkgName - 包名
 * @param pkgRoot - 包根目录
 * @param files - 文件列表（追加）
 */
function walkDir(dir: string, pkgName: string, pkgRoot: string, files: DependencyFile[]): void {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    const relPath = fullPath.slice(pkgRoot.length + 1).replace(/\\/g, '/');

    if (entry.isDirectory()) {
      if (EXCLUDE_PATTERNS.some(p => p.test(`/${relPath}/`))) continue;
      walkDir(fullPath, pkgName, pkgRoot, files);
    } else if (entry.isFile() && (entry.name.endsWith('.js') || entry.name.endsWith('.mjs') || entry.name.endsWith('.cjs'))) {
      if (EXCLUDE_PATTERNS.some(p => p.test(relPath))) continue;
      files.push({
        remotePath: `node_modules/${pkgName}/${relPath}`,
        data: readFileSync(fullPath),
      });
    }
  }
}

/**
 * 递归收集 helper 所需的所有 npm 依赖文件（含传递依赖）
 * @param helperBundleDir - helper bundle 所在目录（用于解析依赖）
 * @returns 所有依赖文件
 */
export function collectHelperDependencies(helperBundleDir: string): DependencyFile[] {
  const allFiles: DependencyFile[] = [];
  collectedPackages.clear();

  // 从 helper.mjs 的 imports 开始，递归收集所有依赖
  // 先收集直接依赖
  const rootPackages = [
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-fs',
    '@deepseek-ai/dsh-fs-sandbox',
    '@deepseek-ai/dsh-subprocess',
    '@deepseek-ai/dsh-subprocess-local',
    '@deepseek-ai/dsh-sandbox',
    '@deepseek-ai/dsh-sandbox-local',
    '@deepseek-ai/dsh-sandbox-policy',
    '@deepseek-ai/dsh-session-projection',
    'zod',
  ];

  // 使用工作队列递归收集
  const queue = [...rootPackages];
  while (queue.length > 0) {
    const pkgName = queue.shift()!;
    if (collectedPackages.has(pkgName)) continue;
    collectedPackages.add(pkgName);

    const pkgDir = resolvePackageDir(pkgName, helperBundleDir);
    if (!pkgDir) {
      console.warn(`  警告: 未找到包 ${pkgName}`);
      continue;
    }

    const files = collectPackageFiles(pkgDir, pkgName);
    allFiles.push(...files);
    console.log(`  收集 ${pkgName}: ${files.length} 个文件`);

    // 读取该包的 dependencies 和 peerDependencies，递归收集
    try {
      const pkgJson = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
      const deps = {
        ...pkgJson.dependencies,
        ...pkgJson.peerDependencies,
      };
      for (const depName of Object.keys(deps)) {
        // 只收集 @deepseek-ai/* 和 zod，跳过其他通用依赖
        if (depName.startsWith('@deepseek-ai/') || depName === 'zod') {
          if (!collectedPackages.has(depName)) queue.push(depName);
        }
      }
    } catch {
      // 忽略读取错误
    }
  }

  return allFiles;
}

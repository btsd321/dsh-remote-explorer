/**
 * @file 分发包打包脚本
 * @description 产出「目标机零依赖、解压即用」的安装包：esbuild 把 CLI 连同全部
 *              运行时依赖（ssh2 / ssh-config / yaml）打进单个 .cjs，再按目标
 *              平台打入官方 Node 二进制与启动器。
 *
 * 与「仓库无构建步骤」的关系：开发流程仍然 tsx 直跑 .ts，本脚本只服务分发，
 * 产物落在 dist/（已 gitignore），不进仓库、不影响源码运行方式。
 *
 * 为什么把 Node 二进制打进去：目标机可能没有 Node、也可能没有 npm 源；
 * 自带运行时让包在裸机器上离线可用。二进制从官方发行镜像下载并用
 * SHASUMS256.txt 校验完整性（分发二进制必须校验，不校验等于盲信链路）。
 *
 * 平台敏感点（决定 --os/--arch 有实质意义）：
 * - ssh2 的可选原生件 cpu-features 被标为 external——bundle 里保留 require，
 *   运行时抛 MODULE_NOT_FOUND 被 ssh2 的 try/catch 兜住，回落纯 JS（行为与
 *   npm 安装时未编译原生件的场景一致）
 * - Node 二进制按平台不同（文件名与内容都是）
 *
 * 用法：
 *   npx tsx scripts/package.ts                        # 打当前运行平台
 *   npx tsx scripts/package.ts --os linux --arch arm64
 *   npx tsx scripts/package.ts --all                  # 五平台全矩阵
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { build } from 'esbuild';
import { DEFAULT_NODE_VERSION } from '../src/provision/node-installer.js';
import { bold, cyan, dim, green, println, printTable, red, yellow, ProgressReporter } from '../src/cli/output.js';
import { toErrorMessage } from '../src/util/errors.js';

/** 仓库根目录（脚本在 scripts/ 下，上一级即根） */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Bundle 入口：cli 可执行入口（bin/dsh-remote.mjs 是 tsx 注册壳，分发不用它） */
const BUNDLE_ENTRY = join(REPO_ROOT, 'src', 'cli', 'bin.ts');

/** 随包分发的文档：许可 + 双语 README + 双语使用指南 */
const BUNDLED_DOCS: ReadonlyArray<{ from: string; to: string }> = [
  { from: 'LICENSE', to: 'LICENSE' },
  { from: 'README.md', to: 'README.md' },
  { from: 'README.cn.md', to: 'README.cn.md' },
  { from: 'docs/usage-cn.md', to: 'docs/usage-cn.md' },
  { from: 'docs/usage-en.md', to: 'docs/usage-en.md' },
];

/** 支持的目标操作系统（与 Node 官方发行的命名对应） */
const SUPPORTED_OS = ['win32', 'linux', 'darwin'] as const;

/** 支持的目标架构 */
const SUPPORTED_ARCH = ['x64', 'arm64'] as const;

/** --all 的目标矩阵（用户确认的范围） */
const ALL_TARGETS: ReadonlyArray<{ os: typeof SUPPORTED_OS[number]; arch: typeof SUPPORTED_ARCH[number] }> = [
  { os: 'win32', arch: 'x64' },
  { os: 'linux', arch: 'x64' },
  { os: 'linux', arch: 'arm64' },
  { os: 'darwin', arch: 'x64' },
  { os: 'darwin', arch: 'arm64' },
];

/** 镜像名 → Node 发行版根 URL */
const MIRRORS: Record<string, string> = {
  // 默认 npmmirror：国内可达且与官方 dist 同步；--mirror official 切官方
  npmmirror: 'https://npmmirror.com/mirrors/node',
  official: 'https://nodejs.org/dist',
};

/** Windows 自带的 bsdtar 路径（GNU tar 不支持 zip；Windows 10+ 必有此文件） */
const WINDOWS_BSDTAR = 'C:\\Windows\\System32\\tar.exe';

/** 单个打包目标 */
interface Target {
  /** 操作系统（Node process.platform 命名） */
  os: typeof SUPPORTED_OS[number];
  /** 架构 */
  arch: typeof SUPPORTED_ARCH[number];
}

/** 一个产物完成后的摘要信息 */
interface Artifact {
  /** 目标平台 */
  target: Target;
  /** 压缩包绝对路径 */
  file: string;
  /** 压缩包字节数 */
  bytes: number;
  /** 压缩包 sha256 */
  sha256: string;
}

/**
 * 解析 Node 发行包文件名（不含目录）。
 *
 * 官方命名：win32 → `node-vX-win-x64.zip`；其余 → `node-vX-linux-arm64.tar.gz`。
 *
 * @param version - Node 版本（形如 v24.11.1）
 * @param target - 目标平台
 * @returns 文件名
 */
function nodeDistName(version: string, target: Target): string {
  const platformPart = target.os === 'win32' ? `win-${target.arch}` : `${target.os}-${target.arch}`;
  const ext = target.os === 'win32' ? 'zip' : 'tar.gz';
  return `node-${version}-${platformPart}.${ext}`;
}

/**
 * 执行 tar（或解压 zip）命令，失败时抛带上下文的错误。
 *
 * Windows 的 Git Bash 里 `tar` 是 GNU tar（不支持 zip），所以 zip 相关操作
 * 优先用系统自带的 bsdtar（Windows 10+ 必有）。
 *
 * @param args - tar 参数（路径一律绝对路径，避免 cwd 差异）
 * @param needsBsdtar - 操作 zip 时为 true
 * @returns 无（失败即抛）
 * @throws Error tar 退出非零或找不到可用工具
 */
function runTar(args: string[], needsBsdtar: boolean): void {
  const candidates: string[] = [];
  if (needsBsdtar) {
    // 只有 bsdtar 认 zip；Windows 上优先用固定路径，其他平台试 PATH 里的 bsdtar
    if (process.platform === 'win32') {
      if (existsSync(WINDOWS_BSDTAR)) candidates.push(WINDOWS_BSDTAR);
    }
    candidates.push('tar');
  } else {
    candidates.push('tar');
  }

  let lastError = '';
  for (const candidate of candidates) {
    try {
      const output = execFileSync(candidate, ['--version'], { encoding: 'utf8' });
      const isBsdtar = output.includes('bsdtar');
      if (needsBsdtar && !isBsdtar) {
        lastError = `${candidate} 是 GNU tar，不支持 zip`;
        continue;
      }
      execFileSync(candidate, args, { stdio: 'ignore' });
      return;
    } catch (error) {
      // --version 失败说明该候选不可用；执行失败则记录 stderr 继续尝试下一候选
      lastError = `${candidate}: ${toErrorMessage(error)}`;
    }
  }
  throw new Error(`tar 执行失败（${args.join(' ')}）：${lastError}。`
    + (needsBsdtar ? '创建/解压 zip 需要 bsdtar（Windows 自带）或支持 zip 的 tar' : ''));
}

/**
 * 下载文件到本地（fetch，二进制整体落盘）。
 *
 * @param url - 下载地址
 * @param destFile - 目标文件绝对路径
 * @throws Error HTTP 非 2xx 或写入失败
 */
async function downloadFile(url: string, destFile: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`下载失败：${url}（HTTP ${response.status}）`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  writeFileSync(destFile, buffer);
}

/**
 * 计算文件的 sha256。
 *
 * @param file - 文件绝对路径
 * @returns 十六进制摘要
 */
function sha256Of(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/**
 * 取得目标平台的 Node 二进制：优先缓存，缺失则从镜像下载并校验。
 *
 * 校验：同目录 SHASUMS256.txt 里的条目必须与下载文件的 sha256 一致。
 * 缓存命中也重新校验（防缓存文件被篡改或截断，代价是一次本地哈希）。
 *
 * @param target - 目标平台
 * @param version - Node 版本
 * @param mirrorBase - 镜像根 URL
 * @param cacheDir - 缓存目录（dist/.node-cache）
 * @returns { archive: 发行包路径, nodeFile: 发行包内 Node 二进制的成员路径 }
 */
async function fetchNodeDist(
  target: Target,
  version: string,
  mirrorBase: string,
  cacheDir: string,
): Promise<{ archive: string; member: string }> {
  const distName = nodeDistName(version, target);
  const versionUrl = `${mirrorBase}/${version}`;
  const archiveFile = join(cacheDir, distName);
  // 发行包内的二进制成员路径：tar.gz 形如 node-vX-linux-x64/bin/node，zip 形如 node-vX-win-x64/node.exe
  const innerDir = distName.replace(/\.(tar\.gz|zip)$/, '');
  const member = target.os === 'win32' ? `${innerDir}/node.exe` : `${innerDir}/bin/node`;

  if (!existsSync(archiveFile)) {
    const sumsFile = join(cacheDir, 'SHASUMS256.txt');
    if (!existsSync(sumsFile)) {
      await downloadFile(`${versionUrl}/SHASUMS256.txt`, sumsFile);
    }
    await downloadFile(`${versionUrl}/${distName}`, archiveFile);

    // SHASUMS256.txt 可能是缓存里旧版本的（不含当前条目），重新拉一份再校验
    let expected = findExpectedSha(sumsFile, distName);
    if (expected === undefined) {
      await downloadFile(`${versionUrl}/SHASUMS256.txt`, sumsFile);
      expected = findExpectedSha(sumsFile, distName);
    }
    if (expected === undefined) {
      throw new Error(`镜像 ${versionUrl} 的 SHASUMS256.txt 中没有 ${distName} 的条目`);
    }
    const actual = sha256Of(archiveFile);
    if (actual !== expected) {
      rmSync(archiveFile);
      throw new Error(`Node 发行包校验失败：${distName}（期望 sha256 ${expected}，实际 ${actual}）`);
    }
  }

  return { archive: archiveFile, member };
}

/**
 * 从 SHASUMS256.txt 中找出指定文件的期望摘要。
 *
 * @param sumsFile - SHASUMS256.txt 路径
 * @param fileName - 目标文件名
 * @returns 期望的 sha256；没有条目时 undefined
 */
function findExpectedSha(sumsFile: string, fileName: string): string | undefined {
  const text = readFileSync(sumsFile, 'utf8');
  for (const line of text.split('\n')) {
    const match = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim());
    if (match && match[2] === fileName) return match[1];
  }
  return undefined;
}

/**
 * 从发行包中提取 Node 二进制到目标路径。
 *
 * @param archive - 发行包路径
 * @param member - 包内二进制成员路径
 * @param destFile - 目标文件绝对路径
 */
function extractNodeBinary(archive: string, member: string, destFile: string): void {
  const extractDir = dirname(destFile);
  // 只提取这一个成员（tar 支持成员选择；zip 走 bsdtar 同样支持）
  runTar(['-xf', archive, '-C', extractDir, member], archive.endsWith('.zip'));
  // 成员带着内层目录结构落地，挪到最终位置
  const extracted = join(extractDir, member);
  rmSync(destFile, { force: true });
  cpSync(extracted, destFile);
  // 清掉内层目录残留（bin/ 或空的内层目录）
  const innerTopName = member.split('/')[0];
  if (innerTopName !== undefined) {
    rmSync(join(extractDir, innerTopName), { recursive: true, force: true });
  }
}

/**
 * 组装单个平台的 staging 目录。
 *
 * @param stagingRoot - staging 根目录（其下建 dsh-remote/）
 * @param bundleFile - 已生成的 dsh-remote.cjs 路径
 * @param nodeBinaryFile - 已提取的 Node 二进制路径
 * @param target - 目标平台
 */
function assembleStaging(
  stagingRoot: string,
  bundleFile: string,
  nodeBinaryFile: string,
  target: Target,
): string {
  const pkgDir = join(stagingRoot, 'dsh-remote');
  rmSync(pkgDir, { recursive: true, force: true });
  mkdirSync(pkgDir, { recursive: true });

  // 1. 运行时三件套：Node 二进制、单文件 CLI、启动器
  cpSync(nodeBinaryFile, join(pkgDir, target.os === 'win32' ? 'node.exe' : 'node'));
  cpSync(bundleFile, join(pkgDir, 'dsh-remote.cjs'));
  if (target.os === 'win32') {
    // cmd 启动器：%~dp0 带结尾反斜杠；@ 抑制命令回显
    writeFileSync(join(pkgDir, 'dsh-remote.cmd'),
      '@"%~dp0node.exe" "%~dp0dsh-remote.cjs" %*\r\n');
  } else {
    // sh 启动器：以脚本自身位置定位 node 与 cjs，可在任意目录调用
    writeFileSync(join(pkgDir, 'dsh-remote'),
      '#!/bin/sh\nexec "$(dirname "$0")/node" "$(dirname "$0")/dsh-remote.cjs" "$@"\n');
  }

  // 2. 文档（许可必须随分发走）
  for (const doc of BUNDLED_DOCS) {
    const from = join(REPO_ROOT, doc.from);
    if (!existsSync(from)) continue;
    const to = join(pkgDir, doc.to);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to);
  }

  return pkgDir;
}

/**
 * 把 staging 目录压成目标平台的分发包。
 *
 * tar.gz 加 `--mode=755`：Windows 文件系统给不出执行位（fs chmod 是 no-op），
 * 统一 755 保证 sh 启动器与 node 在 POSIX 目标机上可直接执行。
 *
 * @param pkgDir - staging 里的 dsh-remote/ 目录
 * @param outDir - 产物目录
 * @param version - 本工具版本
 * @param target - 目标平台
 * @returns 产物文件路径
 */
function archivePackage(pkgDir: string, outDir: string, version: string, target: Target): string {
  const ext = target.os === 'win32' ? 'zip' : 'tar.gz';
  const outFile = join(outDir, `dsh-remote-${version}-${target.os}-${target.arch}.${ext}`);
  rmSync(outFile, { force: true });
  if (target.os === 'win32') {
    // bsdtar 的 -a 按扩展名自动选 zip 格式
    runTar(['-a', '-cf', outFile, '-C', dirname(pkgDir), 'dsh-remote'], true);
  } else {
    runTar(['-czf', outFile, '--mode=755', '-C', dirname(pkgDir), 'dsh-remote'], false);
  }
  return outFile;
}

/**
 * 打包单个目标平台。
 *
 * @param target - 目标平台
 * @param context - 版本、镜像、目录等共享上下文
 * @returns 产物摘要
 */
async function packageTarget(
  target: Target,
  context: {
    version: string;
    nodeVersion: string;
    mirrorBase: string;
    outDir: string;
    workDir: string;
    bundleFile: string;
  },
): Promise<Artifact> {
  const label = `${target.os}-${target.arch}`;
  println(bold(`打包 ${cyan(label)}`));

  // 1. 取 Node 发行包（缓存命中跳过下载），提取二进制
  const progress = new ProgressReporter();
  progress.start(`获取 Node ${context.nodeVersion} 发行包`);
  const dist = await fetchNodeDist(target, context.nodeVersion, context.mirrorBase, join(context.outDir, '.node-cache'));
  const nodeBinaryFile = join(context.workDir, label, 'node-binary');
  mkdirSync(dirname(nodeBinaryFile), { recursive: true });
  extractNodeBinary(dist.archive, dist.member, nodeBinaryFile);
  progress.done();

  // 2. 组装 staging 并压包
  progress.start('组装并压缩');
  const pkgDir = assembleStaging(join(context.workDir, label, 'staging'), context.bundleFile, nodeBinaryFile, target);
  const file = archivePackage(pkgDir, context.outDir, context.version, target);
  progress.done();

  return { target, file, bytes: statSync(file).size, sha256: sha256Of(file) };
}

/**
 * 脚本入口：解析参数 → bundle → 逐平台打包 → 汇总。
 */
async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      os: { type: 'string' },
      arch: { type: 'string' },
      all: { type: 'boolean', default: false },
      'node-version': { type: 'string' },
      mirror: { type: 'string', default: 'npmmirror' },
      'out-dir': { type: 'string', default: 'dist' },
      minify: { type: 'boolean', default: false },
    },
    strict: true,
  });

  // 1. 目标矩阵：--all 全矩阵；否则单个目标（默认当前运行平台）
  let targets: ReadonlyArray<Target>;
  if (values.all === true) {
    targets = ALL_TARGETS;
    if (values.os !== undefined || values.arch !== undefined) {
      println(yellow('已忽略 --os/--arch（--all 打全矩阵）'));
    }
  } else {
    const os = values.os ?? process.platform;
    const arch = values.arch ?? process.arch;
    if (!SUPPORTED_OS.includes(os as typeof SUPPORTED_OS[number])) {
      println(red(`不支持的 --os：${os}（可选 ${SUPPORTED_OS.join('、')}）`));
      return 64;
    }
    if (!SUPPORTED_ARCH.includes(arch as typeof SUPPORTED_ARCH[number])) {
      println(red(`不支持的 --arch：${arch}（可选 ${SUPPORTED_ARCH.join('、')}）`));
      return 64;
    }
    targets = [{ os: os as typeof SUPPORTED_OS[number], arch: arch as typeof SUPPORTED_ARCH[number] }];
  }

  // 2. 镜像：npmmirror / official / 自定义 URL 前缀
  const mirror = values.mirror ?? 'npmmirror';
  const mirrorBase = MIRRORS[mirror] ?? mirror;

  // 3. 版本与目录
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string };
  const nodeVersion = values['node-version'] ?? DEFAULT_NODE_VERSION;
  const outDir = resolve(REPO_ROOT, values['out-dir'] ?? 'dist');
  const workDir = join(outDir, '.staging');
  mkdirSync(join(outDir, '.node-cache'), { recursive: true });
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });

  // 4. Bundle：单文件 CLI（全平台共用，只做一次）
  println(bold(`打包 dsh-remote ${pkg.version}（Node ${nodeVersion}，${mirror} 镜像）`));
  const progress = new ProgressReporter();
  progress.start('esbuild 打包单文件 CLI');
  const bundleFile = join(workDir, 'dsh-remote.cjs');
  await build({
    entryPoints: [BUNDLE_ENTRY],
    outfile: bundleFile,
    // CJS 而非 ESM：ssh2 内部有惰性 require('net') 等动态 require，ESM 输出下
    // esbuild 的 __require 垫片会直接抛错；CJS 输出下动态 require 原生可用。
    // 源码无顶层 await，CJS 化没有障碍
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    bundle: true,
    // cpu-features 是 ssh2 的可选原生件：external 保留 require，运行时缺件由
    // ssh2 的 try/catch 兜住回落纯 JS；nan 只在编译 cpu-features 时用到
    external: ['cpu-features', 'nan'],
    minify: values.minify === true,
  });
  progress.done(`${(statSync(bundleFile).size / 1_000_000).toFixed(1)} MB`);

  // 5. 逐平台打包（Node 下载缓存在 dist/.node-cache，跨平台共享）
  const artifacts: Artifact[] = [];
  for (const target of targets) {
    try {
      artifacts.push(await packageTarget(target, {
        version: pkg.version,
        nodeVersion,
        mirrorBase,
        outDir,
        workDir,
        bundleFile,
      }));
    } catch (error) {
      println(red(`✗ 打包 ${target.os}-${target.arch} 失败：${toErrorMessage(error)}`));
      return 1;
    }
  }

  // 6. 汇总
  println();
  printTable(
    ['产物', '大小'],
    artifacts.map(a => [cyan(a.file), `${(a.bytes / 1_000_000).toFixed(1)} MB`]),
  );
  println();
  for (const a of artifacts) {
    println(dim(`${a.file}\n  sha256 ${a.sha256}`));
  }
  println();
  println(green(`完成：${artifacts.length} 个产物在 ${outDir}`));
  println(dim('目标机解压后直接运行 dsh-remote（Windows 用 dsh-remote.cmd），无需 Node 与 npm'));
  println(dim('产物不提交进仓库（dist 已 gitignore）'));

  // 清理 staging（保留 .node-cache 与产物）
  rmSync(workDir, { recursive: true, force: true });
  return 0;
}

process.exitCode = await main();

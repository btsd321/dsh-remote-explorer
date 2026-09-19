/**
 * @file 镜像源持久化测试
 * @description 验证 Node 下载镜像源的读写与持久化，不需要远端主机即可运行。
 *
 * 覆盖点：
 * 1. 模块能正常加载（remote-bootstrap.ts 在模块顶层求值镜像源配置路径，
 *    缺 import 会在 import 阶段直接抛错，此测试可当场拦住）
 * 2. setNodeMirror 改变内存值并落盘
 * 3. 新进程能从 ~/.dsh/remote-ssh-mirror.json 恢复镜像源
 * 4. 配置文件损坏时回落默认值
 *
 * 运行：npx tsx tests/test-mirror-config.ts
 */

import { setNodeMirror, getNodeMirror, type NodeMirror } from '../src/remote-bootstrap.ts';
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 镜像源持久化文件路径（与 remote-bootstrap.ts 中保持一致） */
const CONFIG_PATH = join(homedir(), '.dsh', 'remote-ssh-mirror.json');
/** 测试脚本所在目录 */
const TEST_DIR = dirname(fileURLToPath(import.meta.url));

/** 失败计数 */
let failures = 0;

/**
 * 断言两值相等
 * @param actual - 实际值
 * @param expected - 期望值
 * @param label - 断言说明
 */
function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual === expected) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ ${label}：期望 ${String(expected)}，实际 ${String(actual)}`);
    failures++;
  }
}

/**
 * 在子进程中读取镜像源，模拟"重启后恢复"
 * @returns 子进程加载到的镜像源
 */
function readMirrorInFreshProcess(): string {
  const script = `import { getNodeMirror } from '../src/remote-bootstrap.ts'; process.stdout.write(getNodeMirror());`;
  const scriptPath = join(TEST_DIR, 'tmp-mirror-probe.ts');
  writeFileSync(scriptPath, script, 'utf8');
  try {
    // 必须走 tsx：Node 原生类型剥离不会把 import 里的 .js 改写成 .ts，
    // 而 remote-bootstrap.ts 用的是 ESM 风格的 './dependency-collector.js'。
    // 用单条命令字符串而非 args 数组，避免 execFileSync 的 shell 参数转义告警。
    return execSync(`npx tsx "${scriptPath}"`, { cwd: TEST_DIR, encoding: 'utf8' }).trim();
  } finally {
    unlinkSync(scriptPath);
  }
}

// 备份用户原有配置，测试结束后恢复
const hadConfig = existsSync(CONFIG_PATH);
const backup = hadConfig ? readFileSync(CONFIG_PATH, 'utf8') : undefined;

try {
  console.log('1. 默认值与落盘');
  setNodeMirror('tsinghua');
  assertEqual(getNodeMirror(), 'tsinghua', 'setNodeMirror 改变内存值');
  assertEqual(JSON.parse(readFileSync(CONFIG_PATH, 'utf8')).mirror, 'tsinghua', '镜像源已落盘');

  console.log('2. 四个镜像源都能读写');
  for (const m of ['official', 'aliyun', 'tsinghua', 'ustc'] as NodeMirror[]) {
    setNodeMirror(m);
    assertEqual(JSON.parse(readFileSync(CONFIG_PATH, 'utf8')).mirror, m, `${m} 落盘正确`);
  }

  console.log('3. 新进程恢复持久化的镜像源');
  setNodeMirror('ustc');
  assertEqual(readMirrorInFreshProcess(), 'ustc', '子进程加载到 ustc');

  console.log('4. 配置文件损坏时回落默认值');
  writeFileSync(CONFIG_PATH, '{ 这不是合法 JSON', 'utf8');
  assertEqual(readMirrorInFreshProcess(), 'official', '损坏配置回落 official');

  console.log('5. 非法镜像源值回落默认值');
  writeFileSync(CONFIG_PATH, JSON.stringify({ mirror: 'not-a-mirror' }), 'utf8');
  assertEqual(readMirrorInFreshProcess(), 'official', '非法值回落 official');
} finally {
  // 恢复用户原有配置
  if (backup !== undefined) {
    mkdirSync(dirname(CONFIG_PATH), { recursive: true });
    writeFileSync(CONFIG_PATH, backup, 'utf8');
    console.log('已恢复原镜像源配置');
  } else if (existsSync(CONFIG_PATH)) {
    unlinkSync(CONFIG_PATH);
    console.log('已清理测试产生的配置文件');
  }
}

if (failures > 0) {
  console.error(`\n失败 ${failures} 项`);
  process.exit(1);
}
console.log('\n全部通过');

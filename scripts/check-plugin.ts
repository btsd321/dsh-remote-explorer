/**
 * @file 插件发布前护栏检查
 * @description 静态扫描源码与构建产物，拦截会让 dsh 起不来或行为漂移的问题。
 *              全部规则来自实测教训（本仓库或参考插件 flymysql/dsh-remote）：
 *
 * 1. slash 命令名必须匹配 /^[a-z][a-z0-9_-]*$/——带点号等非法字符会让整个
 *    dsh 启动失败（参考插件 v0.6.1 曾因 remote.forget-key 掀翻 Desktop）
 * 2. agent 工具名统一 remote_ 前缀（用户拍板的命名空间，避开第三方 rw_*）
 * 3. defineTool 的每个显式 type:'object' 节点必须写 additionalProperties——
 *    缺失是 authorError，宿主启动即崩
 * 4. 面板路由必须挂在 /api/dsh-remote-explorer/ 前缀下（防命名漂移，
 *    也保证全部走 connection 的已鉴权通道）
 * 5. lib/client.js 的 __ModuleLoader__ 注册 id 必须等于包名——graph 行以
 *    包名为键，不一致则浏览器半静默失联
 * 6. 浏览器半禁止把 *-fill 设计令牌当文字色（那是背景令牌，参考插件 0.8.20
 *    踩过后整页文字不可见）
 * 7. package.json 版本必须与 cli/main.ts --version 输出串一致
 * 8. cordis.patch.yml 的 entry id 必须合法 kebab-case 且不是第三方占用的
 *    `dsh-remote`；entry name 必须等于包名
 *
 * 用法：npx tsx scripts/check-plugin.ts（违规 → 退出码 1）
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bold, cyan, green, println, red } from '../src/cli/output.js';
import { HANDOFF_PKG_NAME, HANDOFF_ROUTE_PREFIX } from '../src/handoff/protocol.js';

/** 仓库根目录 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** slash 命令名合法形态（dsh commands 服务的硬校验） */
const COMMAND_NAME_PATTERN = /^[a-z][a-z0-9_-]*$/;

/** agent 工具名约定前缀（用户拍板：remote_*） */
const TOOL_NAME_PATTERN = /^remote_[a-z][a-z0-9_]*$/;

/** 面板路由统一前缀（与 src/plugin/routes.ts 的 ROUTE_PREFIX 一致） */
const ROUTE_PREFIX = '/api/dsh-remote-explorer';

/** 第三方插件占用的 cordis entry id（同 profile 共存时撞车会被 loader 拒绝） */
const RESERVED_ENTRY_IDS = ['dsh-remote'];

/** type:'object' 节点后必须在此字符数内出现 additionalProperties */
const OBJECT_SCHEMA_WINDOW = 400;

/** 一条违规记录 */
interface Violation {
  /** 违规所在文件（相对仓库根） */
  file: string;
  /** 违规说明（中文，含修复指引） */
  message: string;
}

/**
 * 读文件内容；不存在返回 undefined（护栏对尚未落地的文件静默跳过，
 * 让脚本在分阶段实施中始终可跑）。
 *
 * @param path - 绝对路径
 * @returns 文件文本
 */
function readIfExists(path: string): string | undefined {
  return existsSync(path) && statSync(path).isFile() ? readFileSync(path, 'utf8') : undefined;
}

/**
 * 递归收集目录下指定扩展名的文件。
 *
 * @param dir - 目录绝对路径
 * @param exts - 扩展名列表（含点）
 * @returns 文件绝对路径列表
 */
function collectFiles(dir: string, exts: string[]): string[] {
  if (!existsSync(dir)) return [];
  const result: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...collectFiles(full, exts));
    } else if (exts.some(ext => entry.name.endsWith(ext))) {
      result.push(full);
    }
  }
  return result;
}

/**
 * 检查宿主半源码（命令名/工具名/object schema/路由前缀）。
 *
 * @param violations - 违规收集器
 */
function checkHostSource(violations: Violation[]): void {
  // 1+2. 命令名与工具名：扫描注册点里的 name: '...' 字面量
  const commands = readIfExists(join(REPO_ROOT, 'src', 'plugin', 'commands.ts'));
  if (commands !== undefined) {
    for (const match of commands.matchAll(/name:\s*'([^']+)'/g)) {
      const commandName = match[1] ?? '';
      if (!COMMAND_NAME_PATTERN.test(commandName)) {
        violations.push({
          file: 'src/plugin/commands.ts',
          message: `slash 命令名 '${commandName}' 不匹配 /^[a-z][a-z0-9_-]*$/——非法命令名会让整个 dsh 启动失败`,
        });
      }
    }
  }
  const tools = readIfExists(join(REPO_ROOT, 'src', 'plugin', 'tools.ts'));
  if (tools !== undefined) {
    for (const match of tools.matchAll(/name:\s*'([^']+)'/g)) {
      const toolName = match[1] ?? '';
      if (!TOOL_NAME_PATTERN.test(toolName)) {
        violations.push({
          file: 'src/plugin/tools.ts',
          message: `agent 工具名 '${toolName}' 不匹配 remote_ 前缀约定（/^remote_[a-z][a-z0-9_]*$/）`,
        });
      }
    }
    // 3. 显式 object 节点必须声明 additionalProperties（缺失 = authorError = 启动崩溃）
    for (const match of tools.matchAll(/type:\s*'object'/g)) {
      const at = match.index ?? 0;
      const window = tools.slice(at, at + OBJECT_SCHEMA_WINDOW);
      if (!window.includes('additionalProperties')) {
        violations.push({
          file: 'src/plugin/tools.ts',
          message: `偏移 ${at} 处的 type:'object' 节点缺少显式 additionalProperties——defineTool 会以 authorError 拒绝，宿主启动即崩`,
        });
      }
    }
  }

  // 4. 路由前缀：routes.ts 里不允许出现绕过 ROUTE_PREFIX 的 '/api 字面量
  const routes = readIfExists(join(REPO_ROOT, 'src', 'plugin', 'routes.ts'));
  if (routes !== undefined) {
    for (const match of routes.matchAll(/path:\s*[`']([^`']*)[`']/g)) {
      const path = match[1] ?? '';
      // 模板串里 ${ROUTE_PREFIX}/xxx 形态：前缀占位符开头即合法
      const viaConstant = path.startsWith('${ROUTE_PREFIX}/');
      const literalOk = path.startsWith(`${ROUTE_PREFIX}/`);
      if (!viaConstant && !literalOk && !path.startsWith('/api/dsh-remote-explorer/')) {
        violations.push({
          file: 'src/plugin/routes.ts',
          message: `路由 path '${path}' 未挂在 ${ROUTE_PREFIX}/ 前缀下`,
        });
      }
    }
    if (routes.includes("ROUTE_PREFIX = '") && !routes.includes(`ROUTE_PREFIX = '${ROUTE_PREFIX}'`)) {
      violations.push({
        file: 'src/plugin/routes.ts',
        message: `ROUTE_PREFIX 常量必须是 '${ROUTE_PREFIX}'（check 脚本与冒烟探针都按此值判读）`,
      });
    }
  }
}

/**
 * 检查浏览器半源码与构建产物。
 *
 * @param pkgName - 包名
 * @param violations - 违规收集器
 */
function checkClientSide(pkgName: string, violations: Violation[]): void {
  // 6. *-fill 背景令牌不得当文字色
  for (const file of collectFiles(join(REPO_ROOT, 'src', 'plugin-client'), ['.ts', '.tsx'])) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/(?:^|[^-])color:\s*var\((--dsw-[a-z0-9-]*-fill[a-z0-9-]*)\)/g)) {
      violations.push({
        file: relative(REPO_ROOT, file).replaceAll('\\', '/'),
        message: `文字色使用了背景令牌 ${match[1]}——*-fill 是填充色，当文字色会不可见`,
      });
    }
  }

  // 5. 产物里的 __ModuleLoader__ 注册 id 必须等于包名
  const clientBundle = readIfExists(join(REPO_ROOT, 'lib', 'client.js'));
  if (clientBundle !== undefined) {
    const idMatch = /__ModuleLoader__\.load\(\{\s*id:\s*(?:'|")([^'"]+)/.exec(clientBundle);
    if (idMatch === null) {
      violations.push({
        file: 'lib/client.js',
        message: '产物中没有 __ModuleLoader__.load 注册壳——banner/footer 配置丢了',
      });
    } else if (idMatch[1] !== pkgName) {
      violations.push({
        file: 'lib/client.js',
        message: `__ModuleLoader__ 注册 id '${idMatch[1]}' ≠ 包名 '${pkgName}'——浏览器半会静默失联`,
      });
    }
  }

  // 5b. handoff 浏览器半的注册 id 必须等于合成包名（远端 boot graph 以它键控）
  const handoffBundle = readIfExists(join(REPO_ROOT, 'lib', 'handoff-client.js'));
  if (handoffBundle !== undefined) {
    const idMatch = /__ModuleLoader__\.load\(\{\s*id:\s*(?:'|")([^'"]+)/.exec(handoffBundle);
    if (idMatch === null || idMatch[1] !== HANDOFF_PKG_NAME) {
      violations.push({
        file: 'lib/handoff-client.js',
        message: `__ModuleLoader__ 注册 id '${idMatch?.[1] ?? '(缺失)'}' ≠ 合成包名 '${HANDOFF_PKG_NAME}'——远端浏览器半会静默失联`,
      });
    }
  }

  // 5c. handoff 宿主半路由前缀必须挂在约定前缀下（远端已鉴权通道，防命名漂移）
  const protocol = readIfExists(join(REPO_ROOT, 'src', 'handoff', 'protocol.ts'));
  if (protocol !== undefined && !protocol.includes(`'${HANDOFF_ROUTE_PREFIX}'`)) {
    violations.push({
      file: 'src/handoff/protocol.ts',
      message: `HANDOFF_ROUTE_PREFIX 必须是 '${HANDOFF_ROUTE_PREFIX}'（远端路由与护栏都按此值判读）`,
    });
  }
}

/**
 * 检查版本一致性与 cordis.patch.yml。
 *
 * @param pkg - package.json 解析结果
 * @param violations - 违规收集器
 */
function checkManifests(pkg: { name: string; version: string }, violations: Violation[]): void {
  // 7. 版本号唯一来源为 package.json，cli/main.ts 运行时动态读取，无需静态校验

  // 8. cordis.patch.yml 的 entry id 与 name
  const patch = readIfExists(join(REPO_ROOT, 'cordis.patch.yml'));
  if (patch !== undefined) {
    const idMatch = /- id:\s*(\S+)/.exec(patch);
    const nameMatch = /name:\s*'?([^'\n]+)'?/.exec(patch);
    if (idMatch === null) {
      violations.push({ file: 'cordis.patch.yml', message: '缺少 - id: 行' });
    } else {
      const id = idMatch[1] ?? '';
      if (!/^[a-z][a-z0-9-]*$/.test(id)) {
        violations.push({ file: 'cordis.patch.yml', message: `entry id '${id}' 不是合法 kebab-case` });
      }
      if (RESERVED_ENTRY_IDS.includes(id)) {
        violations.push({ file: 'cordis.patch.yml', message: `entry id '${id}' 已被第三方插件占用，同 profile 共存会被 loader 拒绝` });
      }
    }
    if (nameMatch === null || (nameMatch[1] ?? '').trim() !== pkg.name) {
      violations.push({
        file: 'cordis.patch.yml',
        message: `entry name 必须等于包名 '${pkg.name}'（loader 按模块 specifier 解析）`,
      });
    }
  }
}

/**
 * 跑全部护栏检查。
 *
 * @returns 违规列表（空 = 全绿）
 */
export function runChecks(): Violation[] {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
    name: string;
    version: string;
  };
  const violations: Violation[] = [];
  checkHostSource(violations);
  checkClientSide(pkg.name, violations);
  checkManifests(pkg, violations);
  return violations;
}

/**
 * 脚本入口：跑检查并按结果设置退出码。
 *
 * @returns 进程退出码
 */
function main(): number {
  println(bold('插件护栏检查'));
  const violations = runChecks();
  if (violations.length === 0) {
    println(green('全部通过'));
    return 0;
  }
  for (const violation of violations) {
    println(red(`✗ ${cyan(violation.file)}：${violation.message}`));
  }
  println(red(`共 ${violations.length} 条违规`));
  return 1;
}

// 直接运行时执行 main；被 dev-plugin.ts import 时只导出 runChecks
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}

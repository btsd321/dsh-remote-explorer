/**
 * @file 插件构建脚本
 * @description esbuild 双入口，产出 dsh 插件形态需要的两个文件：
 *              - lib/index.js  宿主半（ESM/Node）——dsh loader 纯 ESM import
 *                加载；对 @deepseek-ai/* peer 的裸导入必须保持 ESM import 形态，
 *                才能经 profile 的安装回退链接（$DSH_HOME/profiles/node_modules）
 *                解析到宿主的同一份实例。实测 CJS 产物 require() ESM-only 的
 *                dsh-tools 会直接崩（ERR_INTERNAL_ASSERTION），不能走那条路
 *              - lib/client.js 浏览器半（CJS/browser）——外层包成
 *                window.__ModuleLoader__.load({ id: <包名>, factory }) 注册壳
 *
 * 与「仓库无构建步骤」的关系：开发流程仍然 tsx 直跑 .ts（CLI 形态零变化），
 * 本脚本只服务插件分发——dsh 宿主经纯 ESM import 加载插件，不走 tsx，所以
 * 插件入口必须是构建产物。产物落 lib/（已 gitignore），随 npm files 发布。
 *
 * 宿主半 ESM 与 ssh2 惰性 require 的矛盾用 createRequire banner 化解：
 * esbuild 的 __require 垫片在 typeof require !== 'undefined' 时直接用它，
 * banner 注入的真实 require 让 require('net')/require('cpu-features') 照常工作。
 * （scripts/package.ts 仍选 CJS——它独立运行，没有 loader/peer 解析问题。）
 *
 * 用法：
 *   npx tsx scripts/build-plugin.ts [--minify]
 */

import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { build } from 'esbuild';
import { bold, cyan, dim, green, println, ProgressReporter, red } from '../src/cli/output.js';
import { HANDOFF_PKG_NAME } from '../src/handoff/protocol.js';
import { toErrorMessage } from '../src/util/errors.js';

/** 仓库根目录（脚本在 scripts/ 下，上一级即根） */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 插件构建产物目录（已 gitignore，随 npm files 发布） */
const LIB_DIR = join(REPO_ROOT, 'lib');

/**
 * 宿主半 external：@deepseek-ai/* 全部走宿主实例。
 *
 * cordis 单实例是硬约束（插件与宿主必须共享同一个服务注册表）；dsh 服务包
 * 经 profile 的安装回退链接（$DSH_HOME/profiles/node_modules）解析到 dsh
 * 安装树的同一份。ssh2 的可选原生件 cpu-features/nan 与 package.ts 同理
 * external，缺件回落纯 JS。schemastery 是 dependencies（对齐参考插件的
 * 做法），pnpm 会装进 profile，external 后运行时从那里解析。
 */
const HOST_EXTERNAL = ['@deepseek-ai/*', 'cpu-features', 'nan'];

/**
 * 宿主半 banner：给 ESM 产物补齐 CJS 环境三件套（require/__filename/__dirname）。
 *
 * ssh2 等被内联的 CJS 依赖里有惰性 require('net')/require('cpu-features')
 * 与 __dirname 引用（crypto.js 定位内置资源）——esbuild 的 __require 垫片在
 * ESM 输出下优先使用作用域里的 require，__dirname 则完全是自由变量；
 * banner 注入的三个绑定让它们照常工作（实测缺 __dirname 会在 ssh2 初始化时崩）。
 */
const HOST_BANNER = [
  "import { createRequire as __dshRemoteCreateRequire } from 'node:module';",
  "import { fileURLToPath as __dshRemoteFileURLToPath } from 'node:url';",
  "import { dirname as __dshRemoteDirname } from 'node:path';",
  'const require = __dshRemoteCreateRequire(import.meta.url);',
  'const __filename = __dshRemoteFileURLToPath(import.meta.url);',
  'const __dirname = __dshRemoteDirname(__filename);',
].join('\n');

/** 构建选项 */
export interface BuildPluginOptions {
  /** 是否压缩产物（默认否——dev 沙箱与冒烟判读都依赖可读产物） */
  minify?: boolean;
}

/**
 * 构建插件双入口。
 *
 * @param options - 构建选项
 * @throws Error esbuild 失败
 */
export async function buildPlugin(options: BuildPluginOptions = {}): Promise<void> {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
    name: string;
    version: string;
  };
  rmSync(LIB_DIR, { recursive: true, force: true });
  mkdirSync(LIB_DIR, { recursive: true });

  // 版本号构建期注入（ping 路由回报用），避免运行时读 package.json 的路径耦合
  const define = { __PLUGIN_VERSION__: JSON.stringify(pkg.version) };
  const minify = options.minify === true;

  // 0. handoff 双入口先构建：产物文本随后经 define 内联进宿主半（单文件
  //    分发形态运行期没有相邻 lib/ 可读，见 src/handoff/payload.ts）
  await build({
    entryPoints: [join(REPO_ROOT, 'src', 'handoff', 'host.ts')],
    outfile: join(LIB_DIR, 'handoff-host.js'),
    format: 'esm',
    platform: 'node',
    target: 'node20',
    bundle: true,
    external: HOST_EXTERNAL,
    define,
    minify,
  });
  await build({
    entryPoints: [join(REPO_ROOT, 'src', 'handoff', 'client.tsx')],
    outfile: join(LIB_DIR, 'handoff-client.js'),
    format: 'cjs',
    platform: 'browser',
    target: 'es2020',
    bundle: true,
    external: ['react'],
    jsx: 'transform',
    jsxFactory: 'React.createElement',
    jsxFragment: 'React.Fragment',
    define,
    minify,
    // 注册壳 id 是合成包名（不是本包名）：graph 行以它键控，check-plugin 盯守
    banner: {
      js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(HANDOFF_PKG_NAME)}, factory: (require) => { `
        + 'var module = { exports: {} }; var exports = module.exports;',
    },
    footer: { js: 'return module.exports; } });' },
  });
  const handoffDefine = {
    ...define,
    __HANDOFF_HOST_SRC__: JSON.stringify(readFileSync(join(LIB_DIR, 'handoff-host.js'), 'utf8')),
    __HANDOFF_CLIENT_SRC__: JSON.stringify(readFileSync(join(LIB_DIR, 'handoff-client.js'), 'utf8')),
  };

  // 1. 宿主半 → lib/index.js（ESM，理由见文件头：peer 裸导入必须走 ESM
  //    解析链才能命中 profile 的安装回退链接；CJS require(esm) 实测会崩）
  await build({
    entryPoints: [join(REPO_ROOT, 'src', 'plugin', 'index.ts')],
    outfile: join(LIB_DIR, 'index.js'),
    format: 'esm',
    platform: 'node',
    target: 'node20',
    bundle: true,
    external: HOST_EXTERNAL,
    banner: { js: HOST_BANNER },
    // handoff 产物文本随宿主半内联（引导期写进远端会话 profile）
    define: handoffDefine,
    minify,
  });

  // 2. 浏览器半 → lib/client.js（classic script，外层包 factory 注册壳）
  //    banner/footer 手工声明 module/exports：esbuild 的 CJS 产物末尾
  //    `module.exports = __toCommonJS(...)` 整体重赋值，footer 返回它即为
  //    factory 的返回值（含 name/inject/apply）
  await build({
    entryPoints: [join(REPO_ROOT, 'src', 'plugin-client', 'index.tsx')],
    outfile: join(LIB_DIR, 'client.js'),
    format: 'cjs',
    platform: 'browser',
    target: 'es2020',
    bundle: true,
    // react 由 __ModuleLoader__ factory 的同步 require 命中平台种子（React 18.2）
    external: ['react'],
    // classic JSX transform：产物只做 React.createElement 调用，不依赖自动 runtime
    jsx: 'transform',
    jsxFactory: 'React.createElement',
    jsxFragment: 'React.Fragment',
    define,
    minify,
    banner: {
      js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(pkg.name)}, factory: (require) => { `
        + 'var module = { exports: {} }; var exports = module.exports;',
    },
    footer: { js: 'return module.exports; } });' },
  });
}

/**
 * 脚本入口：解析参数 → 构建 → 汇总。
 *
 * @returns 进程退出码
 */
async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      minify: { type: 'boolean', default: false },
    },
    strict: true,
  });

  println(bold('构建 dsh 插件（宿主半 + 浏览器半）'));
  const progress = new ProgressReporter();
  try {
    progress.start('esbuild 双入口打包');
    await buildPlugin({ minify: values.minify === true });
    const hostSize = statSync(join(LIB_DIR, 'index.js')).size;
    const clientSize = existsSync(join(LIB_DIR, 'client.js'))
      ? statSync(join(LIB_DIR, 'client.js')).size
      : 0;
    const handoffHostSize = existsSync(join(LIB_DIR, 'handoff-host.js'))
      ? statSync(join(LIB_DIR, 'handoff-host.js')).size
      : 0;
    const handoffClientSize = existsSync(join(LIB_DIR, 'handoff-client.js'))
      ? statSync(join(LIB_DIR, 'handoff-client.js')).size
      : 0;
    progress.done(`index.js ${(hostSize / 1000).toFixed(0)} KB，client.js ${(clientSize / 1000).toFixed(0)} KB，`
      + `handoff ${(handoffHostSize + handoffClientSize) / 1000 | 0} KB`);
  } catch (error) {
    progress.fail('失败');
    println(red(`构建失败：${toErrorMessage(error)}`));
    return 1;
  }
  println(green(`完成：产物在 ${cyan(LIB_DIR)}`));
  println(dim('lib/ 已 gitignore，只随 npm files 发布；开发流程仍 tsx 直跑源码'));
  return 0;
}

// 直接运行时执行 main；被 dev-plugin.ts import 时只导出 buildPlugin
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}

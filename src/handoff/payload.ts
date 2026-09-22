/**
 * @file 远端 handoff bundle 的产物载荷
 * @description handoff 两个产物（host/client）以字符串内联进宿主半 bundle：
 *              CLI 分发包是 esbuild 单文件、插件宿主半同样是单文件，运行期都
 *              没有相邻的 lib/ 目录可读，所以构建期由 build-plugin.ts 经 define
 *              把产物文本注入（先构建 handoff 双入口，再构建宿主半）。
 *
 * 开发流程（tsx 直跑 src、无 define）回退读磁盘 lib/——跑过一次
 * build-plugin.ts 即存在；仍缺失时返回 undefined，引导阶段以「跳过」呈现，
 * 不阻断会话（handoff 是增强面，不是会话成立条件）。
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 构建期注入（build-plugin.ts 的 define）；dev 流程下不存在，
// typeof 检查对未声明标识符是安全的（不抛 ReferenceError）
declare const __HANDOFF_HOST_SRC__: string;
declare const __HANDOFF_CLIENT_SRC__: string;

/** handoff bundle 的两个产物文本 */
export interface HandoffPayload {
  /** 宿主半（ESM，远端 dsh loader 纯 ESM import 加载） */
  host: string;
  /** 浏览器半（__ModuleLoader__ 注册壳，id = dsh-remote-handoff） */
  client: string;
}

/**
 * 取 handoff 产物载荷：define 优先，dev 流程回退磁盘 lib/。
 *
 * @returns 载荷；两者都不可用时 undefined（引导阶段跳过安装）
 */
export function loadHandoffPayload(): HandoffPayload | undefined {
  if (typeof __HANDOFF_HOST_SRC__ === 'string' && typeof __HANDOFF_CLIENT_SRC__ === 'string') {
    return { host: __HANDOFF_HOST_SRC__, client: __HANDOFF_CLIENT_SRC__ };
  }
  try {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
    return {
      host: readFileSync(join(root, 'lib', 'handoff-host.js'), 'utf8'),
      client: readFileSync(join(root, 'lib', 'handoff-client.js'), 'utf8'),
    };
  } catch {
    return undefined;
  }
}

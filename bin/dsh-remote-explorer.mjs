#!/usr/bin/env node
/**
 * @file dsh-remote-explorer 可执行壳
 * @description npm `bin` 字段指向的入口。仓库无构建步骤——源码以 .ts 形式直接运行，
 *              所以这里先注册 tsx 的 ESM 加载器，再动态 import TypeScript 入口。
 *
 * 为什么需要这层壳：`bin` 目标必须是 Node 能直接执行的文件。让它指向 .ts 会
 * 依赖 shebang 里的 `npx tsx`，那在全局安装、Windows、离线环境下都不可靠。
 * 这个 .mjs 壳把加载器注册显式化，是无构建 CLI 的常规做法。
 */

import { register } from 'tsx/esm/api';

// 必须在 import 目标模块之前注册，否则 .ts 扩展名无法解析
register();

// 动态 import：register() 是运行时副作用，静态 import 会被提升到它之前
await import('../src/cli/bin.ts');

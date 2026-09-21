#!/usr/bin/env -S npx tsx
/**
 * @file dsh-remote-explorer 可执行入口
 * @description `bin` 字段指向的文件。仅负责调用 {@link run}，不含任何逻辑——
 *              这样测试可以直接 import `main()` 而不触发进程级行为。
 *
 * 仓库无构建步骤，源码以 .ts 形式直接被 tsx 执行（与插件时期的约定一致）。
 */

import { run } from './main.js';

void run();

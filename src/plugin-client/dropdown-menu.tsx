/**
 * @file 远程类型定义
 * @description 远程会话类型标识（SSH / WSL）。本文件原先还承载远程类型
 *              选择下拉菜单组件，但该组件全仓库零引用（index.tsx 只
 *              import 这里的类型），已按死代码删除；保留类型导出与文件
 *              路径不变，维持既有 import 路径零改动。
 */

/** 远程会话类型 */
export type RemoteType = 'ssh' | 'wsl';

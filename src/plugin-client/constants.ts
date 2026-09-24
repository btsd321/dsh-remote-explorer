/**
 * @file 面板共享常量
 * @description 入口层（plugin-client/）各面板共用的轮询间隔、倒计时与桌面壳标记。
 *              集中定义避免 ssh-panel / wsl-panel 各自维护同值常量。
 */

import { isDesktopShell } from './desktop-bridge.js';

/** 会话列表轮询间隔（毫秒） */
export const SESSIONS_POLL_MS = 2_000;

/** 选中会话的日志增量轮询间隔（毫秒） */
export const LOG_POLL_MS = 1_500;

/** 当前标签形态就绪后的自动导航倒计时（秒，可取消） */
export const HANDOFF_COUNTDOWN_SECONDS = 3;

/** 是否桌面壳（preload 注入先于一切脚本，页面生命周期内不变，模块级算一次） */
export const DESKTOP = isDesktopShell();

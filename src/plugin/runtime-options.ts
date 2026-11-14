/**
 * @file 运行时参数的来源合并
 * @description existing 的上次输入仅供 existing 复用；切回 auto 不暗中继承内网源。
 */
import type { DeploymentMode } from '../provision/intranet-runtime.js';

/** 入口层可覆盖的运行时路径与源。 */
interface RuntimeOverrides {
  /** 远端 Node 路径，仅 existing 消费 */
  nodePath?: string;
  /** 显式 npm 源，auto 也可主动指定 */
  npmRegistry?: string;
}

/**
 * 合并连接参数，避免持久化 existing 输入污染 auto。
 * @param mode - 已归一化的部署方式
 * @param request - 本次显式请求
 * @param saved - 面板上次 existing 输入
 * @param defaults - 插件显式默认配置
 * @returns 本次生效的运行时覆盖
 */
export function resolveRuntimeOverrides(
  mode: DeploymentMode,
  request: RuntimeOverrides,
  saved: RuntimeOverrides,
  defaults: RuntimeOverrides,
): RuntimeOverrides {
  const nodePath = mode === 'existing'
    ? request.nodePath ?? saved.nodePath ?? defaults.nodePath
    : undefined;
  const npmRegistry = request.npmRegistry
    ?? (mode === 'existing' ? saved.npmRegistry : undefined)
    ?? defaults.npmRegistry;
  return {
    ...(nodePath !== undefined ? { nodePath } : {}),
    ...(npmRegistry !== undefined ? { npmRegistry } : {}),
  };
}

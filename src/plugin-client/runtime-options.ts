/**
 * @file 连接表单运行时参数
 * @description existing 历史输入与 auto 本次显式输入分别提交。
 */
import type { DeploymentMode } from '../provision/intranet-runtime.js';

/**
 * 按当前部署方式选取表单字段，隐藏的历史输入不进入请求。
 * @param mode - 当前模式，缺省沿用 auto
 * @param nodePath - existing 的 Node 路径
 * @param existingRegistry - existing 保存的源
 * @param autoRegistry - auto 本次显式填写的源
 * @returns 连接请求中的运行时覆盖
 */
export function formRuntimeOverrides(
  mode: DeploymentMode | undefined,
  nodePath: string,
  existingRegistry: string,
  autoRegistry: string,
): { nodePath?: string; npmRegistry?: string } {
  if (mode === 'offline') return {};
  const registry = (mode === 'existing' ? existingRegistry : autoRegistry).trim();
  return {
    ...(mode === 'existing' && nodePath.trim() !== '' ? { nodePath: nodePath.trim() } : {}),
    ...(registry !== '' ? { npmRegistry: registry } : {}),
  };
}

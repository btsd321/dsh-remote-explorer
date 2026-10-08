/**
 * @file Node 版本探测自定义 Hook
 * @description 将 ssh-connect-form / wsl-panel 中逐行相同的 Node 版本探测逻辑
 *              （挂载时调 fetchNodeVersions 拉取 Node 官方发行站已发布版本列表，
 *              探测失败静默降级为空列表）提取为共享 Hook，消除重复代码。面板用
 *              返回的版本数组填充 datalist——探测失败时 datalist 为空，用户
 *              仍可手动输入任意版本号（如特定 LTS 版本或自定义版本）。
 */

import * as React from 'react';
import { fetchNodeVersions } from './api.js';

/**
 * Node 版本探测 Hook：挂载时拉取 Node 官方发行站已发布版本列表（major >= 22，
 * 按 semver 降序），探测失败静默返回空数组。
 *
 * @returns 可用版本号列表（最新在前，带 v 前缀；探测失败时为空数组）
 */
export function useNodeVersions(): string[] {
  const [versions, setVersions] = React.useState<string[]>([]);
  React.useEffect(() => {
    void (async (): Promise<void> => {
      try {
        const result = await fetchNodeVersions();
        setVersions(result.versions);
      } catch {
        // 探测失败：datalist 留空，用户仍可手动输入任意版本号
      }
    })();
  }, []);
  return versions;
}

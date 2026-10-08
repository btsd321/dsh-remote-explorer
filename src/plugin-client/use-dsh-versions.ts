/**
 * @file dsh 版本探测自定义 Hook
 * @description 将 ssh-connect-form / wsl-panel 中逐行相同的版本探测逻辑（挂载时
 *              调 fetchDshVersions 拉取 registry 已发布版本列表，探测失败静默
 *              降级为空列表）提取为共享 Hook，消除重复代码。面板用返回的版本
 *              数组填充 datalist——探测失败时 datalist 为空，用户仍可手动输入
 *              任意版本号（如 dist-tag `next` 或自定义版本）。
 */

import * as React from 'react';
import { fetchDshVersions } from './api.js';

/**
 * dsh 版本探测 Hook：挂载时拉取 registry 已发布版本列表（major.minor >= 0.2.0，
 * 按 semver 降序），探测失败静默返回空数组。
 *
 * @returns 可用版本号列表（最新在前；探测失败时为空数组）
 */
export function useDshVersions(): string[] {
  const [versions, setVersions] = React.useState<string[]>([]);
  React.useEffect(() => {
    void (async (): Promise<void> => {
      try {
        const result = await fetchDshVersions();
        setVersions(result.versions);
      } catch {
        // 探测失败：datalist 留空，用户仍可手动输入任意版本号
      }
    })();
  }, []);
  return versions;
}

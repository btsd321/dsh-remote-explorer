/**
 * @file 通用格式化工具函数
 * @description 基础层纯函数，不依赖任何上层模块。提供字节数等人类可读格式化，
 *              供 CLI 输出与引导探针共用，消除跨层重复定义。
 */

/**
 * 格式化字节数为人类可读文本。
 *
 * @param bytes - 字节数
 * @returns 如 "1.4 GB"、"512 MB"
 */
export function formatBytes(bytes: number): string {
  const gb = bytes / 1_000_000_000;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.round(bytes / 1_000_000)} MB`;
}

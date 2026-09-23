/**
 * @file 统一日志工具
 * @description 全仓库共用的结构化日志。输出格式固定为：
 *              `[时间戳] [级别] [模块] 内容`
 *
 *              设计目标：
 *              - 替代散落的 console.log/info/warn/error，统一为 info/warn/error
 *                三种标准级别（supervisor 的阶段进度已归入 info）
 *              - 后端（Node）与浏览器端共用同一套 API，输出格式一致
 *              - 模块标签让多模块并发日志可区分来源
 *              - 级别语义明确：debug < info < warn < error
 *
 * 使用示例：
 * ```typescript
 * import { createLogger } from '../util/logger.js';
 * const log = createLogger('wsl-transport');
 * log.info('连接成功', { platform: 'linux/x64' });
 * // → [2025-01-15T07:02:03.456Z] [INFO] [wsl-transport] 连接成功 {"platform":"linux/x64"}
 * ```
 *
 * 分层约束：本文件属基础层，不依赖任何上层模块。
 */

/** 日志级别 */
export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

/** 日志级别对应的 console 方法 */
const LEVEL_METHODS: Record<LogLevel, 'debug' | 'info' | 'warn' | 'error'> = {
  DEBUG: 'debug',
  INFO: 'info',
  WARN: 'warn',
  ERROR: 'error',
};

/** 格式化当前时间为 ISO 8601（毫秒精度） */
function formatTimestamp(): string {
  return new Date().toISOString();
}

/**
 * 格式化一条日志消息。
 *
 * @param level - 日志级别
 * @param module - 模块标签
 * @param message - 主消息
 * @param data - 附加数据（可选，序列化为 JSON）
 * @returns 格式化后的字符串
 */
function formatMessage(
  level: LogLevel,
  module: string,
  message: string,
  data?: unknown,
): string {
  const ts = formatTimestamp();
  const base = `[${ts}] [${level}] [${module}] ${message}`;
  if (data === undefined) return base;
  try {
    return `${base} ${JSON.stringify(data)}`;
  } catch {
    return `${base} [数据序列化失败]`;
  }
}

/** 日志器接口 */
export interface Logger {
  /** 调试级别：开发排查用，生产环境可静默 */
  debug(message: string, data?: unknown): void;
  /** 信息级别：关键流程节点、状态变更 */
  info(message: string, data?: unknown): void;
  /** 警告级别：可恢复的异常、降级、兼容性问题 */
  warn(message: string, data?: unknown): void;
  /** 错误级别：不可恢复的失败、异常捕获 */
  error(message: string, data?: unknown): void;
}

/**
 * 创建一个带模块标签的日志器。
 *
 * 所有输出经 console 对应方法打印，格式统一为：
 * `[时间戳] [级别] [模块] 内容 [附加数据JSON]`
 *
 * @param module - 模块标签（如 'session-manager'、'wsl-panel'、'supervisor'）
 * @returns 日志器实例
 */
export function createLogger(module: string): Logger {
  return {
    debug(message: string, data?: unknown): void {
      const text = formatMessage('DEBUG', module, message, data);
      // eslint-disable-next-line no-console
      console.debug(text);
    },
    info(message: string, data?: unknown): void {
      const text = formatMessage('INFO', module, message, data);
      // eslint-disable-next-line no-console
      console.info(text);
    },
    warn(message: string, data?: unknown): void {
      const text = formatMessage('WARN', module, message, data);
      // eslint-disable-next-line no-console
      console.warn(text);
    },
    error(message: string, data?: unknown): void {
      const text = formatMessage('ERROR', module, message, data);
      // eslint-disable-next-line no-console
      console.error(text);
    },
  };
}

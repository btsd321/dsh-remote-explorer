/**
 * @file CLI 输出格式化
 * @description 终端输出的统一出口：表格、分阶段进度、错误呈现。
 *
 * 设计取舍：不引入任何终端美化依赖。颜色用最小的 ANSI 转义，且在检测到
 * 非 TTY 或设置了 `NO_COLOR` 时自动关闭——CI 与重定向到文件的场景下
 * 转义序列只会污染输出。
 *
 * 分层约束：本文件只负责呈现，不含任何业务判断。
 */

/** 是否启用颜色：非 TTY、设了 NO_COLOR、或显式 TERM=dumb 时关闭 */
const useColor = process.stdout.isTTY === true
  && process.env.NO_COLOR === undefined
  && process.env.TERM !== 'dumb';

/** ANSI 颜色代码 */
const CODES = {
  reset: '\u001B[0m',
  dim: '\u001B[2m',
  bold: '\u001B[1m',
  red: '\u001B[31m',
  green: '\u001B[32m',
  yellow: '\u001B[33m',
  cyan: '\u001B[36m',
} as const;

/**
 * 给文本套上颜色（颜色关闭时原样返回）。
 *
 * @param text - 原文
 * @param code - CODES 中的键名
 * @returns 带转义或原文
 */
function paint(text: string, code: keyof typeof CODES): string {
  if (!useColor) return text;
  return `${CODES[code]}${text}${CODES.reset}`;
}

/** 弱化文本（次要信息） */
export const dim = (text: string): string => paint(text, 'dim');
/** 强调文本 */
export const bold = (text: string): string => paint(text, 'bold');
/** 成功色 */
export const green = (text: string): string => paint(text, 'green');
/** 警告色 */
export const yellow = (text: string): string => paint(text, 'yellow');
/** 错误色 */
export const red = (text: string): string => paint(text, 'red');
/** 提示色 */
export const cyan = (text: string): string => paint(text, 'cyan');

/**
 * 打印一行到标准输出。
 *
 * @param line - 文本；省略则打印空行
 */
export function println(line = ''): void {
  process.stdout.write(`${line}\n`);
}

/**
 * 打印一行到标准错误。
 *
 * @param line - 文本
 */
export function printErr(line: string): void {
  process.stderr.write(`${line}\n`);
}

/**
 * 计算字符串的终端显示宽度。
 *
 * 中文字符占两列，否则表格对不齐。范围覆盖 CJK 统一表意文字、全角标点、
 * 假名与全角字母数字——够用即止，不引入 `string-width` 这类依赖。
 *
 * @param text - 文本（应先剥除 ANSI 转义）
 * @returns 显示宽度
 */
export function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    const isWide =
      (code >= 0x1100 && code <= 0x115F) ||
      (code >= 0x2E80 && code <= 0xA4CF) ||
      (code >= 0xAC00 && code <= 0xD7A3) ||
      (code >= 0xF900 && code <= 0xFAFF) ||
      (code >= 0xFE30 && code <= 0xFE6F) ||
      (code >= 0xFF00 && code <= 0xFF60) ||
      (code >= 0xFFE0 && code <= 0xFFE6) ||
      (code >= 0x20000 && code <= 0x3FFFD);
    width += isWide ? 2 : 1;
  }
  return width;
}

/** 剥除 ANSI 转义序列，用于宽度计算 */
const ANSI_PATTERN = /\u001B\[[0-9;]*m/g;

/**
 * 按显示宽度右侧补空格。
 *
 * @param text - 文本（可含 ANSI 转义）
 * @param width - 目标显示宽度
 * @returns 补齐后的文本
 */
function padEndWide(text: string, width: number): string {
  const actual = displayWidth(text.replaceAll(ANSI_PATTERN, ''));
  return text + ' '.repeat(Math.max(0, width - actual));
}

/**
 * 打印一张简单表格。
 *
 * 表头与数据列按显示宽度对齐，中文列不会错位。
 *
 * @param headers - 表头
 * @param rows - 数据行；每行列数应与表头一致
 */
export function printTable(headers: readonly string[], rows: readonly (readonly string[])[]): void {
  if (rows.length === 0) return;
  const widths = headers.map((header, index) => {
    const cells = rows.map(row => displayWidth((row[index] ?? '').replaceAll(ANSI_PATTERN, '')));
    return Math.max(displayWidth(header), ...cells);
  });

  println(headers.map((header, i) => padEndWide(bold(header), widths[i]!)).join('  '));
  println(dim(widths.map(width => '─'.repeat(width)).join('──')));
  for (const row of rows) {
    println(row.map((cell, i) => padEndWide(cell, widths[i]!)).join('  '));
  }
}

/**
 * 分阶段进度报告器。
 *
 * 引导过程较长（P0 实测装 Node + dsh 约 75 秒），必须让用户看到在动，
 * 并打印每阶段实测耗时——否则无法判断是慢还是卡死。
 */
export class ProgressReporter {
  private startedAt: number | undefined;
  private label = '';

  /**
   * 开始一个阶段。
   *
   * @param label - 阶段名
   */
  start(label: string): void {
    this.finishPending();
    this.label = label;
    this.startedAt = Date.now();
    process.stdout.write(`${cyan('▸')} ${label}…`);
  }

  /**
   * 结束当前阶段并打印耗时。
   *
   * @param detail - 补充说明（如"490 个包"）
   */
  done(detail?: string): void {
    if (this.startedAt === undefined) return;
    const seconds = ((Date.now() - this.startedAt) / 1000).toFixed(1);
    const suffix = detail ? ` ${dim(`(${detail})`)}` : '';
    process.stdout.write(`\r${green('✓')} ${this.label} ${dim(`${seconds}s`)}${suffix}\n`);
    this.startedAt = undefined;
  }

  /**
   * 以跳过状态结束当前阶段。
   *
   * @param reason - 跳过原因
   */
  skip(reason: string): void {
    if (this.startedAt === undefined) return;
    process.stdout.write(`\r${dim('·')} ${this.label} ${dim(`已跳过：${reason}`)}\n`);
    this.startedAt = undefined;
  }

  /**
   * 以失败状态结束当前阶段。
   *
   * @param message - 失败摘要
   */
  fail(message: string): void {
    if (this.startedAt === undefined) return;
    process.stdout.write(`\r${red('✗')} ${this.label} ${red(message)}\n`);
    this.startedAt = undefined;
  }

  /** 若有未结束的阶段，补一个换行避免输出粘连 */
  private finishPending(): void {
    if (this.startedAt !== undefined) process.stdout.write('\n');
    this.startedAt = undefined;
  }
}

/**
 * @file POSIX shell 参数转义
 * @description 构造远端命令时把用户提供的值（路径、URL、版本号）安全地嵌入 shell 命令。
 *
 * 安全约束：
 * - 远端命令是拼接成字符串交给 `ssh2` 的 `exec` 执行的，等价于交给远端 shell
 * - 任何来自 SSH config、CLI 参数、镜像列表的值都必须经过 {@link quote}
 * - 不要用模板字符串直接插值，那等于命令注入
 */

/**
 * 用单引号包裹并转义，生成 POSIX shell 的字面量参数。
 *
 * 做法是业界通用的单引号法：单引号内除 `'` 外一切字符都是字面量，
 * 遇到 `'` 就闭合引号、插入转义的 `\'`、再重新开引号。
 *
 * @param value - 原始值
 * @returns 可直接拼进 shell 命令的字面量
 */
export function quote(value: string): string {
  if (value.length === 0) return "''";
  // 仅含安全字符时无需引号，保持命令可读
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * 转义并用空格连接多个参数。
 *
 * @param parts - 参数列表，第一项通常是命令名
 * @returns 拼接好的命令字符串
 */
export function quoteAll(parts: readonly string[]): string {
  return parts.map(quote).join(' ');
}

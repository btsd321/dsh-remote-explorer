/**
 * @file 交互式密码输入
 * @description 无 IdentityFile 主机的密码认证支撑：不回显的终端提示、
 *              带每主机缓存的密码提供器（交互式与固定值两种模式）。
 *
 * 安全约束：
 * - 密码只存本进程内存——不落盘、不进日志与错误消息（仓库凭据底线）
 * - JS 字符串不可变、无法清零，clear() 只能丢弃引用交由 GC 回收（已知限制，
 *   不假装安全；不采用 Buffer 清零方案——ssh2 的 PasswordAuthMethod 只接受 string）
 *
 * 分层约束：本文件属基础层，不感知连接状态；被 cli/session 注入给传输层。
 */

import * as readline from 'node:readline';
import { Writable } from 'node:stream';
import { RemoteError } from './errors.js';

/**
 * 判断是否连着交互式终端。
 *
 * stdin 与 stdout 都必须是 TTY：前者才能进原始模式收按键，后者保证提示可见。
 * 管道/CI 场景返回 false，调用方据此走「缺 IdentityFile」的报错而非挂死等输入。
 */
export function isInteractiveTerminal(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

/**
 * 提示用户输入一行密码（不回显、不 trim）。
 *
 * 回显抑制：readline 会把用户输入回显到 output——给它一个只吞字节的
 * Writable，终端上什么都看不到。这是 Node 内置方案，cmd/PowerShell/
 * Git Bash/VSCode 集成终端通用，不新增依赖。
 *
 * @param promptText - 提示文案（写到 stderr，避开 stdout 上进度报告器的单行）
 * @returns 用户输入的密码
 * @throws RemoteError('ABORTED') Ctrl-C / Ctrl-D / 空输入 / 非 TTY
 */
async function promptPassword(promptText: string): Promise<string> {
  if (!isInteractiveTerminal()) {
    throw new RemoteError('ABORTED', '当前不是交互式终端，无法提示输入密码');
  }

  const muted = new Writable({
    write(_chunk, _encoding, callback: (error?: Error | null) => void): void {
      callback();
    },
  });
  const rl = readline.createInterface({
    input: process.stdin,
    output: muted,
    // 原始模式：Ctrl-C/Ctrl-D 由 readline 转成事件而不是终止进程
    terminal: true,
  });

  try {
    // 先补换行：stdout 可能挂着进度报告器未结束的单行；提示走 stderr
    process.stderr.write(`\n${promptText}`);
    return await new Promise<string>((resolve, reject) => {
      let settled = false;
      const fail = (message: string): void => {
        if (settled) return;
        settled = true;
        reject(new RemoteError('ABORTED', message));
      };
      rl.once('SIGINT', () => fail('密码输入被中断（Ctrl-C）'));
      rl.once('close', () => fail('密码输入被中断（Ctrl-D 或输入流关闭）'));
      rl.question('', (answer) => {
        if (settled) return;
        settled = true;
        // 空输入视为取消：sshd 默认不接受空密码（PermitEmptyPasswords no）
        if (answer.length === 0) fail('密码为空，已取消');
        else resolve(answer);
      });
    });
  } finally {
    // 回车键没有回显，手动补换行；close 退出原始模式，恢复终端状态
    process.stderr.write('\n');
    rl.close();
  }
}

/**
 * 自定义密码提示回调。
 *
 * 供无终端的宿主（如 dsh 插件形态：密码来自面板表单或宿主自己的 UI）
 * 注入取密途径。语义与内置终端提示一致：返回 undefined 表示放弃认证。
 *
 * @param hostKey - 主机标识（"user@host:port"，由传输层构造）
 * @param label - 定位标签（「主机 xxx」/「跳板机 1（host:port）」）
 * @param attempt - 第几次尝试，从 1 起；> 1 表示上一份密码已被拒绝
 * @returns 密码；undefined 表示放弃
 */
export type PasswordPromptFn = (
  hostKey: string,
  label: string,
  attempt: number,
) => Promise<string | undefined>;

/** PasswordProvider 的构造选项 */
export interface PasswordProviderOptions {
  /** 固定密码（--password 传入）：只用这一份，被拒后不重试、不提示 */
  fixed?: string;
  /**
   * 自定义提示回调：替代内置的终端 readline 提示。
   * 优先级 fixed > prompt > 内置终端提示；缓存语义（get 缓存、peek 只读）不变
   */
  prompt?: PasswordPromptFn;
}

/**
 * 密码提供器：带每主机缓存。
 *
 * 两种模式：
 * - 交互式（默认）：`get` 首次弹提示并缓存，被拒后弃缓存重新提示；
 *   `peek` 只读缓存，供重连等无人值守场景——绝不弹提示，没人会回应。
 * - 固定值（--password）：attempt 1 返回该值，attempt > 1 返回 undefined
 *   （重新提示无意义，重试只会白白消耗服务器的 MaxAuthTries 配额）。
 *
 * 注入 `prompt` 回调时替代内置终端提示（dsh 插件形态没有终端可提示），
 * 缓存与重试语义与交互式模式完全一致。
 */
export class PasswordProvider {
  private readonly cache = new Map<string, string>();
  private readonly fixed: string | undefined;
  private readonly promptFn: PasswordPromptFn | undefined;

  /**
   * @param options - 传 fixed 时进入固定值模式；传 prompt 时替换提示途径
   */
  constructor(options?: PasswordProviderOptions) {
    this.fixed = options?.fixed;
    this.promptFn = options?.prompt;
  }

  /**
   * 交互式取密码；attempt > 1 表示上一份被服务器拒绝，弃缓存重新提示。
   *
   * @param hostKey - 主机标识（"user@host:port"，由传输层构造）
   * @param label - 提示文案中的定位标签（「主机 xxx」/「跳板机 1（host:port）」）
   * @param attempt - 第几次尝试，从 1 起
   * @returns 密码；用户取消或固定值被拒后返回 undefined（放弃认证）
   */
  async get(hostKey: string, label: string, attempt: number): Promise<string | undefined> {
    if (this.fixed !== undefined) {
      return attempt === 1 ? this.fixed : undefined;
    }
    if (attempt > 1) this.cache.delete(hostKey);
    const cached = this.cache.get(hostKey);
    if (cached !== undefined) return cached;
    const hint = attempt > 1 ? `（第 ${attempt} 次尝试；上一次密码被拒绝）` : '';
    try {
      // 注入了自定义提示（插件形态）走注入途径；否则走内置终端 readline
      const password = this.promptFn !== undefined
        ? await this.promptFn(hostKey, label, attempt)
        : await promptPassword(`${label} 的登录密码${hint}：`);
      if (password === undefined) return undefined;
      this.cache.set(hostKey, password);
      return password;
    } catch {
      /* Ctrl-C / 空输入 / 非 TTY / 注入回调失败：放弃认证，让传输层报「已取消」 */
      return undefined;
    }
  }

  /**
   * 静默取密码（重连用）：只用缓存，绝不弹提示。
   *
   * @param hostKey - 主机标识
   * @param label - 定位标签（错误场景占位，不用于提示）
   * @param attempt - 第几次尝试，从 1 起
   * @returns 缓存的密码；无缓存或已用尽时返回 undefined
   */
  peek(hostKey: string, _label: string, attempt: number): string | undefined {
    if (this.fixed !== undefined) {
      return attempt === 1 ? this.fixed : undefined;
    }
    if (attempt > 1) this.cache.delete(hostKey);
    return this.cache.get(hostKey);
  }

  /** 丢弃全部缓存引用（会话关闭时调用；无法清零字符串，只能靠 GC） */
  clear(): void {
    this.cache.clear();
  }
}

/**
 * @file 系统提示词段
 * @description 有活跃远程会话时向系统提示词追加一段「当前会话」上下文，
 *              让模型知道自己正维持着哪些远端 dsh、该怎么查与怎么断。
 *              没有活跃会话时返回空串——空段不污染提示词。
 *
 * order 取 100（靠后追加）：这段是运行时状态，不该盖过 dsh 自身的核心指令。
 */

import type { Context } from '@deepseek-ai/cordis';
// 激活 ctx.systemPrompt 的类型增广
import type {} from '@deepseek-ai/dsh-system-prompt';
import type { SessionSupervisor } from './supervisor.js';

/** 提示词段名（重名注册会抛错，全 dsh 唯一） */
const SECTION_NAME = 'dsh-remote-explorer';

/** 段顺序：靠后追加，不干扰核心指令 */
const SECTION_ORDER = 100;

/**
 * 注册系统提示词段。
 *
 * @param ctx - 插件上下文
 * @param supervisor - 会话监督器
 * @returns 清理函数
 */
export function registerPromptSection(ctx: Context, supervisor: SessionSupervisor): () => void {
  return ctx.systemPrompt.section({
    name: SECTION_NAME,
    order: SECTION_ORDER,
    text: () => {
      // 只列活跃的（连接中与已连接）；断开/失败的历史记录不进提示词
      const active = supervisor.list().filter(snapshot =>
        snapshot.connecting || snapshot.state.tag === 'connected'
        || snapshot.state.tag === 'heartbeat-missed' || snapshot.state.tag === 'reconnecting');
      if (active.length === 0) return '';
      const lines = active.map((snapshot) => {
        const state = snapshot.connecting ? '连接中' : snapshot.state.tag;
        const target = `${snapshot.hostAlias}:${snapshot.remoteCwd === '' ? '~' : snapshot.remoteCwd}`;
        const url = snapshot.url !== undefined ? `，浏览器地址 ${snapshot.url}` : '';
        return `- ${target}（${state}，会话 ${snapshot.sessionId.slice(0, 12)}…${url}）`;
      });
      return '## 远程 SSH 会话\n本进程维持的远端 dsh 会话：\n'
        + `${lines.join('\n')}\n`
        + '用 remote_status 查进度、remote_kill 断开；url 是隧道转发后的远端 dsh 界面，用户浏览器可直接打开。';
    },
  });
}

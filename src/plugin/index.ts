/**
 * @file dsh 插件宿主半入口
 * @module
 * @description 以 cordis 插件形态挂进 dsh profile（web/headless 组合均可）：
 *              slash 命令、agent 工具、后台会话编排与面板 /api 路由的注册点。
 *              经 scripts/build-plugin.ts 打包为 lib/index.cjs（CJS）后由 dsh 的
 *              loader 加载——loader 的 unwrapExports 显式兼容 esbuild CJS 产物。
 *
 * 分层纪律：本文件是插件适配层（等同入口层），只准 import session/provision/
 * tunnel/credential/transport/hosts/util 等下层与 ./ 同层模块，**绝不 import cli/**
 * ——终端输出与交互属于 CLI 入口层，插件有自己的呈现通道（回调 → 日志缓冲 → 面板）。
 *
 * cordis 插件契约（全部源码核实）：
 * - `inject` 里的服务全部就绪后 apply 才被调用；可选服务（commands/connection）
 *   一律用 `ctx.get()`（返回 undefined 不抛错）或 `ctx.inject()` 反应式获取，
 *   绝不能属性直取——宿主组合缺该服务时会直接抛错
 * - 一切注册走 `ctx.effect()`，返回清理函数；fiber 卸载时按注册逆序执行
 *
 * 生命周期语义（用户拍板）：宿主进程 dispose 时默认连远端 dsh 一起停
 * （keepRemoteOnDispose 可配置保留）——隧道与凭据代理随宿主消亡，远端留着
 * 也只是不可用的僵尸进程，停掉最干净。
 */

import type { Context } from '@deepseek-ai/cordis';
import { Config, type PluginConfig } from './config.js';
import { SessionSupervisor } from './supervisor.js';
import { registerCommands } from './commands.js';
import { registerTools } from './tools.js';
import { registerPromptSection } from './prompt.js';
import { registerPanelRoutes } from './routes.js';

/** 插件名（cordis 显示名与 logger 名；与 cordis.patch.yml 的 entry id 一致） */
export const name = 'dsh-remote-explorer';

/**
 * 硬依赖服务。tools 与 systemPrompt 都在 dsh 的 base bundle 里，
 * web/headless 任何组合必有；其余（commands/connection）全部防御性获取。
 */
export const inject = ['tools', 'systemPrompt'];

export { Config };
export type { PluginConfig };

/**
 * 插件激活入口。
 *
 * @param ctx - cordis 上下文（宿主 dsh 进程内，无沙箱）
 * @param config - 经 Config schema 校验归一后的配置
 */
export function apply(ctx: Context, config: PluginConfig): void {
  const logger = ctx.logger(name);
  logger.info(`插件已加载（panel=${config.panel ? '开' : '关'}）`);

  // 会话监督器：命令、工具、面板路由三个消费面共享同一份簿记
  const supervisor = new SessionSupervisor({
    cwd: config.cwd,
    localPort: config.localPort,
    nodeVersion: config.nodeVersion,
    dshVersion: config.dshVersion,
    forceRestart: config.forceRestart,
    refreshMirrors: config.refreshMirrors,
  });

  // 注册面（全部走 effect，fiber 卸载时逆序清理）
  ctx.effect(() => registerPromptSection(ctx, supervisor), 'dsh-remote-explorer.prompt');
  ctx.effect(() => registerCommands(ctx, supervisor), 'dsh-remote-explorer.commands');
  ctx.effect(() => registerTools(ctx, supervisor), 'dsh-remote-explorer.tools');
  if (config.panel) {
    registerPanelRoutes(ctx, supervisor);
  }

  // 生命周期终点：宿主进程优雅退出/插件卸载时关闭全部会话。
  // 默认连远端一起停（对齐 CLI Ctrl-C 语义）；keepRemoteOnDispose 保留远端。
  // SIGKILL 没有 dispose 可言——远端进程 detach 存活，陈旧登记由会话表的
  // pid 存活过滤自动清理，用户可用 CLI kill 兜底（文档写明）
  ctx.effect(() => async () => {
    const stopRemote = config.keepRemoteOnDispose !== true;
    logger.info(`插件卸载，关闭全部会话（stopRemote=${stopRemote}）`);
    await supervisor.disposeAll(stopRemote);
  }, 'dsh-remote-explorer.dispose');
}

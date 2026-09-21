/**
 * @file 插件 Config schema
 * @description dsh 插件宿主半的配置声明。用户在 profile 的 cordis.patch.yml 里
 *              按 entry id（dsh-remote-explorer）写 `config:` 块即可覆盖默认值。
 *
 * 硬约束（都是实测/源码核实过的坑）：
 * - Config 必须用 @deepseek-ai/schemastery——zod schema 会被 loader 拒绝，
 *   未声明的 row config 直接导致加载失败
 * - schemastery 3.18 没有 .enum()/.optional() API：全部字段给 .default()，
 *   枚举语义（如版本号格式）由消费方代码校验
 * - **绝不设 password 字段**：Config 会随 patch 层落盘在 profile 目录里，
 *   密码进 Config 等于明文写进磁盘，违反本仓库的凭据纪律
 */

import z from '@deepseek-ai/schemastery';

/**
 * 插件配置 schema。
 *
 * 类型经 `Schemastery.TypeT` 从 schema 推导（schemastery 的全局命名空间类型），
 * 不手写第二份接口——schema 即唯一真源。
 */
export const Config = z.object({
  /** 默认主机别名（命令/面板未指定时用）；空串 = 不预选 */
  host: z.string().default('').description('默认 SSH 主机别名或 user@host[:port]'),
  /** 默认远端工作目录（POSIX 绝对路径）；空串 = 远端家目录 */
  cwd: z.string().default('').description('默认远端工作目录（POSIX 绝对路径，空 = 家目录）'),
  /** 宿主进程 dispose 时是否保留远端 dsh 进程；默认 false = 连远端一起停 */
  keepRemoteOnDispose: z.boolean().default(false)
    .description('宿主退出时保留远端 dsh 进程（默认一起停止）'),
  /** 本机转发端口；0 = 由操作系统分配（推荐） */
  localPort: z.natural().max(65535).default(0)
    .description('本机转发端口（0 = 自动分配）'),
  /** 远端 Node 版本（含 v 前缀）；空串 = 用 provisioner 默认 */
  nodeVersion: z.string().default('').description('远端 Node 版本（空 = 默认）'),
  /** 远端 dsh 版本或 dist-tag；空串 = 用 provisioner 默认 */
  dshVersion: z.string().default('').description('远端 dsh 版本（空 = 默认）'),
  /** 复用探测到既有会话时是否强制重启远端进程 */
  forceRestart: z.boolean().default(false).description('连接时强制重启远端 dsh'),
  /** 引导时是否强制重新测速镜像 */
  refreshMirrors: z.boolean().default(false).description('引导时重新测速镜像源'),
  /** 是否注册 Web 管理面板的 /api 路由；false 时只剩命令与工具 */
  panel: z.boolean().default(true).description('启用 Web 管理面板路由'),
});

/** 校验归一后的插件配置类型（全部字段必有值，取自 schema 的 default） */
export type PluginConfig = Schemastery.TypeT<typeof Config>;

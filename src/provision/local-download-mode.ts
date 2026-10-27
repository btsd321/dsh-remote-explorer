/**
 * @file 本地资源下载模式（local_resource_download）共享类型
 * @description 远端无网络时借本机网络完成下载的模式选择，类似 VS Code 的
 *              Remote.SSH: Local Server Download。三值枚举：
 *
 * - `auto`（默认）：先探测远端网络可达性，不可达才建代理隧道
 * - `always`：直接建代理隧道，跳过探测
 * - `off`：远端直连下载（远端无网时失败——恢复原行为）
 *
 * 「借本机网络」的实现是代理隧道（本机 HTTP CONNECT 代理 + SSH 反向转发，
 * 见 provision/provision-proxy-tunnel.ts），不是把资源包下载后上传——远端
 * 的 curl/npm install 命令本身不变，只是出站流量改经隧道回本机。
 *
 * 分层约束：本文件属能力层（provision/），零依赖纯类型模块，可被入口层
 * （plugin/、cli/）、编排层（session/）安全引用——它们都向下依赖能力层。
 * 独立成模块而非内联在 advanced-store，是因为 provision 层的编排器与 installer
 * 也直接消费此类型，放在 advanced-store 会让 provision 反向依赖 plugin/ 层
 * （违反单向依赖）。
 *
 * 适用范围：**仅 SSH 传输**。WSL 有本地文件系统访问（UNC 路径），不需要
 * 此选项（与 proxy/jumpHosts 同样的域约束——advanced-store 的 WSL 域不含）。
 */

/**
 * 本地资源下载模式。
 *
 * @see {@link DEFAULT_LOCAL_RESOURCE_DOWNLOAD} 默认值
 */
export type LocalResourceDownloadMode = 'auto' | 'always' | 'off';

/** 默认模式：先探测远端网络，不可达才建代理隧道（与 VS Code 默认语义一致） */
export const DEFAULT_LOCAL_RESOURCE_DOWNLOAD: LocalResourceDownloadMode = 'auto';

/** 全部合法模式值（校验与 UI 下拉框共用单一数据源） */
export const LOCAL_RESOURCE_DOWNLOAD_MODES: readonly LocalResourceDownloadMode[] = ['auto', 'always', 'off'];

/**
 * 校验一个值是否为合法的本地资源下载模式。
 *
 * 来自外部 JSON（手工编辑的配置文件、HTTP 请求体）的值类型不可信，消费前
 * 必须过此函数——非法值由调用方决定降级策略（通常回落默认值并告警）。
 *
 * @param value - 待校验值（unknown）
 * @returns 合法模式值；非法时 undefined
 */
export function isValidLocalResourceDownloadMode(value: unknown): value is LocalResourceDownloadMode {
  return typeof value === 'string'
    && (LOCAL_RESOURCE_DOWNLOAD_MODES as readonly string[]).includes(value);
}

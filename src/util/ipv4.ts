/**
 * @file IPv4 地址校验
 * @description 严格 IPv4 点分判据的唯一权威实现。反向端点 host 的两个既有
 *              使用方（transport/wsl-network 的探测端点校验、credential/
 *              proxy-secret 的材料读写校验）原先各持一份相同实现——判据
 *              变更时容易漏改一处，收口到基础层供全员依赖。
 *
 * 分层约束：本文件属基础层（util/），不 import 任何上层模块。
 */

/** 严格 IPv4 判据（每段 0–255，无前导零） */
const IPV4_PATTERN = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/**
 * 校验字符串是否为合法 IPv4 点分形式（严格判据：每段 0–255、无前导零）。
 *
 * 反向端点 host 会拼进远端命令与 YAML 的 baseURL，只接受无 shell/YAML
 * 元字符可能的形态；值常来自跨进程边界的外部数据（`ip route` 输出、
 * 远端落盘材料），不能默认可信，各使用方在此统一收口。
 *
 * @param text - 待校验文本
 * @returns 是否为合法 IPv4
 */
export function isValidIpv4(text: string): boolean {
  return IPV4_PATTERN.test(text);
}

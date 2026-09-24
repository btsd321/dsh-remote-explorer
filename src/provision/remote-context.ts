/**
 * @file 远端执行上下文
 * @description 封装 RemoteTransport 与 RemotePaths 的绑定关系，
 *              消除 (transport, paths) 参数对在多处函数签名中的重复。
 */
import type { RemoteTransport } from '../transport/types.js';
import type { RemotePaths } from './remote-paths.js';

/** 远端执行上下文：传输实例与路径信息的绑定 */
export interface RemoteContext {
  readonly transport: RemoteTransport;
  readonly paths: RemotePaths;
}

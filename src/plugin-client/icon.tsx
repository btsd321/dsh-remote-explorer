/**
 * @file 左导航「远程会话」按钮图标
 * @description panellist 槽的注册组件即图标本体：sidebar 壳只传
 *              `{ size, active }`（按钮/label/选中态全归壳），颜色一律
 *              `currentColor` 跟随壳的主题与选中态，尺寸随 `size` 缩放。
 *
 *              不依赖 dsh-client-ui-primitives 的图标包——fixture-live-client
 *              先例证明普通内联 SVG 组件同样合法，也避免多一个 peer。
 *
 *              图形意象：两台堆叠的服务器机箱 + 状态灯（远程主机群）。
 */

import * as React from 'react';
import type { ReactNode } from 'react';

/** sidebar 壳传给图标组件的 props（ui-sidebar 的 owner 契约） */
export interface PanelIconProps {
  /** 请求的方形边长（宽栏 16 / rail 18） */
  size: number;
  /** 当前面板是否选中（壳已用颜色表达，图标本身无需分支） */
  active: boolean;
}

/**
 * 远程会话面板的导航图标。
 *
 * @param props - 壳注入的尺寸与选中态
 * @returns 内联 SVG
 */
export function RemoteSessionsIcon({ size }: PanelIconProps): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {/* 上层机箱 */}
      <rect x="2.5" y="2.5" width="11" height="4.5" rx="1" />
      <circle cx="5" cy="4.75" r="0.4" fill="currentColor" stroke="none" />
      <path d="M8 4.75h3.5" />
      {/* 下层机箱 */}
      <rect x="2.5" y="9" width="11" height="4.5" rx="1" />
      <circle cx="5" cy="11.25" r="0.4" fill="currentColor" stroke="none" />
      <path d="M8 11.25h3.5" />
    </svg>
  );
}

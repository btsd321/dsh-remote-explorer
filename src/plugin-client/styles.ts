/**
 * @file 面板共享内联样式
 * @description 入口层（plugin-client/）各面板共用的 inputStyle / buttonStyle。
 *              样式纪律：不猜 dsh 设计令牌名——中性色一律 inherit/rgba 半透明灰，
 *              仅状态点用语义色；深浅主题都成立。
 */

import type { CSSProperties } from 'react';

/** 文本输入框基础样式（背景透明、边框半透明灰、圆角 6px） */
export const inputStyle: CSSProperties = {
  background: 'transparent',
  color: 'inherit',
  border: '1px solid rgba(127,127,127,0.4)',
  borderRadius: 6,
  padding: '4px 8px',
  minWidth: 0,
};

/** 按钮基础样式（背景透明、边框半透明灰、圆角 6px、指针光标） */
export const buttonStyle: CSSProperties = {
  background: 'transparent',
  color: 'inherit',
  border: '1px solid rgba(127,127,127,0.5)',
  borderRadius: 6,
  padding: '4px 12px',
  cursor: 'pointer',
};

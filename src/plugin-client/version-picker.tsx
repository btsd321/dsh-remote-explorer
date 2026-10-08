/**
 * @file 版本选择 combobox
 * @description 替代原生 datalist 的版本选择组件。datalist 的下拉弹窗行为
 *              不可控——部分浏览器/WebView 不支持鼠标滚轮滚动，列表过长时
 *              无侧边滚动条。本组件用自定义浮层替代，保证鼠标滚轮可滚动、
 *              超过最大高度时显示侧边滚动条。
 *
 *              与 host-picker 同款交互：聚焦打开完整列表、输入过滤辅助定位、
 *              点击外部/Esc 关闭、选择项填入并关闭。保留自由输入能力——
 *              用户可输入探测列表之外的版本号（如 dist-tag `next` 或自定义版本）。
 *
 * 样式纪律：中性色 inherit/rgba 半透明灰，浮层背景用 host-picker 同款
 * `var(--dsw-alias-bg-base, #1e1e22)`，不猜其他设计令牌名。
 */

import * as React from 'react';
import type { ReactNode } from 'react';
import { inputStyle } from './styles.js';

/** 浮层最大高度（超出滚动；版本数多时不下撑表单） */
const DROPDOWN_MAX_HEIGHT = 240;

/** combobox props */
export interface VersionPickerProps {
  /** 当前输入值（受控；可能是列表中的版本号或用户自由输入的值） */
  value: string;
  /** 值变化（浮层选择或自由输入都走这里） */
  onChange: (value: string) => void;
  /** 可选版本列表（已排序，最新在前） */
  versions: readonly string[];
  /** 输入框占位提示 */
  placeholder?: string;
}

/**
 * 版本选择 combobox。
 *
 * 点开浮层显示全部版本列表（鼠标滚轮可滚动、超出 maxHeight 显示侧边
 * 滚动条）；用户主动输入时按子串过滤辅助定位，也可自由输入任意值。
 *
 * @param props - 受控值、变更回调、版本列表、占位提示
 * @returns 输入框 + 条件渲染的浮层
 */
export function VersionPicker(props: VersionPickerProps): ReactNode {
  const { value, onChange, versions, placeholder } = props;
  const [open, setOpen] = React.useState(false);
  const rootRef = React.useRef<HTMLDivElement | null>(null);

  // 点击浮层外部关闭：mousedown 判 rootRef 包含性。成对清理监听器
  React.useEffect(() => {
    if (!open) return undefined;
    const onDocMouseDown = (event: MouseEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => { document.removeEventListener('mousedown', onDocMouseDown); };
  }, [open]);

  // 输入过滤：只在用户主动输入后（值非空）收窄；清空即回到全部
  const filter = value.trim().toLowerCase();
  const visible = filter === ''
    ? versions
    : versions.filter(v => v.toLowerCase().includes(filter));

  return (
    <div ref={rootRef} style={{ position: 'relative' }}>
      <input
        value={value}
        placeholder={placeholder}
        // boxSizing 必须：width:100% 在默认 content-box 下会把 padding 与边框溢出
        style={{ ...inputStyle, width: '100%', boxSizing: 'border-box' }}
        onChange={event => onChange(event.target.value)}
        // 聚焦全选 + 打开完整列表：残留值可一键输入整体覆盖
        onFocus={event => { event.target.select(); setOpen(true); }}
        onKeyDown={event => { if (event.key === 'Escape') setOpen(false); }}
      />
      {open && visible.length > 0
        ? (
          <div role="listbox" style={{
            position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 1000,
            marginTop: 2, maxHeight: DROPDOWN_MAX_HEIGHT, overflowY: 'auto',
            background: 'var(--dsw-alias-bg-base, #1e1e22)', color: 'inherit',
            border: '1px solid rgba(127,127,127,0.4)', borderRadius: 6,
            boxShadow: '0 4px 12px rgba(0,0,0,0.3)', fontSize: 13,
          }}>
            {visible.map(version => (
              <div
                key={version}
                role="option"
                aria-selected={version === value}
                onClick={() => { onChange(version); setOpen(false); }}
                style={{
                  padding: '5px 10px', cursor: 'pointer',
                  background: version === value ? 'rgba(127,127,127,0.15)' : 'transparent',
                }}
              >
                {version}
              </div>
            ))}
          </div>
        )
        : null}
    </div>
  );
}

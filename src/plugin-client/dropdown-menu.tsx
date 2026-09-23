/**
 * @file 远程类型选择下拉菜单
 * @description 提供 SSH / WSL 两种远程会话类型的选择入口。从触发按钮下方
 *              弹出，绝对定位；点击外部区域自动关闭。样式与现有面板一致
 *              （transparent background、inherit color、rgba 半透明边框），
 *              深浅主题都成立。
 */

import * as React from 'react';
import type { ReactNode } from 'react';
import type { RemoteExplorerLocaleKey } from './locales.js';

/** 远程会话类型 */
export type RemoteType = 'ssh' | 'wsl';

/** 下拉菜单 props */
export interface RemoteTypeMenuProps {
  /** 命名空间绑定的翻译函数 */
  t: (key: RemoteExplorerLocaleKey) => string;
  /** 选中某个类型后的回调 */
  onSelect: (type: RemoteType) => void;
  /** 菜单是否展开 */
  isOpen: boolean;
  /** 关闭菜单的回调 */
  onClose: () => void;
}

/** 菜单项定义 */
interface MenuItem {
  /** 类型标识 */
  type: RemoteType;
  /** locale 键 */
  labelKey: RemoteExplorerLocaleKey;
}

/** 菜单项列表 */
const MENU_ITEMS: MenuItem[] = [
  { type: 'ssh', labelKey: 'menuSsh' },
  { type: 'wsl', labelKey: 'menuWsl' },
];

/**
 * 远程类型选择下拉菜单。
 *
 * @param props - locale、选择回调、开合状态
 * @returns 菜单内容（isOpen=false 时渲染 null）
 */
export function RemoteTypeMenu(props: RemoteTypeMenuProps): ReactNode {
  const { t, onSelect, isOpen, onClose } = props;
  const menuRef = React.useRef<HTMLDivElement | null>(null);

  // 点击外部区域关闭菜单
  React.useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (event: MouseEvent): void => {
      const menu = menuRef.current;
      if (menu !== null && !menu.contains(event.target as Node)) {
        onClose();
      }
    };
    // 延迟注册避免触发按钮的 click 事件冒泡到本监听器
    const timer = setTimeout(() => {
      document.addEventListener('click', handleClickOutside);
    }, 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('click', handleClickOutside);
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const itemStyle: React.CSSProperties = {
    padding: '8px 16px',
    cursor: 'pointer',
    fontSize: 13,
    borderRadius: 4,
    background: 'transparent',
    color: 'inherit',
    border: 'none',
    width: '100%',
    textAlign: 'left',
  };

  return (
    <div
      ref={menuRef}
      style={{
        position: 'absolute',
        top: '100%',
        left: 0,
        marginTop: 4,
        minWidth: 180,
        background: 'var(--dsw-alias-bg-base, #1e1e22)',
        border: '1px solid rgba(127,127,127,0.4)',
        borderRadius: 6,
        padding: 4,
        zIndex: 100,
        boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
      }}
    >
      {MENU_ITEMS.map(item => (
        <button
          key={item.type}
          type="button"
          style={itemStyle}
          onMouseEnter={event => {
            (event.currentTarget as HTMLButtonElement).style.background = 'rgba(127,127,127,0.15)';
          }}
          onMouseLeave={event => {
            (event.currentTarget as HTMLButtonElement).style.background = 'transparent';
          }}
          onClick={() => {
            onSelect(item.type);
            onClose();
          }}
        >
          {t(item.labelKey)}
        </button>
      ))}
    </div>
  );
}

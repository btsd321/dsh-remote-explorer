/**
 * @file 弹窗共享壳（遮罩 + 居中卡片 + Esc + 标题/按钮行）
 * @description 三个高级选项弹窗（环境变量 / 代理 / 跳板机）共用的浮层骨架，
 *              消除各自重复的遮罩、卡片样式与键盘语义——弹窗组件只填业务
 *              差异（children 内容与 footer 按钮行）。
 *
 * 交互约束（与旧 HostEnvDialog 一致，行为基线不漂移）：
 * - 固定定位浮层盖在面板区域（半透明遮罩 + 居中卡片 + 最高 z-index），
 *   不必像 remote-window 那样挂 body 去盖桌面壳标题栏
 * - **点击遮罩不关闭**：行编辑是无暂存的本地 state，误触丢失成本高；
 *   关闭走「取消」按钮或 Esc（等同取消，不保存）
 *
 * 样式纪律：中性色一律 inherit/rgba 半透明灰，卡片背景用仓库浮层先例的
 * var(--dsw-alias-bg-base, #1e1e22)（dropdown-menu.tsx 同款），深浅主题都成立。
 */

import * as React from 'react';
import type { ReactNode } from 'react';
import { buttonStyle } from '../styles.js';

/** 弹窗壳 props */
export interface DialogShellProps {
  /** 标题（含目标上下文，如「环境变量：全局」） */
  title: string;
  /** 无障碍标签（缺省用 title） */
  ariaLabel?: string;
  /** 关闭弹窗（Esc 等同取消，不保存） */
  onClose: () => void;
  /** 弹窗主体（加载态/错误态/行编辑器等） */
  children: ReactNode;
  /** 底部按钮行（取消/保存）；缺省不渲染 */
  footer?: ReactNode;
  /** 卡片宽度（CSS width 值；缺省 560px 上限） */
  width?: string;
}

/** 行内小按钮样式（删除行按钮用，与会话行内按钮同规格） */
export const rowButtonStyle: React.CSSProperties = {
  background: 'transparent',
  color: 'inherit',
  border: '1px solid rgba(127,127,127,0.5)',
  borderRadius: 6,
  padding: '2px 8px',
  cursor: 'pointer',
  fontSize: 12,
};

/**
 * 弹窗壳。
 *
 * Esc 监听挂 window 且随卸载清理（onClose 引用由调用方 useCallback 稳定，
 * 避免重挂导致监听器抖动）。
 *
 * @param props - 见 {@link DialogShellProps}
 * @returns 浮层
 */
export function DialogShell(props: DialogShellProps): ReactNode {
  const { title, ariaLabel, onClose, children, footer, width } = props;

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => { window.removeEventListener('keydown', onKeyDown); };
  }, [onClose]);

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 2147483647,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(0,0,0,0.45)', padding: 24, boxSizing: 'border-box',
    }}>
      <div
        role="dialog" aria-modal="true" aria-label={ariaLabel ?? title}
        style={{
          width: width ?? 'min(560px, 100%)', maxHeight: '80vh', overflowY: 'auto',
          display: 'flex', flexDirection: 'column', gap: 10,
          background: 'var(--dsw-alias-bg-base, #1e1e22)', color: 'inherit',
          border: '1px solid rgba(127,127,127,0.4)', borderRadius: 8,
          padding: '14px 16px', boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
          fontSize: 13,
        }}
      >
        <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>{title}</h3>
        {children}
        {footer !== undefined
          ? <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>{footer}</div>
          : null}
      </div>
    </div>
  );
}

/**
 * 弹窗通用加载/错误态（三个弹窗同款，避免各自内联）。
 *
 * @param phase - loading 拉取中；error 拉取失败（可重试）
 * @param loadError - 失败详情文案
 * @param onRetry - 重试回调
 * @param t - 翻译函数（dlgLoading/dlgLoadError/retry 键）
 * @returns 对应态的 JSX；ready 态返回 null
 */
export function dialogLoadState(
  phase: 'loading' | 'error' | 'ready',
  loadError: string,
  onRetry: () => void,
  t: (key: 'dlgLoading' | 'dlgLoadError' | 'retry') => string,
): ReactNode {
  if (phase === 'loading') return <div style={{ opacity: 0.6 }}>{t('dlgLoading')}</div>;
  if (phase === 'error') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start' }}>
        <div style={{ color: '#ef4444', fontSize: 12 }}>{t('dlgLoadError')}{loadError}</div>
        <button type="button" style={buttonStyle} onClick={onRetry}>{t('retry')}</button>
      </div>
    );
  }
  return null;
}

/**
 * @file 主机选择 combobox
 * @description 连接表单的主机输入 + 完整主机列表浮层。替代原生 datalist：
 *              datalist 在输入框有残留值时按值过滤下拉（配置过环境变量的
 *              主机留在输入框时，点开只见它一台），本组件点开浮层**始终列出
 *              ssh config 全部主机**，仅在用户主动输入时做子串过滤；已连接
 *              主机带状态标记。自由输入（user@host[:port] 直连语法）保留。
 *
 * 交互约束：
 * - 聚焦 = 全选现有文本（残留值一键输入整体覆盖）+ 打开完整列表
 * - 点击浮层外部 / Esc 关闭；选择项填入并关闭
 * - 输入过滤按「别名 + user@host:port」小写子串匹配，与已有 cwd 记忆联动
 *   （onChange 直通外层 onHostChange）
 *
 * 样式纪律：中性色 inherit/rgba 半透明灰，卡片背景用仓库浮层先例
 * var(--dsw-alias-bg-base, #1e1e22)（dropdown-menu.tsx / host-env-dialog.tsx
 * 同款），不猜其他设计令牌名；已连接标记用语义绿。
 */

import * as React from 'react';
import type { ReactNode } from 'react';
import type { SshHostSummary } from '../hosts/ssh-config-parser.js';
import type { RemoteExplorerLocaleKey } from './locales.js';
import { inputStyle } from './styles.js';

/** 浮层最大高度（超出滚动；主机数多时不下撑表单） */
const DROPDOWN_MAX_HEIGHT = 240;

/** combobox props */
export interface HostPickerProps {
  /** 当前输入值（受控；可能是别名或 user@host 直连语法） */
  value: string;
  /** 值变化（浮层选择或自由输入都走这里） */
  onChange: (value: string) => void;
  /** ssh config 主机摘要列表（「↻ 刷新」后的最新数据） */
  hosts: SshHostSummary[];
  /**
   * 有活跃会话（含连接中与外部视图）的主机别名集合。
   * 仅作浮层项的「已连接」标记展示——按钮形态切换由外层基于同一集合判定
   */
  connectedHosts: ReadonlySet<string>;
  /** locale 翻译函数 */
  t: (key: RemoteExplorerLocaleKey) => string;
}

/**
 * 取单条主机选项的过滤匹配文本。
 *
 * @param host - 主机摘要
 * @returns 「别名 + user@host:port」拼接并小写化（子串过滤用）
 */
function matchText(host: SshHostSummary): string {
  const target = `${host.user === '' ? '' : `${host.user}@`}${host.hostName}:${host.port}`;
  return `${host.alias}\n${target}`.toLowerCase();
}

/**
 * 主机选择 combobox。
 *
 * 点开浮层始终显示全部主机（用户选择主机时不被输入框残留值过滤——这是
 * 弃用 datalist 的原因）；用户主动输入时按子串过滤辅助定位。
 *
 * @param props - 受控值、变更回调、主机列表、已连接集合、locale 面
 * @returns 输入框 + 条件渲染的浮层
 */
export function HostPicker(props: HostPickerProps): ReactNode {
  const { value, onChange, hosts, connectedHosts, t } = props;
  const [open, setOpen] = React.useState(false);
  const rootRef = React.useRef<HTMLDivElement | null>(null);

  // 点击浮层外部关闭：mousedown 判 rootRef 包含性（浮层是 root 的子元素，
  // 点选项不会先被外部判定关闭）。成对清理监听器
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

  // 输入过滤：只在用户主动输入后（值非空）收窄；清空即回到全部——
  // 打开浮层那一刻的完整列表不被点开前的残留值影响
  const filter = value.trim().toLowerCase();
  const visible = filter === ''
    ? hosts
    : hosts.filter(host => matchText(host).includes(filter));

  return (
    <div ref={rootRef} style={{ position: 'relative', flex: 1 }}>
      <input
        value={value}
        placeholder={t('hostPlaceholder')}
        style={{ ...inputStyle, width: '100%' }}
        onChange={event => onChange(event.target.value)}
        // 聚焦全选 + 打开完整列表：残留值可一键输入整体覆盖
        onFocus={event => { event.target.select(); setOpen(true); }}
        onKeyDown={event => { if (event.key === 'Escape') setOpen(false); }}
      />
      {open
        ? (
          <div role="listbox" style={{
            position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 1000,
            marginTop: 2, maxHeight: DROPDOWN_MAX_HEIGHT, overflowY: 'auto',
            background: 'var(--dsw-alias-bg-base, #1e1e22)', color: 'inherit',
            border: '1px solid rgba(127,127,127,0.4)', borderRadius: 6,
            boxShadow: '0 4px 12px rgba(0,0,0,0.3)', fontSize: 13,
          }}>
            {visible.length === 0
              ? <div style={{ padding: '6px 10px', opacity: 0.6 }}>{t('hostPickerNoMatch')}</div>
              : visible.map(host => {
                const connected = connectedHosts.has(host.alias);
                const target = `${host.user === '' ? '' : `${host.user}@`}${host.hostName}:${host.port}`;
                return (
                  <div
                    key={host.alias}
                    role="option"
                    aria-selected={host.alias === value}
                    onClick={() => { onChange(host.alias); setOpen(false); }}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      padding: '5px 10px', cursor: 'pointer',
                      background: host.alias === value ? 'rgba(127,127,127,0.15)' : 'transparent',
                    }}
                  >
                    <span style={{ fontWeight: 600 }}>{host.alias}</span>
                    <span style={{ fontSize: 12, opacity: 0.6 }}>{target}</span>
                    <span style={{ flex: 1 }} />
                    {connected
                      ? (
                        <span style={{ fontSize: 11, color: '#34d399' }}>
                          ● {t('stateConnected')}
                        </span>
                      )
                      : null}
                  </div>
                );
              })}
          </div>
        )
        : null}
    </div>
  );
}

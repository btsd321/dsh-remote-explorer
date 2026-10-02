/**
 * @file plugin-client/overlay-inset.ts 单元测试
 * @description 覆盖 overlayTopInset 在各种平台标记与 dsh 变量发布组合下的让位值判定。
 *              纯 Node 环境、零 DOM 依赖：被测函数接受窄接口 OverlayRoot，测试直接
 *              构造假对象注入，不引入 jsdom。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { overlayTopInset, type OverlayRoot } from '../../src/plugin-client/overlay-inset.js';

/** dsh 优先走 var() 链时返回的整条回退链字符串 */
const VAR_CHAIN = 'var(--dsh-frame-chrome-top, var(--dsh-frame-top-clearance, 0px))';

/**
 * 构造一个假 OverlayRoot（纯对象，无 DOM）。
 *
 * @param opts - 各槽位的注入值
 * @returns 满足 OverlayRoot 接口的假对象
 */
function fakeRoot(opts: {
  chromeTop?: string;
  topClearance?: string;
  attributes?: string[];
  platform?: string;
}): OverlayRoot {
  const attrs = new Set(opts.attributes ?? []);
  return {
    getComputedStyleValue(name: string): string {
      if (name === '--dsh-frame-chrome-top') return opts.chromeTop ?? '';
      if (name === '--dsh-frame-top-clearance') return opts.topClearance ?? '';
      return '';
    },
    hasDataAttribute(name: string): boolean {
      return attrs.has(name);
    },
    get platform(): string | undefined {
      return opts.platform;
    },
  };
}

describe('overlayTopInset —— dsh 变量缺失时按平台标记回退', () => {
  it('两变量都缺失 + 无平台标记 → 0px', () => {
    const root = fakeRoot({});
    assert.equal(overlayTopInset(root), '0px');
  });

  it('缺失 + data-windows-titlebar → 40px', () => {
    const root = fakeRoot({ attributes: ['data-windows-titlebar'] });
    assert.equal(overlayTopInset(root), '40px');
  });

  it('缺失 + platform=darwin → 52px', () => {
    const root = fakeRoot({ platform: 'darwin' });
    assert.equal(overlayTopInset(root), '52px');
  });

  it('缺失 + 有 data-fullscreen → 0px', () => {
    // 全屏优先于平台标记：即便同时有 windows-titlebar 或 darwin，全屏一律 0px
    const root = fakeRoot({
      attributes: ['data-fullscreen', 'data-windows-titlebar'],
      platform: 'darwin',
    });
    assert.equal(overlayTopInset(root), '0px');
  });

  it('缺失 + darwin + data-fullscreen → 0px（全屏压过 darwin 回退）', () => {
    const root = fakeRoot({ attributes: ['data-fullscreen'], platform: 'darwin' });
    assert.equal(overlayTopInset(root), '0px');
  });
});

describe('overlayTopInset —— dsh 发布了变量时走 var() 链（不读 JS 快照）', () => {
  it('--dsh-frame-chrome-top 有值 → 返回 var() 链', () => {
    const root = fakeRoot({ chromeTop: '40px' });
    assert.equal(overlayTopInset(root), VAR_CHAIN);
  });

  it('只有 --dsh-frame-top-clearance 有值 → 返回 var() 链', () => {
    const root = fakeRoot({ topClearance: '48px' });
    assert.equal(overlayTopInset(root), VAR_CHAIN);
  });

  it('两变量都有值 → 返回 var() 链', () => {
    const root = fakeRoot({ chromeTop: '40px', topClearance: '48px' });
    assert.equal(overlayTopInset(root), VAR_CHAIN);
  });

  it('变量值仅含空白 → 视为缺失，走平台标记回退', () => {
    // getComputedStyle 对未定义变量返回空串；此用例确认 .trim() 处理空白容错
    const root = fakeRoot({ chromeTop: '   ', topClearance: '\t' });
    assert.equal(overlayTopInset(root), '0px');
  });

  it('变量有值时即便全屏也走 var() 链（全屏归零由 CSS 层负责，不读 JS 快照）', () => {
    const root = fakeRoot({
      chromeTop: '40px',
      attributes: ['data-fullscreen', 'data-windows-titlebar'],
    });
    // 走 var() 链：CSS 层在 [data-fullscreen] 下把 chrome-top 归零，无需 JS 处理
    assert.equal(overlayTopInset(root), VAR_CHAIN);
  });
});

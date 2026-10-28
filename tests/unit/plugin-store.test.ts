/**
 * @file provision/plugin-store.ts 单元测试
 * @description 覆盖 manifest 自愈的两块纯逻辑：node_modules 扫描结果解析
 *              （插件判定只看 `dsh` 元数据；回退链接、`@deepseek-ai/*` 与交接
 *              合成包排除）与 dependencies 计划（回收、清理历史 `*` 收编污染、
 *              按已装版本收编真插件）。
 *
 * 不覆盖远端执行与 pnpm 锁文件收敛（属集成行为，需要真实 profile）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseHostProfileScan, planHostProfileManifestSync,
  type HostProfileScan,
} from '../../src/provision/plugin-store.js';

/** 扫描脚本的分段标记（与 buildScanCommand 的固定串一致） */
const PLUGINS_MARKER = '__DSH_REMOTE_EXPLORER_PLUGINS__';
const ALL_MARKER = '__DSH_REMOTE_EXPLORER_ALL__';

/** 构造扫描结果 */
function scanOf(packages: string[], plugins: Record<string, string> = {}): HostProfileScan {
  return { packages: new Set(packages), plugins: new Map(Object.entries(plugins)) };
}

describe('parseHostProfileScan', () => {
  it('解析插件名与已装版本，并收集全部顶层包名', () => {
    const scan = parseHostProfileScan([
      PLUGINS_MARKER,
      'dsh-better-sidebar\t0.28.2',
      'dsh-oh-my-terminal\t0.4.5',
      ALL_MARKER,
      'dsh-better-sidebar',
      '@standard-schema/spec',
      '@codemirror/view',
    ].join('\n'));
    assert.deepEqual([...scan.plugins.entries()], [
      ['dsh-better-sidebar', '0.28.2'],
      ['dsh-oh-my-terminal', '0.4.5'],
    ]);
    assert.deepEqual([...scan.packages], [
      'dsh-better-sidebar', '@standard-schema/spec', '@codemirror/view',
    ]);
  });

  it('排除回退链接、@deepseek-ai 与交接合成包', () => {
    const scan = parseHostProfileScan([
      PLUGINS_MARKER,
      '@deepseek-ai/cordis\t4.0.4',
      'dsh-remote-handoff\t0.0.0',
      ALL_MARKER,
      '@deepseek-ai',
      '@deepseek-ai/cordis',
      'cpu-features',
      'nan',
      'dsh-remote-handoff',
      'real-plugin',
    ].join('\n'));
    assert.deepEqual([...scan.packages], ['real-plugin']);
    assert.equal(scan.plugins.size, 0);
  });

  it('插件缺版本时只进包名，不进插件表', () => {
    const scan = parseHostProfileScan([PLUGINS_MARKER, 'broken-plugin\t', ALL_MARKER, 'broken-plugin'].join('\n'));
    assert.deepEqual([...scan.packages], ['broken-plugin']);
    assert.equal(scan.plugins.size, 0);
  });

  it('分段标记之前的行被忽略', () => {
    const scan = parseHostProfileScan(['stray-line', PLUGINS_MARKER, ALL_MARKER].join('\n'));
    assert.equal(scan.packages.size, 0);
    assert.equal(scan.plugins.size, 0);
  });
});

describe('planHostProfileManifestSync', () => {
  it('回收 nm 中已不存在的依赖', () => {
    const plan = planHostProfileManifestSync({
      dependencies: { 'dsh-better-sidebar': '0.28.1', 'gone-plugin': '1.0.0' },
      scan: scanOf(['dsh-better-sidebar'], { 'dsh-better-sidebar': '0.28.2' }),
    });
    assert.deepEqual(plan.dependencies, { 'dsh-better-sidebar': '0.28.1' });
    assert.equal(plan.changed, true);
  });

  it('删除历史 `*` 收编的非插件传递依赖（插件市场假条目根因）', () => {
    const plan = planHostProfileManifestSync({
      dependencies: {
        'dsh-better-sidebar': '0.28.2',
        '@standard-schema/spec': '*',
        '@codemirror/view': '*',
      },
      scan: scanOf(
        ['dsh-better-sidebar', '@standard-schema/spec', '@codemirror/view'],
        { 'dsh-better-sidebar': '0.28.2' },
      ),
    });
    assert.deepEqual(plan.dependencies, { 'dsh-better-sidebar': '0.28.2' });
    assert.equal(plan.changed, true);
  });

  it('删除被 dshmarket update 改写成具体版本的非插件依赖（同一批收编产物）', () => {
    const plan = planHostProfileManifestSync({
      dependencies: {
        'dsh-better-sidebar': '0.28.2',
        '@lydell/node-pty': '1.2.0-beta.15',
        undici: '^8.11.2',
      },
      scan: scanOf(
        ['dsh-better-sidebar', '@lydell/node-pty', 'undici'],
        { 'dsh-better-sidebar': '0.28.2' },
      ),
    });
    assert.deepEqual(plan.dependencies, { 'dsh-better-sidebar': '0.28.2' });
    assert.equal(plan.changed, true);
  });

  it('`*` 收编的真插件改钉 `^已装版本`', () => {
    const plan = planHostProfileManifestSync({
      dependencies: { 'dsh-better-sidebar': '*' },
      scan: scanOf(['dsh-better-sidebar'], { 'dsh-better-sidebar': '0.28.2' }),
    });
    assert.deepEqual(plan.dependencies, { 'dsh-better-sidebar': '^0.28.2' });
    assert.equal(plan.changed, true);
  });

  it('未声明的真插件按已装版本收编（不用 `*`）', () => {
    const plan = planHostProfileManifestSync({
      dependencies: {},
      scan: scanOf(['dsh-pet'], { 'dsh-pet': '0.3.8' }),
    });
    assert.deepEqual(plan.dependencies, { 'dsh-pet': '^0.3.8' });
    assert.equal(plan.changed, true);
  });

  it('普通 spec 原样保留，不引入版本漂移', () => {
    const plan = planHostProfileManifestSync({
      dependencies: { dshmarket: '~1.70.3', '@linxin666/dsh-client-ui-skill-explorer': '0.4.11' },
      scan: scanOf(
        ['dshmarket', '@linxin666/dsh-client-ui-skill-explorer'],
        { dshmarket: '1.70.3', '@linxin666/dsh-client-ui-skill-explorer': '0.4.11' },
      ),
    });
    assert.deepEqual(plan.dependencies, {
      dshmarket: '~1.70.3',
      '@linxin666/dsh-client-ui-skill-explorer': '0.4.11',
    });
    assert.equal(plan.changed, false);
  });

  it('版本不是 semver 的真插件保留原 spec（不猜 git/file 规格）', () => {
    const plan = planHostProfileManifestSync({
      dependencies: { 'weird-plugin': '*' },
      scan: scanOf(['weird-plugin'], { 'weird-plugin': 'workspace:../weird' }),
    });
    assert.deepEqual(plan.dependencies, { 'weird-plugin': '*' });
    assert.equal(plan.changed, false);
  });

  it('已有具体版本的真插件原样保留，不重新收编', () => {
    const plan = planHostProfileManifestSync({
      dependencies: { 'dsh-pet': '0.3.8' },
      scan: scanOf(['dsh-pet'], { 'dsh-pet': '0.3.8' }),
    });
    assert.deepEqual(plan.dependencies, { 'dsh-pet': '0.3.8' });
    assert.equal(plan.changed, false);
  });
});

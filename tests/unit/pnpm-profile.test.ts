/**
 * @file provision/pnpm-profile.ts 单元测试
 * @description 覆盖 pnpm-workspace.yaml 幂等补齐纯函数
 *              （ensurePnpmWorkspaceSettings）：文件缺失的最小骨架
 *              （含 dsh 模板设置段）、已有部分 key 只追加缺失段且不动既有
 *              决策、全齐原样返回、追加结果的幂等性（跑两次输出一致）、
 *              换行边界与顶层判据，以及补齐产物是合法 YAML 且两段 key
 *              落在顶层（用仓库声明的 yaml 依赖解析验证）。
 *
 * 不覆盖远端读写动作（ensurePnpmProfileSettings 的 cat/write）——严格写入
 * 语义由真实 provision/doctor 实跑验证。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'yaml';
import { ensurePnpmWorkspaceSettings } from '../../src/provision/pnpm-profile.js';

/**
 * dsh profile 模板的实测生成结果（用户机器上的 61 字节原文）：
 * 只有 packages/nodeLinker/autoInstallPeers，两段 pnpm 11 前提都没有。
 */
const DSH_TEMPLATE = [
  'packages:',
  '  - .',
  '',
  'nodeLinker: hoisted',
  'autoInstallPeers: false',
  '',
].join('\n');

describe('ensurePnpmWorkspaceSettings', () => {
  describe('文件缺失/空文本（防御路径）', () => {
    it('空文本生成含两段设置的最小骨架', () => {
      const out = ensurePnpmWorkspaceSettings('');
      assert.match(out, /^allowBuilds:$/m);
      assert.match(out, /^  cpu-features: true$/m);
      assert.match(out, /^  esbuild: true$/m);
      assert.match(out, /^  ssh2: true$/m);
      assert.match(out, /^minimumReleaseAge: 0$/m);
      assert.ok(out.endsWith('\n'), '文件应以换行结尾');
    });

    it('最小骨架自带 dsh 模板设置段（预写会抑制 dsh 写模板）', () => {
      const out = ensurePnpmWorkspaceSettings('');
      assert.match(out, /^packages:$/m);
      assert.match(out, /^  - \.$/m);
      assert.match(out, /^nodeLinker: hoisted$/m);
      assert.match(out, /^autoInstallPeers: false$/m);
    });

    it('最小骨架带中文注释说明段为何存在', () => {
      const out = ensurePnpmWorkspaceSettings('');
      assert.match(out, /# pnpm 11 对未决策构建脚本致命报错/);
      assert.match(out, /# pnpm 11 默认 24h 供应链门槛/);
    });

    it('纯空白文本同样生成最小骨架', () => {
      assert.equal(ensurePnpmWorkspaceSettings('\n\n'), ensurePnpmWorkspaceSettings(''));
    });
  });

  describe('已有部分 key（只追加缺失段）', () => {
    it('已有 allowBuilds 只追加 minimumReleaseAge，既有决策一字不动', () => {
      const existing = [
        'allowBuilds:',
        '  ssh2: true',
        '',
      ].join('\n');
      const out = ensurePnpmWorkspaceSettings(existing);
      assert.ok(out.startsWith(existing), '既有 allowBuilds 段应原样保留（不合并内容）');
      assert.match(out, /^minimumReleaseAge: 0$/m);
      assert.equal((out.match(/^allowBuilds:/gm) ?? []).length, 1, 'allowBuilds 顶层行不重复');
    });

    it('已有 minimumReleaseAge 只追加 allowBuilds', () => {
      const existing = 'minimumReleaseAge: 1440\n';
      const out = ensurePnpmWorkspaceSettings(existing);
      assert.ok(out.startsWith(existing), '既有 minimumReleaseAge 原样保留');
      assert.match(out, /^allowBuilds:$/m);
      assert.equal((out.match(/^minimumReleaseAge:/gm) ?? []).length, 1, 'minimumReleaseAge 顶层行不重复');
    });

    it('dsh 模板样例（真机实测形状）两段全缺时双双追加且保留原文', () => {
      const out = ensurePnpmWorkspaceSettings(DSH_TEMPLATE);
      assert.ok(out.startsWith(DSH_TEMPLATE), '模板既有内容原样保留');
      assert.match(out, /^allowBuilds:$/m);
      assert.match(out, /^minimumReleaseAge: 0$/m);
      assert.equal((out.match(/^nodeLinker: hoisted$/gm) ?? []).length, 1, '模板行不重复');
    });
  });

  describe('全齐（幂等命中）', () => {
    it('两段都在时输出与输入完全一致', () => {
      const existing = [
        'packages:',
        '  - .',
        'allowBuilds:',
        '  ssh2: true',
        'minimumReleaseAge: 0',
      ].join('\n');
      assert.equal(ensurePnpmWorkspaceSettings(existing), existing);
    });

    it('dsh 模板补齐产物再跑一次输出不变（幂等性）', () => {
      const once = ensurePnpmWorkspaceSettings(DSH_TEMPLATE);
      assert.equal(ensurePnpmWorkspaceSettings(once), once);
    });

    it('最小骨架再跑一次输出不变（幂等性）', () => {
      const once = ensurePnpmWorkspaceSettings('');
      assert.equal(ensurePnpmWorkspaceSettings(once), once);
    });
  });

  describe('换行边界', () => {
    it('无结尾换行的文本先补换行再追加', () => {
      const out = ensurePnpmWorkspaceSettings('packages:\n  - .');
      assert.ok(out.startsWith('packages:\n  - .\n'), '先补齐结尾换行');
      assert.match(out, /^allowBuilds:$/m);
      assert.ok(out.endsWith('\n'), '补齐结果以换行结尾');
    });

    it('追加段与既有内容之间空一行', () => {
      const out = ensurePnpmWorkspaceSettings('packages:\n  - .\n');
      assert.match(out, /\.\n\n# pnpm 11/, '段间应有空行分隔');
    });
  });

  describe('顶层判据（嵌套同名 key 不算已决策）', () => {
    it('嵌套缩进的 allowBuilds 不被认账，仍追加顶层段', () => {
      const existing = 'foo:\n  allowBuilds: true\n';
      const out = ensurePnpmWorkspaceSettings(existing);
      assert.match(out, /^allowBuilds:$/m);
    });

    it('嵌套缩进的 minimumReleaseAge 不被认账', () => {
      const existing = 'foo:\n  minimumReleaseAge: 0\n';
      const out = ensurePnpmWorkspaceSettings(existing);
      assert.match(out, /^minimumReleaseAge: 0$/m);
    });
  });

  describe('补齐产物是合法 YAML（pnpm 真正要读的形态）', () => {
    it('最小骨架可解析，两段 key 落在顶层且取值正确', () => {
      const parsed = parse(ensurePnpmWorkspaceSettings('')) as Record<string, unknown>;
      assert.deepEqual(parsed.allowBuilds, { 'cpu-features': true, esbuild: true, ssh2: true });
      assert.equal(parsed.minimumReleaseAge, 0);
      assert.equal(parsed.nodeLinker, 'hoisted');
      assert.equal(parsed.autoInstallPeers, false);
      assert.deepEqual(parsed.packages, ['.']);
    });

    it('dsh 模板追加产物可解析，模板设置与两段前提共存', () => {
      const parsed = parse(ensurePnpmWorkspaceSettings(DSH_TEMPLATE)) as Record<string, unknown>;
      assert.deepEqual(parsed.allowBuilds, { 'cpu-features': true, esbuild: true, ssh2: true });
      assert.equal(parsed.minimumReleaseAge, 0);
      assert.equal(parsed.nodeLinker, 'hoisted');
      assert.equal(parsed.autoInstallPeers, false);
      assert.deepEqual(parsed.packages, ['.']);
    });
  });
});

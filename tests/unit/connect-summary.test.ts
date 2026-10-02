/**
 * @file plugin/connect-summary.ts 单元测试
 * @description 覆盖 renderConnectSummary() 的行序与渲染纪律：环境变量只打
 *              键名、代理 userinfo 打码、跳板机只打 user@host:port 与认证
 *              途径（不打密码/私钥路径）、私钥覆盖只打有无。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderConnectSummary } from '../../src/plugin/connect-summary.js';

/** 基础输入（各用例按需覆盖字段） */
const BASE = {
  hostAlias: 'orangepi',
  transportType: 'ssh' as const,
  envKeys: [],
  localPort: 18950,
  forceRestart: false,
  refreshMirrors: false,
  privateKey: false,
};

describe('renderConnectSummary', () => {
  it('SSH 首行带主机与传输类型', () => {
    const lines = renderConnectSummary(BASE);
    assert.ok(lines[0] !== undefined && lines[0].includes('orangepi'));
    assert.ok(lines[0] !== undefined && lines[0].includes('SSH'));
  });

  it('WSL 首行带发行版名，且无跳板机行', () => {
    const lines = renderConnectSummary({ ...BASE, transportType: 'wsl', distroName: 'Ubuntu' });
    assert.ok(lines[0] !== undefined && lines[0].includes('WSL Ubuntu'));
    assert.ok(!lines.some(line => line.includes('跳板机')));
  });

  it('无跳板机计划时显示「无（直连）」', () => {
    const lines = renderConnectSummary(BASE);
    assert.ok(lines.some(line => line.includes('跳板机: 无（直连）')));
  });

  it('跳板机链逐级展示 user@host:port 与认证途径，来源标注 config/面板', () => {
    const lines = renderConnectSummary({
      ...BASE,
      jumpPlan: {
        source: 'panel',
        chain: [
          { host: '10.1.1.2', port: 22, username: 'jump', identityFile: '/home/me/.ssh/id' },
          { host: '10.1.1.3', port: 2222, username: 'admin', password: 'secret' },
        ],
      },
    });
    const jumpLine = lines.find(line => line.includes('跳板机:'));
    assert.ok(jumpLine !== undefined);
    assert.ok(jumpLine.includes('jump@10.1.1.2:22（私钥）'));
    assert.ok(jumpLine.includes('admin@10.1.1.3:2222（密码）'));
    assert.ok(jumpLine.includes('[面板配置]'));
    // 渲染纪律：密码值与私钥路径绝不出现
    assert.ok(!lines.some(line => line.includes('secret')));
    assert.ok(!lines.some(line => line.includes('/home/me/.ssh/id')));
  });

  it('跳板机计划解析失败时显示原因行', () => {
    const lines = renderConnectSummary({ ...BASE, jumpPlanError: '在 config 中找不到别名 bad' });
    assert.ok(lines.some(line => line.includes('跳板机: 解析失败')));
  });

  it('覆盖被忽略的说明单独成行', () => {
    const lines = renderConnectSummary({
      ...BASE,
      jumpPlan: {
        source: 'config',
        chain: [],
        ignoredOverride: '主机 x 在 ssh config 中已有定义',
      },
    });
    assert.ok(lines.some(line => line.includes('注意:')));
  });

  it('环境变量只打键名不打值', () => {
    const lines = renderConnectSummary({ ...BASE, envKeys: ['FOO', 'BAR'] });
    assert.ok(lines.some(line => line.includes('环境变量: FOO, BAR')));
  });

  it('代理 userinfo 打码，无 userinfo 原样展示', () => {
    const masked = renderConnectSummary({ ...BASE, proxy: 'http://user:pass@127.0.0.1:18890' });
    assert.ok(masked.some(line => line.includes('代理: http://user:***@127.0.0.1:18890')));
    assert.ok(!masked.some(line => line.includes('pass@')));
    const plain = renderConnectSummary({ ...BASE, proxy: 'http://127.0.0.1:18890' });
    assert.ok(plain.some(line => line.includes('代理: http://127.0.0.1:18890')));
  });

  it('未配置的字段有明确占位行', () => {
    const lines = renderConnectSummary(BASE);
    assert.ok(lines.some(line => line.includes('环境变量: 未配置')));
    assert.ok(lines.some(line => line.includes('代理: 未配置')));
  });

  it('端口 0 显示 OS 分配，其余选项渲染生效值', () => {
    const lines = renderConnectSummary({
      ...BASE,
      localPort: 0,
      nodeVersion: 'v24.21.0',
      dshVersion: '0.2.0-rc.2',
      forceRestart: true,
      privateKey: true,
    });
    const optionsLine = lines.find(line => line.includes('本地端口:'));
    assert.ok(optionsLine !== undefined);
    assert.ok(optionsLine.includes('OS 分配'));
    assert.ok(optionsLine.includes('v24.21.0'));
    assert.ok(optionsLine.includes('0.2.0-rc.2'));
    assert.ok(optionsLine.includes('强制重启: 是'));
    assert.ok(optionsLine.includes('私钥覆盖: 有'));
  });
});

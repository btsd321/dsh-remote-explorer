/**
 * @file plugin/advanced-store.ts 单元测试
 * @description 覆盖 validateAdvancedConfig() 的三类字段校验（env 键名/保留键/
 *              控制字符、proxy URL 形态、jumpHosts 条目形态），
 *              readAdvancedConfig()/writeAdvancedConfig() 的分域读写回路、
 *              v2 落盘结构、v1→v2 迁移、域互不影响、清空一域保留另一域、
 *              两域全空删除语义、WSL 域只认 env 的防御、损坏文件容错与坏项
 *              过滤。全部走参数化的临时目录（baseDir），不触碰真实的
 *              ~/.dsh/remote-advanced.json。
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readAdvancedConfig, validateAdvancedConfig, writeAdvancedConfig,
} from '../../src/plugin/advanced-store.js';

/** 每个测试文件独立的临时目录（用例间不复用，避免相互污染） */
const BASE_DIR = mkdtempSync(join(tmpdir(), 'advanced-store-test-'));

/** 落盘文件名（与 advanced-store 的常量同名同值的契约断言用） */
const FILE_NAME = 'remote-advanced.json';

after(() => {
  rmSync(BASE_DIR, { recursive: true, force: true });
});

/**
 * 在临时目录直接手写落盘文件（模拟手工编辑/损坏/旧版本场景）。
 *
 * @param text - 文件内容
 */
function writeRawFile(text: string): void {
  writeFileSync(join(BASE_DIR, FILE_NAME), text, 'utf8');
}

/**
 * 读回落盘文件原文（结构断言用）。
 *
 * @returns 文件文本
 */
function readRawFile(): string {
  return readFileSync(join(BASE_DIR, FILE_NAME), 'utf8');
}

// ─── validateAdvancedConfig ───────────────────────────────────────────────

describe('validateAdvancedConfig', () => {
  describe('合法输入', () => {
    it('三字段齐合法返回 undefined', () => {
      assert.equal(validateAdvancedConfig({
        env: { MY_VAR: 'value' },
        proxy: 'http://127.0.0.1:18890',
        jumpHosts: [{ target: 'jump1' }, { target: 'user@bastion:22' }],
      }), undefined);
    });

    it('全空配置合法（表示清除）', () => {
      assert.equal(validateAdvancedConfig({ env: {} }), undefined);
    });

    it('代理带 userinfo 与尾随斜杠合法', () => {
      assert.equal(validateAdvancedConfig({
        env: {},
        proxy: 'http://user:pass@127.0.0.1:18890/',
      }), undefined);
    });
  });

  describe('env 字段', () => {
    it('非法键名返回错误消息且含键名', () => {
      const result = validateAdvancedConfig({ env: { 'BAD KEY': 'value' } });
      assert.ok(result !== undefined && result.includes('BAD KEY'));
    });

    it('保留键 DSH_HOME 拒绝', () => {
      const result = validateAdvancedConfig({ env: { DSH_HOME: '/custom' } });
      assert.ok(result !== undefined && result.includes('DSH_HOME'));
    });

    it('值含控制字符拒绝', () => {
      const result = validateAdvancedConfig({ env: { MY_VAR: 'a\u0007b' } });
      assert.ok(result !== undefined && result.includes('MY_VAR'));
    });
  });

  describe('proxy 字段', () => {
    const badProxies = [
      'not a url', 'ftp://127.0.0.1:18890', 'http://127.0.0.1:18890/path',
      'http://127.0.0.1:18890?q=1', 'http://127.0.0.1:18890#frag',
    ];

    for (const proxy of badProxies) {
      it(`代理 '${proxy}' 拒绝`, () => {
        const result = validateAdvancedConfig({ env: {}, proxy });
        assert.ok(result !== undefined && result.includes('代理'));
      });
    }

    it('空串代理合法（按未配置语义处理）', () => {
      assert.equal(validateAdvancedConfig({ env: {}, proxy: '' }), undefined);
    });
  });

  describe('jumpHosts 字段', () => {
    it('target 空串拒绝', () => {
      const result = validateAdvancedConfig({ env: {}, jumpHosts: [{ target: '' }] });
      assert.ok(result !== undefined);
    });

    it('target 含空白拒绝', () => {
      const result = validateAdvancedConfig({ env: {}, jumpHosts: [{ target: 'jump 1' }] });
      assert.ok(result !== undefined && result.includes('jump 1'));
    });

    it('别名与 user@host[:port] 形态均合法', () => {
      assert.equal(validateAdvancedConfig({
        env: {},
        jumpHosts: [
          { target: 'jump1' },
          { target: 'user@bastion' },
          { target: 'user@bastion:2222', identityFile: 'C:/Users/me/.ssh/id_rsa' },
        ],
      }), undefined);
    });

    it('identityFile 含控制字符拒绝', () => {
      const result = validateAdvancedConfig({
        env: {}, jumpHosts: [{ target: 'jump1', identityFile: 'a\u0007b' }],
      });
      assert.ok(result !== undefined && result.includes('jump1'));
    });

    it('密码字段一律拒绝（不落盘安全约束）', () => {
      const result = validateAdvancedConfig({
        env: {},
        // 运行时形状未知，故意带 password 模拟绕过类型层的调用方
        jumpHosts: [{ target: 'jump1', password: 'secret' } as never],
      });
      assert.ok(result !== undefined && result.includes('password'));
      assert.ok(result !== undefined && result.includes('不落盘'));
    });
  });
});

// ─── 分域读写回路 ──────────────────────────────────────────────────────────

describe('分域读写回路', () => {
  it('ssh 域写入后读回同值（含三字段，跳板机为落盘子集）', () => {
    writeAdvancedConfig('ssh', {
      env: { FOO: 'bar', EMPTY: '' },
      proxy: 'http://127.0.0.1:18890',
      jumpHosts: [{ target: 'jump1', identityFile: 'C:/keys/id_rsa' }],
    }, BASE_DIR);
    assert.deepEqual(readAdvancedConfig('ssh', BASE_DIR), {
      env: { FOO: 'bar', EMPTY: '' },
      proxy: 'http://127.0.0.1:18890',
      jumpHosts: [{ target: 'jump1', identityFile: 'C:/keys/id_rsa' }],
    });
  });

  it('wsl 域写入后读回同值（只有 env）', () => {
    writeAdvancedConfig('wsl', { env: { WSL_VAR: '1' } }, BASE_DIR);
    assert.deepEqual(readAdvancedConfig('wsl', BASE_DIR), { env: { WSL_VAR: '1' } });
  });

  it('两域互不影响：写一域不动另一域', () => {
    writeAdvancedConfig('ssh', {
      env: { SSH_VAR: '1' },
      proxy: 'http://127.0.0.1:18890',
      jumpHosts: [{ target: 'jump1' }],
    }, BASE_DIR);
    writeAdvancedConfig('wsl', { env: { WSL_VAR: '2' } }, BASE_DIR);
    assert.deepEqual(readAdvancedConfig('ssh', BASE_DIR), {
      env: { SSH_VAR: '1' },
      proxy: 'http://127.0.0.1:18890',
      jumpHosts: [{ target: 'jump1' }],
    });
    assert.deepEqual(readAdvancedConfig('wsl', BASE_DIR), { env: { WSL_VAR: '2' } });
  });

  it('落盘结构 v2：version=2 + ssh/wsl 两域', () => {
    writeAdvancedConfig('ssh', { env: { FOO: 'bar' } }, BASE_DIR);
    writeAdvancedConfig('wsl', { env: { WSL_VAR: '1' } }, BASE_DIR);
    const parsed = JSON.parse(readRawFile()) as Record<string, unknown>;
    assert.equal(parsed.version, 2);
    assert.deepEqual(parsed.ssh, { env: { FOO: 'bar' } });
    assert.deepEqual(parsed.wsl, { env: { WSL_VAR: '1' } });
  });

  it('空串 proxy 按未配置落盘（不写空壳字段）', () => {
    // env 带一个值避免触发「两域全空删除文件」语义——这里只验 proxy 空串不落盘
    writeAdvancedConfig('ssh', { env: { KEEP: '1' }, proxy: '' }, BASE_DIR);
    const parsed = JSON.parse(readRawFile()) as { ssh: Record<string, unknown> };
    assert.equal(parsed.ssh.proxy, undefined);
    assert.deepEqual(parsed.ssh.env, { KEEP: '1' });
  });

  it('写前校验兜底：非法配置直接抛错不落盘', () => {
    assert.throws(() => writeAdvancedConfig('ssh', { env: { 'BAD KEY': 'x' } }, BASE_DIR), /BAD KEY/);
  });

  it('wsl 域写 proxy/jumpHosts 抛错（调用方程序错误防御）', () => {
    assert.throws(
      () => writeAdvancedConfig('wsl', { env: {}, proxy: 'http://127.0.0.1:18890' } as never, BASE_DIR),
      /WSL/,
    );
    assert.throws(
      () => writeAdvancedConfig('wsl', { env: {}, jumpHosts: [{ target: 'jump1' }] } as never, BASE_DIR),
      /WSL/,
    );
    // 空串 proxy 同样拒绝：域契约是「不传该字段」，而非「传空值」
    assert.throws(
      () => writeAdvancedConfig('wsl', { env: {}, proxy: '' } as never, BASE_DIR),
      /WSL/,
    );
  });

  it('文件缺失时读回全空（两域皆然）', () => {
    rmSync(join(BASE_DIR, FILE_NAME), { force: true });
    assert.deepEqual(readAdvancedConfig('ssh', BASE_DIR), { env: {} });
    assert.deepEqual(readAdvancedConfig('wsl', BASE_DIR), { env: {} });
  });
});

// ─── v1 迁移与清空语义 ─────────────────────────────────────────────────────

describe('v1 迁移与清空语义', () => {
  it('v1 旧文件读取归一化：顶层字段进 ssh 域、wsl 域空 env', () => {
    writeRawFile('{"version": 1, "env": {"OLD": "1"},'
      + ' "proxy": "http://127.0.0.1:18890", "jumpHosts": [{"target": "jump1"}]}');
    assert.deepEqual(readAdvancedConfig('ssh', BASE_DIR), {
      env: { OLD: '1' },
      proxy: 'http://127.0.0.1:18890',
      jumpHosts: [{ target: 'jump1' }],
    });
    assert.deepEqual(readAdvancedConfig('wsl', BASE_DIR), { env: {} });
  });

  it('无 version 字段的旧文件同样按 v1 归一化', () => {
    writeRawFile('{"env": {"OLD": "1"}}');
    assert.deepEqual(readAdvancedConfig('ssh', BASE_DIR), { env: { OLD: '1' } });
    assert.deepEqual(readAdvancedConfig('wsl', BASE_DIR), { env: {} });
  });

  it('v1 归一化后在 wsl 域写入：落盘升为 v2，ssh 域原值保留', () => {
    writeRawFile('{"version": 1, "env": {"OLD": "1"}, "proxy": "http://127.0.0.1:18890"}');
    writeAdvancedConfig('wsl', { env: { WSL_VAR: '1' } }, BASE_DIR);
    const parsed = JSON.parse(readRawFile()) as Record<string, unknown>;
    assert.equal(parsed.version, 2);
    assert.deepEqual(parsed.ssh, { env: { OLD: '1' }, proxy: 'http://127.0.0.1:18890' });
    assert.deepEqual(parsed.wsl, { env: { WSL_VAR: '1' } });
  });

  it('清空一域保留另一域（文件不删）', () => {
    writeAdvancedConfig('ssh', { env: { SSH_VAR: '1' }, proxy: 'http://127.0.0.1:18890' }, BASE_DIR);
    writeAdvancedConfig('wsl', { env: { WSL_VAR: '2' } }, BASE_DIR);
    writeAdvancedConfig('wsl', { env: {} }, BASE_DIR);
    assert.equal(existsSync(join(BASE_DIR, FILE_NAME)), true);
    assert.deepEqual(readAdvancedConfig('wsl', BASE_DIR), { env: {} });
    assert.deepEqual(readAdvancedConfig('ssh', BASE_DIR), {
      env: { SSH_VAR: '1' },
      proxy: 'http://127.0.0.1:18890',
    });
  });

  it('两域全空删除文件（清空配置不留空壳）', () => {
    writeAdvancedConfig('ssh', { env: { SSH_VAR: '1' } }, BASE_DIR);
    writeAdvancedConfig('wsl', { env: { WSL_VAR: '2' } }, BASE_DIR);
    writeAdvancedConfig('ssh', { env: {} }, BASE_DIR);
    assert.equal(existsSync(join(BASE_DIR, FILE_NAME)), true);
    writeAdvancedConfig('wsl', { env: {} }, BASE_DIR);
    assert.equal(existsSync(join(BASE_DIR, FILE_NAME)), false);
    assert.deepEqual(readAdvancedConfig('ssh', BASE_DIR), { env: {} });
    assert.deepEqual(readAdvancedConfig('wsl', BASE_DIR), { env: {} });
  });
});

// ─── 损坏文件容错 ──────────────────────────────────────────────────────────

describe('损坏文件容错', () => {
  it('JSON 损坏回落空配置', () => {
    writeRawFile('{ not json');
    assert.deepEqual(readAdvancedConfig('ssh', BASE_DIR), { env: {} });
    assert.deepEqual(readAdvancedConfig('wsl', BASE_DIR), { env: {} });
  });

  it('v1 env 结构缺失回落空配置', () => {
    writeRawFile('{"version": 1, "proxy": "http://127.0.0.1:18890"}');
    assert.deepEqual(readAdvancedConfig('ssh', BASE_DIR), { env: {} });
  });

  it('坏项逐项过滤、好项照常生效（手工编辑防御）', () => {
    writeRawFile('{"version": 1, "env": {"GOOD": "1", "BAD KEY": "x"},'
      + ' "jumpHosts": [{"target": "jump1"}, {"target": ""}]}');
    assert.deepEqual(readAdvancedConfig('ssh', BASE_DIR), {
      env: { GOOD: '1' },
      jumpHosts: [{ target: 'jump1' }],
    });
  });

  it('非法 proxy 读取侧跳过', () => {
    writeRawFile('{"version": 1, "env": {}, "proxy": "http://h/p"}');
    assert.deepEqual(readAdvancedConfig('ssh', BASE_DIR), { env: {} });
  });

  it('jumpHosts 非数组形态跳过', () => {
    writeRawFile('{"version": 1, "env": {}, "jumpHosts": "jump1"}');
    assert.deepEqual(readAdvancedConfig('ssh', BASE_DIR), { env: {} });
  });

  it('手工塞进文件的密码字段读取侧剔除（不落盘约束的读防线）', () => {
    writeRawFile('{"version": 1, "env": {}, "jumpHosts": [{"target": "jump1", "password": "leak"}]}');
    assert.deepEqual(readAdvancedConfig('ssh', BASE_DIR), {
      env: {},
      jumpHosts: [{ target: 'jump1' }],
    });
  });

  it('写侧带密码的条目直接抛错不落盘', () => {
    assert.throws(
      () => writeAdvancedConfig('ssh', {
        env: {},
        // 运行时形状未知，故意带 password 模拟绕过类型层的调用方
        jumpHosts: [{ target: 'jump1', password: 'secret' } as never],
      }, BASE_DIR),
      /不落盘/,
    );
  });

  it('v2 的 wsl 域缺 env 或形状不对按空处理（域内 proxy/jumpHosts 忽略）', () => {
    writeRawFile('{"version": 2, "ssh": {"env": {"SSH_VAR": "1"}}, "wsl": "bad"}');
    assert.deepEqual(readAdvancedConfig('wsl', BASE_DIR), { env: {} });
    writeRawFile('{"version": 2, "ssh": {"env": {}}, "wsl": {"proxy": "http://127.0.0.1:18890"}}');
    assert.deepEqual(readAdvancedConfig('wsl', BASE_DIR), { env: {} });
    // wsl 域手工塞的坏 env 键跳过、好键生效
    writeRawFile('{"version": 2, "ssh": {"env": {}}, "wsl": {"env": {"GOOD": "1", "BAD KEY": "x"}}}');
    assert.deepEqual(readAdvancedConfig('wsl', BASE_DIR), { env: { GOOD: '1' } });
  });

  it('v2 的 ssh 域缺省或形状不对按空域处理', () => {
    writeRawFile('{"version": 2, "wsl": {"env": {"WSL_VAR": "1"}}}');
    assert.deepEqual(readAdvancedConfig('ssh', BASE_DIR), { env: {} });
    assert.deepEqual(readAdvancedConfig('wsl', BASE_DIR), { env: { WSL_VAR: '1' } });
    writeRawFile('{"version": 2, "ssh": {"proxy": "http://127.0.0.1:18890"}, "wsl": {"env": {}}}');
    assert.deepEqual(readAdvancedConfig('ssh', BASE_DIR), { env: {} });
  });
});

/**
 * @file plugin/host-env-store.ts 单元测试
 * @description 覆盖 validateHostEnv() 的键名/保留键/控制字符校验，
 *              readHostEnv()/writeHostEnv() 的读写回路、原子落盘结构、
 *              损坏文件容错与坏键过滤。全部走参数化的临时目录
 *              （baseDir），不触碰真实的 ~/.dsh/remote-host-env.json。
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readHostEnv, validateHostEnv, writeHostEnv,
} from '../../src/plugin/host-env-store.js';

/** 每个测试文件独立的临时目录（用例间不复用，避免相互污染） */
const BASE_DIR = mkdtempSync(join(tmpdir(), 'host-env-store-test-'));

/** 落盘文件名（与 host-env-store 的常量同名同值的契约断言用） */
const FILE_NAME = 'remote-host-env.json';

after(() => {
  rmSync(BASE_DIR, { recursive: true, force: true });
});

/**
 * 在临时目录直接手写落盘文件（模拟手工编辑/损坏场景）。
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

// ─── validateHostEnv ─────────────────────────────────────────────────────

describe('validateHostEnv', () => {
  describe('合法输入', () => {
    it('合法键值返回 undefined', () => {
      assert.equal(validateHostEnv({ https_proxy: 'http://127.0.0.1:18890' }), undefined);
      assert.equal(validateHostEnv({ MY_VAR: 'value', ANOTHER_1: 'x' }), undefined);
    });

    it('空对象合法（表示清除配置）', () => {
      assert.equal(validateHostEnv({}), undefined);
    });
  });

  describe('非法键名', () => {
    const illegalKeys = ['BAD KEY', 'A=B', 'X$(cmd)', '1ABC', ''];

    for (const key of illegalKeys) {
      it(`键名 '${key.replaceAll(' ', '␣') || '(空串)'}' 返回错误消息且含键名`, () => {
        const result = validateHostEnv({ [key]: 'value' });
        assert.notEqual(result, undefined);
        assert.ok(result !== undefined && result.includes(key));
      });
    }
  });

  describe('保留键', () => {
    it('DSH_HOME 拒绝', () => {
      const result = validateHostEnv({ DSH_HOME: '/custom' });
      assert.notEqual(result, undefined);
      assert.ok(result !== undefined && result.includes('DSH_HOME'));
    });

    it('DSH_AGENTS_HOME 拒绝', () => {
      const result = validateHostEnv({ DSH_AGENTS_HOME: '/custom' });
      assert.notEqual(result, undefined);
      assert.ok(result !== undefined && result.includes('DSH_AGENTS_HOME'));
    });

    it('PATH 拒绝', () => {
      const result = validateHostEnv({ PATH: '/custom' });
      assert.notEqual(result, undefined);
      assert.ok(result !== undefined && result.includes('PATH'));
    });
  });

  describe('非法值', () => {
    it('值含控制字符（换行）返回错误', () => {
      const result = validateHostEnv({ GOOD_KEY: 'line1\nline2' });
      assert.notEqual(result, undefined);
      assert.ok(result !== undefined && result.includes('GOOD_KEY'));
    });

    it('值含控制字符（NUL）返回错误', () => {
      const result = validateHostEnv({ GOOD_KEY: 'a\x00b' });
      assert.notEqual(result, undefined);
    });

    it('值含 DEL(0x7f) 返回错误', () => {
      const result = validateHostEnv({ GOOD_KEY: 'a\x7fb' });
      assert.notEqual(result, undefined);
    });
  });

  it('多条目时返回第一条错误', () => {
    const result = validateHostEnv({ GOOD: 'x', 'BAD KEY': 'y' });
    assert.ok(result !== undefined && result.includes('BAD KEY'));
  });
});

// ─── readHostEnv / writeHostEnv ──────────────────────────────────────────

describe('readHostEnv / writeHostEnv', () => {
  it('写入后读回一致', () => {
    writeHostEnv('myhost', { https_proxy: 'http://127.0.0.1:18890', MY_VAR: 'value' }, BASE_DIR);
    assert.deepEqual(readHostEnv('myhost', BASE_DIR), {
      https_proxy: 'http://127.0.0.1:18890',
      MY_VAR: 'value',
    });
  });

  it('写一个主机不影响其他主机（读-改-写保留）', () => {
    writeHostEnv('hostA', { A_KEY: 'a' }, BASE_DIR);
    writeHostEnv('hostB', { B_KEY: 'b' }, BASE_DIR);
    assert.deepEqual(readHostEnv('hostA', BASE_DIR), { A_KEY: 'a' });
    assert.deepEqual(readHostEnv('hostB', BASE_DIR), { B_KEY: 'b' });
    // 整组替换：再写 hostA 只剩新键
    writeHostEnv('hostA', { A_KEY2: 'a2' }, BASE_DIR);
    assert.deepEqual(readHostEnv('hostA', BASE_DIR), { A_KEY2: 'a2' });
    assert.deepEqual(readHostEnv('hostB', BASE_DIR), { B_KEY: 'b' });
  });

  it('空对象写入 = 清除该主机条目', () => {
    writeHostEnv('myhost', { K: 'v' }, BASE_DIR);
    writeHostEnv('myhost', {}, BASE_DIR);
    assert.deepEqual(readHostEnv('myhost', BASE_DIR), {});
    // 落盘文件里不再有该主机的条目
    const raw = JSON.parse(readRawFile()) as { hosts: Record<string, unknown> };
    assert.equal(raw.hosts.myhost, undefined);
  });

  it('文件不存在时返回空对象', () => {
    rmSync(join(BASE_DIR, FILE_NAME), { force: true });
    assert.ok(!existsSync(join(BASE_DIR, FILE_NAME)));
    assert.deepEqual(readHostEnv('myhost', BASE_DIR), {});
  });

  it('落盘结构含 version 与 hosts（与 remote-sessions.json 同目录同风格）', () => {
    writeHostEnv('myhost', { K: 'v' }, BASE_DIR);
    const raw = JSON.parse(readRawFile()) as { version: number; hosts: Record<string, { env: Record<string, string> }> };
    assert.equal(raw.version, 1);
    assert.deepEqual(raw.hosts.myhost, { env: { K: 'v' } });
  });
});

// ─── 损坏文件容错 ────────────────────────────────────────────────────────

describe('损坏文件容错', () => {
  it('JSON 非法时回落空对象', () => {
    writeRawFile('{not valid json');
    assert.deepEqual(readHostEnv('myhost', BASE_DIR), {});
  });

  it('顶层不是对象时回落空对象', () => {
    writeRawFile('[1, 2, 3]');
    assert.deepEqual(readHostEnv('myhost', BASE_DIR), {});
  });

  it('hosts 缺失或类型不对时回落空对象', () => {
    writeRawFile('{"version": 1}');
    assert.deepEqual(readHostEnv('myhost', BASE_DIR), {});
    writeRawFile('{"version": 1, "hosts": [1, 2]}');
    assert.deepEqual(readHostEnv('myhost', BASE_DIR), {});
  });

  it('条目形状不对（env 非对象）时该主机回落空对象', () => {
    writeRawFile('{"version": 1, "hosts": {"myhost": {"env": "not-object"}}}');
    assert.deepEqual(readHostEnv('myhost', BASE_DIR), {});
  });
});

// ─── 坏键过滤（手工编辑防线） ───────────────────────────────────────────

describe('坏键读取过滤', () => {
  it('非法键名在读取时被跳过，合法键保留', () => {
    writeRawFile(JSON.stringify({
      version: 1,
      hosts: {
        myhost: {
          env: {
            https_proxy: 'http://127.0.0.1:18890',
            'BAD KEY': 'injection-attempt',
            'X$(cmd)': 'injection-attempt',
          },
        },
      },
    }));
    assert.deepEqual(readHostEnv('myhost', BASE_DIR), {
      https_proxy: 'http://127.0.0.1:18890',
    });
  });

  it('保留键在读取时被跳过', () => {
    writeRawFile(JSON.stringify({
      version: 1,
      hosts: { myhost: { env: { DSH_HOME: '/custom', PATH: '/custom', GOOD: 'x' } } },
    }));
    assert.deepEqual(readHostEnv('myhost', BASE_DIR), { GOOD: 'x' });
  });

  it('值非字符串（手工编辑写入了数字）时该键被跳过', () => {
    writeRawFile(JSON.stringify({
      version: 1,
      hosts: { myhost: { env: { GOOD: 'x', NUMBER: 123 } } },
    }));
    assert.deepEqual(readHostEnv('myhost', BASE_DIR), { GOOD: 'x' });
  });

  it('值含控制字符时该键被跳过', () => {
    writeRawFile(JSON.stringify({
      version: 1,
      hosts: { myhost: { env: { GOOD: 'x', CTRL: 'a\nb' } } },
    }));
    assert.deepEqual(readHostEnv('myhost', BASE_DIR), { GOOD: 'x' });
  });
});

// ─── 写入校验双保险 ──────────────────────────────────────────────────────

describe('writeHostEnv 校验双保险', () => {
  it('非法键名在写入时被拒绝（绕过路由层直接调用）', () => {
    assert.throws(
      () => writeHostEnv('myhost', { 'BAD=KEY': 'v' }, BASE_DIR),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes('BAD=KEY'));
        return true;
      },
    );
  });

  it('保留键在写入时被拒绝', () => {
    assert.throws(
      () => writeHostEnv('myhost', { DSH_HOME: '/custom' }, BASE_DIR),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes('DSH_HOME'));
        return true;
      },
    );
  });

  it('控制字符值在写入时被拒绝', () => {
    assert.throws(
      () => writeHostEnv('myhost', { GOOD: 'a\nb' }, BASE_DIR),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes('GOOD'));
        return true;
      },
    );
  });

  it('拒绝的写入不落盘（文件内容不变）', () => {
    writeHostEnv('myhost', { GOOD: 'x' }, BASE_DIR);
    const before = readRawFile();
    assert.throws(() => writeHostEnv('myhost', { 'BAD KEY': 'v' }, BASE_DIR));
    assert.equal(readRawFile(), before);
  });
});

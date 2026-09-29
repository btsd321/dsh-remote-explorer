/**
 * @file credential/proxy-secret.ts 单元测试
 * @description 覆盖凭据材料的读回（reverse-host 缺失/非法回落 127.0.0.1）、
 *              令牌与端口的成立条件、writeProxySecret 的落盘形状、
 *              writeSessionReverseHost 的单行写入与失败不静默契约。
 *
 * 远端文件系统用桩传输模拟：只解释 proxy-secret 产生的脚本形状
 * （存在性守卫 / cat 读回 / printf 写入），不依赖任何真实远端。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRemotePaths } from '../../src/provision/remote-paths.js';
import type { RemoteContext } from '../../src/provision/remote-context.js';
import type { ExecOptions, ExecResult, RemoteTransport } from '../../src/transport/types.js';
import { RemoteError } from '../../src/util/errors.js';
import {
  readProxySecret, writeProxySecret, writeSessionReverseHost,
} from '../../src/credential/proxy-secret.js';

/** 测试会话 id */
const SESSION_ID = 's-test';

/**
 * 模拟远端文件系统的桩传输。
 *
 * exec 只识别 proxy-secret 产生的三类脚本行：
 * - `[ -f A ] && [ -f B ] || exit 0`（存在性守卫）
 * - `printf 'KEY=%s\n' "$(cat FILE)"`（读回，reverse-host 带兜底回显）
 * - `printf '%s[\n]' VALUE > FILE`（写入）
 * 其余能力（SFTP/通道等）一律不支持——本测试只关心材料读写。
 *
 * 退出码语义与真实传输对齐：非零退出且调用方未设 allowNonZeroExit 时抛
 * RemoteError('EXEC_FAILED')——writeSessionReverseHost 的「写失败不静默」
 * 正是建立在这条契约上。
 */
class FakeSecretTransport implements RemoteTransport {
  readonly hostAlias = 'fake-host';
  readonly platform = { os: 'linux', arch: 'x64', rawOs: 'Linux', rawArch: 'x86_64' } as const;
  readonly isAlive = true;

  /** 远端文件内容（路径 → 内容） */
  readonly files = new Map<string, string>();

  /** 置 true 时写入行返回非零退出码（模拟写失败，验证不静默契约） */
  failWrites = false;

  async connect(): Promise<void> { /* 桩：无需连接 */ }

  async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    const result = this.run(command);
    if (result.exitCode !== 0 && options?.allowNonZeroExit !== true) {
      throw new RemoteError('EXEC_FAILED', `命令执行失败（桩模拟，退出码 ${result.exitCode}）`);
    }
    return result;
  }

  /** 解释脚本行（exec 的核心，不含退出码→异常的契约层） */
  private run(command: string): ExecResult {
    let out = '';
    for (const raw of command.split('\n')) {
      const line = raw.trim();
      if (line === '' || line === 'umask 077') continue;

      // 存在性守卫：缺任一文件时脚本以 0 退出且不再产出（真实语义）
      const guard = /^\[ -f (\S+) \] && \[ -f (\S+) \] \|\| exit 0$/.exec(line);
      if (guard !== null) {
        if (!this.files.has(guard[1]!) || !this.files.has(guard[2]!)) {
          return { stdout: out, stderr: '', exitCode: 0 };
        }
        continue;
      }

      // 读回行：`printf 'TOKEN=%s\n' "$(cat FILE)"`（HOST 带缺失兜底）
      const read = /^printf '(TOKEN|PORT|HOST)=%s\\n' "\$\(cat (\S+)(?: 2>\/dev\/null \|\| echo (\S+))?\)"$/.exec(line);
      if (read !== null) {
        const key = read[1]!;
        const path = read[2]!;
        const fallback = read[3];
        const value = this.files.has(path) ? this.files.get(path)! : fallback ?? '';
        // $(cat ...) 会吞尾随换行，与真实 shell 语义对齐
        out += `${key}=${value.trim()}\n`;
        continue;
      }

      // 写入行：`printf '%s' VALUE > FILE` / `printf '%s\n' VALUE > FILE`
      const write = /^printf '%s(\\n)?' (\S+) > (\S+)$/.exec(line);
      if (write !== null) {
        if (this.failWrites) {
          return { stdout: out, stderr: '模拟写失败', exitCode: 1 };
        }
        this.files.set(write[3]!, write[2]! + (write[1] === undefined ? '' : '\n'));
        continue;
      }

      throw new Error(`桩传输不认识的命令行: ${line}`);
    }
    return { stdout: out, stderr: '', exitCode: 0 };
  }

  // 以下能力与凭据材料读写无关，一律显式不支持
  async uploadFile(): Promise<void> { throw new Error('桩不支持 uploadFile'); }
  async uploadFiles(): Promise<void> { throw new Error('桩不支持 uploadFiles'); }
  async writeRemoteFile(): Promise<void> { throw new Error('桩不支持 writeRemoteFile'); }
  async readRemoteFile(): Promise<Buffer> { throw new Error('桩不支持 readRemoteFile'); }
  async checkSftp(): Promise<void> { throw new Error('桩不支持 checkSftp'); }
  async openChannel(): Promise<never> { throw new Error('桩不支持 openChannel'); }
  async dispose(): Promise<void> { /* 桩：无需清理 */ }
}

/**
 * 构造测试上下文（桩传输 + 固定家目录的路径集合）。
 *
 * @param transport - 桩传输
 * @returns 远端执行上下文
 */
function ctxOf(transport: FakeSecretTransport): RemoteContext {
  return { transport, paths: createRemotePaths('/home/youruser') };
}

/**
 * 预置一份完整的凭据材料。
 *
 * @param transport - 桩传输
 * @param host - 反向端点主机；undefined 时不写 reverse-host 文件
 */
function seedSecret(transport: FakeSecretTransport, host?: string): void {
  const paths = createRemotePaths('/home/youruser');
  transport.files.set(paths.sessionProxyTokenFile(SESSION_ID), 'tok_0123456789abcdef');
  transport.files.set(paths.sessionReversePortFile(SESSION_ID), '47123');
  if (host !== undefined) {
    transport.files.set(paths.sessionReverseHostFile(SESSION_ID), `${host}\n`);
  }
}

// ─── readProxySecret ──────────────────────────────────────────────────────

describe('readProxySecret', () => {
  it('完整材料读回 token/端口/host', async () => {
    const transport = new FakeSecretTransport();
    seedSecret(transport, '172.30.96.1');
    const secret = await readProxySecret(ctxOf(transport), SESSION_ID);
    assert.deepEqual(secret, {
      token: 'tok_0123456789abcdef',
      reversePort: 47123,
      reverseHost: '172.30.96.1',
    });
  });

  it('reverse-host 缺失时回落 127.0.0.1（SSH 会话契约）', async () => {
    const transport = new FakeSecretTransport();
    seedSecret(transport);
    const secret = await readProxySecret(ctxOf(transport), SESSION_ID);
    assert.equal(secret?.reverseHost, '127.0.0.1');
  });

  it('reverse-host 内容非法时回落 127.0.0.1（损坏文件防线）', async () => {
    const transport = new FakeSecretTransport();
    seedSecret(transport);
    const paths = createRemotePaths('/home/youruser');
    transport.files.set(paths.sessionReverseHostFile(SESSION_ID), 'garbage; rm -rf /\n');
    const secret = await readProxySecret(ctxOf(transport), SESSION_ID);
    assert.equal(secret?.reverseHost, '127.0.0.1');
  });

  it('reverse-host 非法不影响令牌与端口的成立', async () => {
    const transport = new FakeSecretTransport();
    seedSecret(transport, '999.999.999.999');
    const secret = await readProxySecret(ctxOf(transport), SESSION_ID);
    assert.notEqual(secret, undefined);
    assert.equal(secret?.reversePort, 47123);
    assert.equal(secret?.reverseHost, '127.0.0.1');
  });

  it('token 或端口文件缺失时整体 undefined（触发重新生成）', async () => {
    const paths = createRemotePaths('/home/youruser');

    const noToken = new FakeSecretTransport();
    noToken.files.set(paths.sessionReversePortFile(SESSION_ID), '47123');
    noToken.files.set(paths.sessionReverseHostFile(SESSION_ID), '172.30.96.1\n');
    assert.equal(await readProxySecret(ctxOf(noToken), SESSION_ID), undefined);

    const noPort = new FakeSecretTransport();
    noPort.files.set(paths.sessionProxyTokenFile(SESSION_ID), 'tok');
    noPort.files.set(paths.sessionReverseHostFile(SESSION_ID), '172.30.96.1\n');
    assert.equal(await readProxySecret(ctxOf(noPort), SESSION_ID), undefined);
  });

  it('端口越界或非数字时整体 undefined', async () => {
    for (const bad of ['0', '70000', 'not-a-port', '-1']) {
      const transport = new FakeSecretTransport();
      seedSecret(transport);
      const paths = createRemotePaths('/home/youruser');
      transport.files.set(paths.sessionReversePortFile(SESSION_ID), bad);
      const secret = await readProxySecret(ctxOf(transport), SESSION_ID);
      assert.equal(secret, undefined, `端口 ${bad} 应判非法`);
    }
  });
});

// ─── writeProxySecret ─────────────────────────────────────────────────────

describe('writeProxySecret', () => {
  it('写入令牌与端口（不带换行），可与读回闭环', async () => {
    const transport = new FakeSecretTransport();
    const paths = createRemotePaths('/home/youruser');
    const secret = {
      token: 'tok_0123456789abcdef',
      reversePort: 47_123,
      reverseHost: '172.30.96.1',
    };
    await writeProxySecret(ctxOf(transport), SESSION_ID, secret);

    // 只写令牌与端口——reverse-host 是每次连接重写的派生材料，不在此落盘
    assert.equal(transport.files.get(paths.sessionProxyTokenFile(SESSION_ID)), 'tok_0123456789abcdef');
    assert.equal(transport.files.get(paths.sessionReversePortFile(SESSION_ID)), '47123');
    assert.equal(transport.files.has(paths.sessionReverseHostFile(SESSION_ID)), false);

    const readBack = await readProxySecret(ctxOf(transport), SESSION_ID);
    assert.equal(readBack?.token, 'tok_0123456789abcdef');
    assert.equal(readBack?.reversePort, 47123);
    assert.equal(readBack?.reverseHost, '127.0.0.1', '未写 reverse-host 时读回落默认值');
  });
});

// ─── writeSessionReverseHost ──────────────────────────────────────────────

describe('writeSessionReverseHost', () => {
  it('写入单行主机地址（带尾随换行）', async () => {
    const transport = new FakeSecretTransport();
    const paths = createRemotePaths('/home/youruser');
    await writeSessionReverseHost(ctxOf(transport), SESSION_ID, '172.30.96.1');
    assert.equal(transport.files.get(paths.sessionReverseHostFile(SESSION_ID)), '172.30.96.1\n');
  });

  it('写入后 readProxySecret 读回同值（完整闭环）', async () => {
    const transport = new FakeSecretTransport();
    seedSecret(transport);
    await writeSessionReverseHost(ctxOf(transport), SESSION_ID, '172.30.96.1');
    const secret = await readProxySecret(ctxOf(transport), SESSION_ID);
    assert.equal(secret?.reverseHost, '172.30.96.1');
  });

  it('重写覆盖旧值（每次连接重写的契约）', async () => {
    const transport = new FakeSecretTransport();
    const paths = createRemotePaths('/home/youruser');
    await writeSessionReverseHost(ctxOf(transport), SESSION_ID, '172.30.96.1');
    await writeSessionReverseHost(ctxOf(transport), SESSION_ID, '172.31.0.1');
    assert.equal(transport.files.get(paths.sessionReverseHostFile(SESSION_ID)), '172.31.0.1\n');
  });

  it('非法主机抛错（写入前收口）', async () => {
    const transport = new FakeSecretTransport();
    await assert.rejects(
      () => writeSessionReverseHost(ctxOf(transport), SESSION_ID, 'not-an-ip'),
      /IPv4/,
    );
    await assert.rejects(
      () => writeSessionReverseHost(ctxOf(transport), SESSION_ID, '256.1.1.1'),
      /IPv4/,
    );
  });

  it('写失败不静默（异常上抛）', async () => {
    const transport = new FakeSecretTransport();
    transport.failWrites = true;
    await assert.rejects(
      () => writeSessionReverseHost(ctxOf(transport), SESSION_ID, '172.30.96.1'),
      /失败|EXEC/i,
    );
  });
});

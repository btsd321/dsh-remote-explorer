/**
 * @file hosts/ssh-config-parser.ts 单元测试
 * @description 覆盖 SSH config 解析器的公共 API 行为：Host 别名解析与合并语义、
 *              ProxyJump 跳板链（单跳/多跳/递归/循环防护）、user@host[:port]
 *              直连语法分流、端口校验、Host 通配模式匹配、tilde 展开、
 *              认证覆盖优先级、面板跳板链、assertConnectable 校验与 listHosts。
 *
 *              config 路径经 setConfigPath 钩子指向临时目录中的 fixture 文件
 *              （node:os tmpdir + 唯一子目录），测试结束统一清理；不做任何
 *              真实网络/SSH 操作。断言只针对公共 API 的行为，不触及内部实现。
 *
 *              环境假设：node:test 以子进程管道方式运行测试文件，
 *              isInteractiveTerminal() 为 false（非交互终端）——
 *              assertConnectable 的密码兜底分支按此语义断言。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import {
  setConfigPath,
  resolveHost,
  resolveHostWithAuth,
  resolveJumpChain,
  assertConnectable,
  listHosts,
  isConfigHost,
} from '../../src/hosts/ssh-config-parser.js';
import type { ResolvedHost, ResolvedHostWithJump } from '../../src/hosts/ssh-config-parser.js';
import { RemoteError } from '../../src/util/errors.js';

// ─── fixture 基础设施 ──────────────────────────────────────────────────────

/** 测试用临时目录：所有 fixture config 文件都写在这里，结束后整目录删除 */
let tmpDir: string;

/** fixture 序号：保证每个用例拿到独立文件名，用例间互不共享缓存状态 */
let fixtureSeq = 0;

before(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ssh-config-parser-test-'));
});

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * 写一份 fixture config 并设为当前解析目标。
 *
 * 每次调用生成新文件名：setConfigPath 自带缓存失效，独立文件名进一步
 * 保证任何遗漏 refreshConfig 的用例也不会读到上一个用例的旧缓存。
 *
 * @param text - config 文件内容（SSH config 语法）
 */
function useConfig(text: string): void {
  fixtureSeq += 1;
  const file = join(tmpDir, `config-${fixtureSeq}.conf`);
  writeFileSync(file, text, 'utf8');
  setConfigPath(file);
}

/**
 * 在临时目录写一个任意名字的文件（Include 子文件等场景）。
 *
 * @param name - 文件名
 * @param text - 文件内容
 * @returns 文件绝对路径
 */
function writeFixture(name: string, text: string): string {
  const file = join(tmpDir, name);
  writeFileSync(file, text, 'utf8');
  return file;
}

/** 基础 fixture：一个字段齐全的主机，供多个用例复用的内容模板 */
const BASIC_CONFIG = [
  'Host alpha',
  '  HostName alpha.example.com',
  '  User auser',
  '  Port 2222',
  '  IdentityFile ~/.ssh/alpha_key',
  '',
].join('\n');

/** 断言抛出的是携带指定错误码的 RemoteError */
function assertRemoteError(fn: () => unknown, code: string, messagePart?: string): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof RemoteError, `应抛 RemoteError，实际 ${String(err)}`);
    assert.equal(err.code, code);
    if (messagePart !== undefined) {
      assert.ok(
        err.message.includes(messagePart),
        `错误消息应含「${messagePart}」，实际：「${err.message}」`,
      );
    }
    return true;
  });
}

// ─── Host 别名解析基础 ─────────────────────────────────────────────────────

describe('Host 别名解析基础', () => {
  it('HostName/User/Port 合并到完整连接配置', () => {
    useConfig(BASIC_CONFIG);
    const { target, jumpHosts } = resolveHost('alpha');
    assert.deepEqual(target, {
      host: 'alpha.example.com',
      port: 2222,
      username: 'auser',
      identityFile: join(homedir(), '.ssh', 'alpha_key'),
    });
    assert.deepEqual(jumpHosts, []);
  });

  it('未配置 Port 时回落默认 22', () => {
    useConfig('Host noport\n  HostName noport.example.com\n  User u\n');
    assert.equal(resolveHost('noport').target.port, 22);
  });

  it('未配置 HostName 时用别名本身作为地址（与 ssh 行为一致）', () => {
    useConfig('Host bare\n  User u\n');
    assert.equal(resolveHost('bare').target.host, 'bare');
  });

  it('未配置 User 时 username 为空串', () => {
    useConfig('Host nouser\n  HostName nouser.example.com\n');
    assert.equal(resolveHost('nouser').target.username, '');
  });

  it('多个 IdentityFile 取第一个', () => {
    useConfig([
      'Host multi',
      '  HostName multi.example.com',
      '  User u',
      '  IdentityFile ~/.ssh/first',
      '  IdentityFile ~/.ssh/second',
      '',
    ].join('\n'));
    assert.equal(resolveHost('multi').target.identityFile, join(homedir(), '.ssh', 'first'));
  });

  it('指令大小写不敏感（hostName 小写写法同样生效）', () => {
    useConfig('Host lower\n  hostname lower.example.com\n  user lu\n  port 2200\n');
    const { target } = resolveHost('lower');
    assert.equal(target.host, 'lower.example.com');
    assert.equal(target.username, 'lu');
    assert.equal(target.port, 2200);
  });

  it('config 不存在该别名且不匹配直连语法时抛 HOST_NOT_FOUND', () => {
    useConfig(BASIC_CONFIG);
    assertRemoteError(() => resolveHost('ghost'), 'HOST_NOT_FOUND', 'ghost');
  });
});

// ─── Host * 通配默认值合并 ─────────────────────────────────────────────────

describe('Host * 通配默认值合并', () => {
  it('具体条目与 Host * 默认值合并（compute 语义）', () => {
    useConfig([
      'Host target',
      '  HostName target.example.com',
      'Host *',
      '  User staruser',
      '  IdentityFile ~/.ssh/star_key',
      '',
    ].join('\n'));
    const { target } = resolveHost('target');
    assert.equal(target.host, 'target.example.com');
    assert.equal(target.username, 'staruser');
    assert.equal(target.identityFile, join(homedir(), '.ssh', 'star_key'));
  });

  it('具体条目的字段覆盖 Host * 默认值', () => {
    useConfig([
      'Host target',
      '  HostName target.example.com',
      '  User specific',
      'Host *',
      '  User staruser',
      '',
    ].join('\n'));
    assert.equal(resolveHost('target').target.username, 'specific');
  });

  it('只有 Host * 时任意别名都判不存在（防「缺字段」误报）', () => {
    // Host * 会让任意别名的 compute() 返回一份只含默认值的结果；
    // 此处必须报 HOST_NOT_FOUND 而不是「缺 User/IdentityFile」，
    // 否则用户会被引向错误的排查方向
    useConfig('Host *\n  User staruser\n');
    assertRemoteError(() => resolveHost('anything'), 'HOST_NOT_FOUND', 'anything');
  });
});

// ─── user@host[:port] 直连语法 ─────────────────────────────────────────────

describe('user@host[:port] 直连语法', () => {
  it('user@host 解析为直连主机（默认端口 22，无跳板）', () => {
    useConfig('Host unrelated\n  HostName unrelated.example.com\n');
    const { target, jumpHosts } = resolveHost('bob@example.com');
    assert.deepEqual(target, { host: 'example.com', port: 22, username: 'bob' });
    assert.deepEqual(jumpHosts, []);
  });

  it('user@host:port 解析端口', () => {
    useConfig('Host unrelated\n  HostName unrelated.example.com\n');
    assert.deepEqual(resolveHost('bob@example.com:2222').target, {
      host: 'example.com',
      port: 2222,
      username: 'bob',
    });
  });

  it('config 中存在同形态 Host 别名时 config 优先于直连解析', () => {
    useConfig([
      'Host bob@example.com',
      '  HostName real.example.com',
      '  User realbob',
      '  Port 2200',
      '',
    ].join('\n'));
    const { target } = resolveHost('bob@example.com');
    assert.equal(target.host, 'real.example.com');
    assert.equal(target.username, 'realbob');
    assert.equal(target.port, 2200);
  });

  it('isConfigHost 区分 config 主机与直连/未知标识', () => {
    useConfig([
      'Host bob@example.com',
      '  HostName real.example.com',
      'Host plain',
      '  HostName plain.example.com',
      '',
    ].join('\n'));
    assert.equal(isConfigHost('bob@example.com'), true);
    assert.equal(isConfigHost('plain'), true);
    assert.equal(isConfigHost('alice@example.com'), false, '直连语法不是 config 主机');
    assert.equal(isConfigHost('ghost'), false, '未知标识不是 config 主机');
  });

  it('裸主机名（无 @）不走直连语法，未知时抛 HOST_NOT_FOUND', () => {
    useConfig('Host unrelated\n  HostName unrelated.example.com\n');
    assertRemoteError(() => resolveHost('plainhost'), 'HOST_NOT_FOUND', 'plainhost');
  });

  it('缺用户名或缺主机不匹配直连语法', () => {
    useConfig('Host unrelated\n  HostName unrelated.example.com\n');
    assertRemoteError(() => resolveHost('@example.com'), 'HOST_NOT_FOUND');
    assertRemoteError(() => resolveHost('bob@'), 'HOST_NOT_FOUND');
  });

  it('含空格或多 @ 的标识不匹配直连语法', () => {
    useConfig('Host unrelated\n  HostName unrelated.example.com\n');
    assertRemoteError(() => resolveHost('bob@ example.com'), 'HOST_NOT_FOUND');
    assertRemoteError(() => resolveHost('a@b@c'), 'HOST_NOT_FOUND');
  });
});

// ─── 端口校验与规范化 ──────────────────────────────────────────────────────

describe('端口校验与规范化', () => {
  it('直连语法端口 0 被拒绝', () => {
    useConfig('Host unrelated\n  HostName unrelated.example.com\n');
    assertRemoteError(() => resolveHost('bob@example.com:0'), 'HOST_CONFIG_INVALID', '端口');
  });

  it('直连语法端口 65536 与超大值被拒绝', () => {
    useConfig('Host unrelated\n  HostName unrelated.example.com\n');
    assertRemoteError(() => resolveHost('bob@example.com:65536'), 'HOST_CONFIG_INVALID');
    assertRemoteError(() => resolveHost('bob@example.com:99999'), 'HOST_CONFIG_INVALID');
  });

  it('端口边界值 1 与 65535 合法', () => {
    useConfig('Host unrelated\n  HostName unrelated.example.com\n');
    assert.equal(resolveHost('bob@example.com:1').target.port, 1);
    assert.equal(resolveHost('bob@example.com:65535').target.port, 65_535);
  });

  it('端口前导零被规范化为整数值', () => {
    useConfig('Host unrelated\n  HostName unrelated.example.com\n');
    assert.equal(resolveHost('bob@example.com:0022').target.port, 22);
  });

  it('端口含非数字字符时不识别为端口，整体并入主机名（当前行为）', () => {
    // 现状：AD_HOC_HOST_RE 的端口捕获组要求纯数字，「:22abc」不满足时
    // lazy 的 host 段会把「example.com:22abc」整体吞下——记录实际行为
    // 供回归防护（OpenSSH 对非法端口是拒绝而非静默并入主机名）
    useConfig('Host unrelated\n  HostName unrelated.example.com\n');
    const { target } = resolveHost('bob@example.com:22abc');
    assert.equal(target.host, 'example.com:22abc');
    assert.equal(target.port, 22);
  });

  it('config 内非法端口值原样透传为 NaN（当前行为，疑似缺陷见测试报告）', () => {
    // 现状：toResolvedHost 对 config 的 Port 只做 parseInt，不做值域校验，
    // 「Port notanumber」得到 NaN 而非报错——记录实际行为供回归防护
    useConfig('Host badport\n  HostName badport.example.com\n  Port notanumber\n');
    const port = resolveHost('badport').target.port;
    assert.ok(Number.isNaN(port), `预期 NaN，实际 ${String(port)}`);
  });
});

// ─── ProxyJump 跳板链 ──────────────────────────────────────────────────────

/** 跳板链测试的基础 fixture：目标 + 两台独立跳板机 */
const JUMP_CONFIG = [
  'Host target',
  '  HostName target.example.com',
  '  User tuser',
  '  ProxyJump j1',
  'Host j1',
  '  HostName j1.example.com',
  '  User juser',
  '  Port 2201',
  'Host j2',
  '  HostName j2.example.com',
  '  User j2user',
  '  Port 2202',
  '',
].join('\n');

describe('ProxyJump 跳板链', () => {
  it('单跳：跳板机的 HostName/User/Port 完整解析', () => {
    useConfig(JUMP_CONFIG);
    const { target, jumpHosts } = resolveHost('target');
    assert.equal(target.proxyJump, 'j1');
    assert.deepEqual(jumpHosts, [{ host: 'j1.example.com', port: 2201, username: 'juser' }]);
  });

  it('多跳：逗号分隔按顺序展开', () => {
    useConfig([
      'Host target',
      '  HostName target.example.com',
      '  ProxyJump j1,j2',
      'Host j1',
      '  HostName j1.example.com',
      'Host j2',
      '  HostName j2.example.com',
      '',
    ].join('\n'));
    const { jumpHosts } = resolveHost('target');
    assert.deepEqual(
      jumpHosts.map(j => j.host),
      ['j1.example.com', 'j2.example.com'],
    );
  });

  it('多跳：逗号后带空格同样容忍', () => {
    useConfig([
      'Host target',
      '  HostName target.example.com',
      '  ProxyJump j1, j2',
      'Host j1',
      '  HostName j1.example.com',
      'Host j2',
      '  HostName j2.example.com',
      '',
    ].join('\n'));
    assert.equal(resolveHost('target').jumpHosts.length, 2);
  });

  it('递归：跳板机自身的 ProxyJump 链前置展开（最外层跳板在最前）', () => {
    useConfig([
      'Host target',
      '  HostName target.example.com',
      '  ProxyJump j1',
      'Host j1',
      '  HostName j1.example.com',
      '  User juser',
      '  ProxyJump j0',
      'Host j0',
      '  HostName j0.example.com',
      '  Port 2200',
      '',
    ].join('\n'));
    const { jumpHosts } = resolveHost('target');
    assert.deepEqual(
      jumpHosts.map(j => `${j.username}@${j.host}:${j.port}`),
      ['@j0.example.com:2200', 'juser@j1.example.com:22'],
    );
  });

  it('循环引用不死循环：目标与跳板互指时链只保留一个跳板', () => {
    useConfig([
      'Host target',
      '  HostName target.example.com',
      '  ProxyJump j1',
      'Host j1',
      '  HostName j1.example.com',
      '  ProxyJump target',
      '',
    ].join('\n'));
    const { jumpHosts } = resolveHost('target');
    assert.deepEqual(jumpHosts.map(j => j.host), ['j1.example.com']);
  });

  it('未知跳板别名被静默跳过（当前行为：不报错不留链）', () => {
    // 现状：collectJumpHosts 对无 HostName/Host 的别名直接 return，
    // 用户 config 里写错跳板名不会得到任何提示——记录实际行为供回归防护
    useConfig('Host target\n  HostName target.example.com\n  ProxyJump ghost\n');
    const { target, jumpHosts } = resolveHost('target');
    assert.equal(target.proxyJump, 'ghost');
    assert.deepEqual(jumpHosts, []);
  });

  it('跳板机 HostName 未配置时用别名作为地址', () => {
    useConfig([
      'Host target',
      '  HostName target.example.com',
      '  ProxyJump barejump',
      'Host barejump',
      '  User ju',
      '',
    ].join('\n'));
    assert.deepEqual(
      resolveHost('target').jumpHosts.map(j => j.host),
      ['barejump'],
    );
  });
});

// ─── Host 通配模式匹配 ─────────────────────────────────────────────────────

describe('Host 通配模式匹配', () => {
  /** 通配测试 fixture：* 与 ? 模式各一个，外加通配默认块 */
  const WILDCARD_CONFIG = [
    'Host dev-*',
    '  HostName dev.example.com',
    '  User devuser',
    'Host ?bc',
    '  HostName qmark.example.com',
    'Host prod',
    '  HostName prod.example.com',
    'Host *',
    '  User star',
    '',
  ].join('\n');

  it('* 匹配任意多字符前缀', () => {
    useConfig(WILDCARD_CONFIG);
    assert.equal(isConfigHost('dev-web'), true);
    assert.equal(isConfigHost('dev-'), true);
  });

  it('* 不匹配缺前缀的别名', () => {
    useConfig(WILDCARD_CONFIG);
    assert.equal(isConfigHost('devx'), false);
  });

  it('? 恰好匹配单个字符', () => {
    useConfig(WILDCARD_CONFIG);
    assert.equal(isConfigHost('abc'), true);
    assert.equal(isConfigHost('aabc'), false, '两个字符不匹配单个 ?');
    assert.equal(isConfigHost('bc'), false, '缺字符不匹配');
  });

  it('模式匹配大小写不敏感', () => {
    useConfig(WILDCARD_CONFIG);
    assert.equal(isConfigHost('DEV-WEB'), true, '与 ssh 一致的大小写不敏感匹配');
  });

  it('通配命中的别名按该模式条目解析配置', () => {
    useConfig(WILDCARD_CONFIG);
    const { target } = resolveHost('dev-web');
    assert.equal(target.host, 'dev.example.com');
    assert.equal(target.username, 'devuser');
  });

  it('Host * 不作为「别名存在」的依据', () => {
    useConfig(WILDCARD_CONFIG);
    assert.equal(isConfigHost('ghost'), false);
    assertRemoteError(() => resolveHost('ghost'), 'HOST_NOT_FOUND', 'ghost');
  });

  it('多模式 Host 行的每个模式都是独立条目', () => {
    useConfig('Host a b\n  HostName multi.example.com\n');
    assert.equal(isConfigHost('a'), true);
    assert.equal(isConfigHost('b'), true);
    assert.equal(isConfigHost('c'), false);
  });
});

// ─── tilde 展开 ────────────────────────────────────────────────────────────

describe('tilde 展开', () => {
  it('IdentityFile 的 ~/ 前缀展开为家目录', () => {
    useConfig('Host t\n  HostName t.example.com\n  IdentityFile ~/.ssh/id_ed25519\n');
    assert.equal(resolveHost('t').target.identityFile, join(homedir(), '.ssh', 'id_ed25519'));
  });

  it('IdentityFile 单独的 ~ 展开为家目录本身', () => {
    useConfig('Host t\n  HostName t.example.com\n  IdentityFile ~\n');
    assert.equal(resolveHost('t').target.identityFile, homedir());
  });

  it('非 tilde 路径原样保留', () => {
    useConfig('Host t\n  HostName t.example.com\n  IdentityFile /etc/ssh/keys/static\n');
    assert.equal(resolveHost('t').target.identityFile, '/etc/ssh/keys/static');
  });

  it('认证覆盖的 privateKey ~/ 前缀同样展开', () => {
    useConfig('Host t\n  HostName t.example.com\n  User u\n');
    const { target } = resolveHostWithAuth('t', { privateKey: '~/keys/override' });
    assert.equal(target.identityFile, join(homedir(), 'keys', 'override'));
  });
});

// ─── 认证覆盖（resolveHostWithAuth） ───────────────────────────────────────

describe('认证覆盖 resolveHostWithAuth', () => {
  /** 认证覆盖 fixture：目标带 config 私钥与单跳跳板 */
  const AUTH_CONFIG = [
    'Host alpha',
    '  HostName alpha.example.com',
    '  User auser',
    '  IdentityFile ~/.ssh/config_key',
    '  ProxyJump j1',
    'Host j1',
    '  HostName j1.example.com',
    '  User juser',
    '  IdentityFile ~/.ssh/jump_key',
    '',
  ].join('\n');

  it('privateKey 覆盖 config 的 IdentityFile', () => {
    useConfig(AUTH_CONFIG);
    const { target } = resolveHostWithAuth('alpha', { privateKey: '/keys/cli_key' });
    assert.equal(target.identityFile, '/keys/cli_key');
  });

  it('password 显式给出时删除 config 的 IdentityFile（走密码认证）', () => {
    useConfig(AUTH_CONFIG);
    const { target } = resolveHostWithAuth('alpha', { password: 'secret' });
    assert.equal('identityFile' in target, false, '应删除私钥字段而非留 undefined');
    assert.equal('password' in target, false, '密码不落 target（由传输层持有）');
  });

  it('privateKey 与 password 同给时私钥优先', () => {
    useConfig(AUTH_CONFIG);
    const { target } = resolveHostWithAuth('alpha', { privateKey: '/keys/k', password: 'secret' });
    assert.equal(target.identityFile, '/keys/k');
  });

  it('无覆盖时保持 config 解析结果原样', () => {
    useConfig(AUTH_CONFIG);
    const { target } = resolveHostWithAuth('alpha', {});
    assert.equal(target.identityFile, join(homedir(), '.ssh', 'config_key'));
  });

  it('覆盖只作用于目标主机，跳板机维持 config 原样', () => {
    useConfig(AUTH_CONFIG);
    const { jumpHosts } = resolveHostWithAuth('alpha', { privateKey: '/keys/cli_key' });
    assert.equal(jumpHosts[0]?.identityFile, join(homedir(), '.ssh', 'jump_key'));
  });
});

// ─── 面板跳板链（resolveJumpChain） ────────────────────────────────────────

describe('resolveJumpChain 面板跳板链', () => {
  /** 面板跳板 fixture：一台带自身跳板链的 config 跳板 + 独立跳板 */
  const PANEL_CONFIG = [
    'Host t-jump',
    '  HostName tjump.example.com',
    '  User tjumpuser',
    '  Port 2210',
    '  IdentityFile ~/.ssh/tjump_key',
    'Host via1',
    '  HostName via1.example.com',
    '  User via1user',
    '  ProxyJump t-jump',
    '',
  ].join('\n');

  it('直连语法的条目解析为跳板（含条目级私钥覆盖）', () => {
    useConfig('Host unrelated\n  HostName unrelated.example.com\n');
    const chain = resolveJumpChain([{ target: 'user@panel.example.com:2222', identityFile: '/keys/panel.pem' }]);
    assert.deepEqual(chain, [{
      host: 'panel.example.com',
      port: 2222,
      username: 'user',
      identityFile: '/keys/panel.pem',
    }]);
  });

  it('config 别名条目展平其自身 ProxyJump 链（前置跳板在前）', () => {
    useConfig(PANEL_CONFIG);
    const chain = resolveJumpChain([{ target: 'via1' }]);
    assert.deepEqual(
      chain.map(j => `${j.username}@${j.host}:${j.port}`),
      ['tjumpuser@tjump.example.com:2210', 'via1user@via1.example.com:22'],
    );
  });

  it('条目级私钥覆盖只落到条目对应的最终跳板（链尾）', () => {
    useConfig(PANEL_CONFIG);
    const chain = resolveJumpChain([{ target: 'via1', identityFile: '/keys/override.pem' }]);
    assert.equal(chain[0]?.identityFile, join(homedir(), '.ssh', 'tjump_key'), '前置跳板维持 config 私钥');
    assert.equal(chain[1]?.identityFile, '/keys/override.pem', '链尾被覆盖');
  });

  it('条目级密码覆盖删除链尾的 config 私钥', () => {
    useConfig(PANEL_CONFIG);
    const chain = resolveJumpChain([{ target: 'via1', password: 'secret' }]);
    assert.equal(chain[0]?.identityFile, join(homedir(), '.ssh', 'tjump_key'));
    assert.equal('identityFile' in (chain[1] ?? {}), false);
    assert.equal(chain[1]?.password, 'secret');
  });

  it('条目级私钥与密码同给时私钥优先', () => {
    useConfig(PANEL_CONFIG);
    const chain = resolveJumpChain([{ target: 'via1', identityFile: '/keys/k', password: 'secret' }]);
    assert.equal(chain[1]?.identityFile, '/keys/k');
    assert.equal('password' in (chain[1] ?? {}), false);
  });

  it('条目 identityFile 为空串时视为未提供，回落密码分支', () => {
    useConfig(PANEL_CONFIG);
    const chain = resolveJumpChain([{ target: 'via1', identityFile: '', password: 'secret' }]);
    assert.equal(chain[1]?.password, 'secret');
    assert.equal('identityFile' in (chain[1] ?? {}), false);
  });

  it('重复的同一台跳板被去重（按 user@host:port）', () => {
    useConfig('Host unrelated\n  HostName unrelated.example.com\n');
    const chain = resolveJumpChain([
      { target: 'u@a.example.com' },
      { target: 'u@a.example.com', identityFile: '/keys/second' },
    ]);
    assert.equal(chain.length, 1, '同一跳板只保留一次');
    assert.equal('identityFile' in (chain[0] ?? {}), false, '去重未推进时第二个条目的覆盖被跳过');
  });

  it('端口不同视为不同跳板，不去重', () => {
    useConfig('Host unrelated\n  HostName unrelated.example.com\n');
    const chain = resolveJumpChain([
      { target: 'u@a.example.com' },
      { target: 'u@a.example.com:2222' },
    ]);
    assert.equal(chain.length, 2);
  });

  it('空条目列表返回空链', () => {
    useConfig(PANEL_CONFIG);
    assert.deepEqual(resolveJumpChain([]), []);
  });

  it('条目为直连语法但端口非法时抛 HOST_CONFIG_INVALID', () => {
    useConfig(PANEL_CONFIG);
    assertRemoteError(() => resolveJumpChain([{ target: 'u@bad.example.com:0' }]), 'HOST_CONFIG_INVALID');
  });

  it('条目既不在 config 也不匹配直连语法时抛 HOST_NOT_FOUND', () => {
    useConfig(PANEL_CONFIG);
    assertRemoteError(() => resolveJumpChain([{ target: 'ghost' }]), 'HOST_NOT_FOUND', 'ghost');
  });

  it('条目级私钥的 ~/ 前缀展开', () => {
    useConfig('Host unrelated\n  HostName unrelated.example.com\n');
    const chain = resolveJumpChain([{ target: 'u@a.example.com', identityFile: '~/keys/panel' }]);
    assert.equal(chain[0]?.identityFile, join(homedir(), 'keys', 'panel'));
  });
});

// ─── assertConnectable ─────────────────────────────────────────────────────

describe('assertConnectable', () => {
  /** 构造 ResolvedHost 的便捷工厂，字段默认齐全 */
  function mkHost(overrides: Partial<ResolvedHost>): ResolvedHost {
    return { host: 'h.example.com', port: 22, username: 'u', ...overrides };
  }

  /** 构造解析结果的便捷工厂 */
  function mkResolved(
    target: ResolvedHost,
    jumpHosts: ResolvedHost[] = [],
  ): ResolvedHostWithJump {
    return { target, jumpHosts };
  }

  it('User 与 IdentityFile 齐全时通过', () => {
    assert.doesNotThrow(() =>
      assertConnectable(mkResolved(mkHost({ identityFile: '/keys/k' })), 'alpha'));
  });

  it('缺 User 时报错并列出缺失字段', () => {
    assertRemoteError(
      () => assertConnectable(mkResolved(mkHost({ username: '', identityFile: '/keys/k' })), 'alpha'),
      'HOST_CONFIG_INVALID',
      'User',
    );
  });

  it('非交互终端且无 IdentityFile 时报错（不挂死等输入）', () => {
    // node:test 子进程 stdio 为管道：isInteractiveTerminal() 为 false，
    // 该分支按「管道/CI 场景报错退出」的既定语义断言
    assertRemoteError(
      () => assertConnectable(mkResolved(mkHost({})), 'alpha'),
      'HOST_CONFIG_INVALID',
      'IdentityFile',
    );
  });

  it('passwordAuth 显式提供时无 IdentityFile 也放行', () => {
    assert.doesNotThrow(() =>
      assertConnectable(mkResolved(mkHost({})), 'alpha', { passwordAuth: true }));
  });

  it('跳板机有 IdentityFile 时通过', () => {
    const jump = mkHost({ host: 'j.example.com', identityFile: '/keys/jump' });
    assert.doesNotThrow(() =>
      assertConnectable(mkResolved(mkHost({ identityFile: '/keys/k' }), [jump]), 'alpha'));
  });

  it('跳板机有条目携带的密码时通过', () => {
    const jump = mkHost({ host: 'j.example.com', password: 'secret' });
    assert.doesNotThrow(() =>
      assertConnectable(mkResolved(mkHost({ identityFile: '/keys/k' }), [jump]), 'alpha'));
  });

  it('跳板机无任何认证途径时报错（含跳板定位信息）', () => {
    const jump = mkHost({ host: 'j.example.com', port: 2210 });
    assertRemoteError(
      () => assertConnectable(mkResolved(mkHost({ identityFile: '/keys/k' }), [jump]), 'alpha'),
      'HOST_CONFIG_INVALID',
      '跳板机',
    );
  });

  it('错误消息含主机别名与跳板地址', () => {
    const jump = mkHost({ host: 'j.example.com', port: 2210 });
    assertRemoteError(
      () => assertConnectable(mkResolved(mkHost({ identityFile: '/keys/k' }), [jump]), 'alpha'),
      'HOST_CONFIG_INVALID',
      'j.example.com:2210',
    );
  });
});

// ─── listHosts ─────────────────────────────────────────────────────────────

describe('listHosts', () => {
  /** 列举测试 fixture：覆盖排序、多模式行、跳板链、通配与 Match 排除 */
  const LIST_CONFIG = [
    'Host zeta',
    '  HostName zeta.example.com',
    '  User zu',
    '  Port 2200',
    'Host alpha beta',
    '  HostName multi.example.com',
    'Host withjump',
    '  HostName withjump.example.com',
    '  ProxyJump j1',
    'Host j1',
    '  HostName j1.example.com',
    'Host *',
    '  User star',
    'Match all',
    '  HostName ignored.example.com',
    '',
  ].join('\n');

  it('按 config 出现顺序列举（不排序）', () => {
    useConfig(LIST_CONFIG);
    const aliases = listHosts().map(h => h.alias);
    assert.deepEqual(aliases, ['zeta', 'alpha', 'beta', 'withjump', 'j1']);
  });

  it('排除 Host * 通配块与 Match 块', () => {
    useConfig(LIST_CONFIG);
    const aliases = listHosts().map(h => h.alias);
    assert.ok(!aliases.includes('*'), 'Host * 不作为主机条目');
    assert.ok(!aliases.includes('all'), 'Match 块不作为主机条目');
  });

  it('字段默认值：无 User 回落 Host *，无 Port 回落 22，无 HostName 用别名', () => {
    useConfig(LIST_CONFIG);
    const alpha = listHosts().find(h => h.alias === 'alpha');
    assert.ok(alpha);
    assert.equal(alpha.hostName, 'multi.example.com');
    assert.equal(alpha.user, 'star', '无具体 User 时合并 Host * 默认值');
    assert.equal(alpha.port, 22);
    assert.equal(alpha.hasProxyJump, false);
  });

  it('具体条目字段优先于 Host * 默认值', () => {
    useConfig(LIST_CONFIG);
    const zeta = listHosts().find(h => h.alias === 'zeta');
    assert.ok(zeta);
    assert.equal(zeta.user, 'zu');
    assert.equal(zeta.port, 2200);
  });

  it('含跳板机的主机附带解析后的 jumpChain（只读摘要）', () => {
    useConfig(LIST_CONFIG);
    const withjump = listHosts().find(h => h.alias === 'withjump');
    assert.ok(withjump);
    assert.equal(withjump.hasProxyJump, true);
    assert.equal(withjump.proxyJump, 'j1');
    assert.deepEqual(withjump.jumpChain, [{ username: 'star', host: 'j1.example.com', port: 22 }]);
  });

  it('重复别名不去重：同一别名出现两次产生两个条目', () => {
    // 现状：listHosts 不去重（用户 config 写重复 Host 时如实反映条目数），
    // 字段值按 compute 语义取首个匹配块——记录实际行为供回归防护
    useConfig([
      'Host dup',
      '  HostName dup1.example.com',
      'Host dup',
      '  HostName dup2.example.com',
      '',
    ].join('\n'));
    const entries = listHosts().filter(h => h.alias === 'dup');
    assert.equal(entries.length, 2);
    assert.deepEqual(
      entries.map(h => h.hostName),
      ['dup1.example.com', 'dup1.example.com'],
    );
  });
});

// ─── Include 指令 ──────────────────────────────────────────────────────────

describe('Include 指令', () => {
  // 现状：ssh-config 5.3.0 的 parse/compute 不解析 Include 指令，
  // 子文件中的 Host 对本模块不可见（与 OpenSSH 行为不同）。
  // 按实际行为断言，差距记录在测试报告中供后续决策
  it('Include 引用的子文件主机当前不被加载', () => {
    const sub = writeFixture('include-sub.conf', 'Host inc-host\n  HostName inc.example.com\n  User incuser\n');
    useConfig(`Include ${sub}\nHost main\n  HostName main.example.com\n`);
    assertRemoteError(() => resolveHost('inc-host'), 'HOST_NOT_FOUND', 'inc-host');
  });

  it('Include 不影响主文件主机的解析', () => {
    const sub = writeFixture('include-sub2.conf', 'Host inc-host\n  HostName inc.example.com\n');
    useConfig(`Include ${sub}\nHost main\n  HostName main.example.com\n  User mu\n`);
    assert.equal(resolveHost('main').target.host, 'main.example.com');
    assert.deepEqual(listHosts().map(h => h.alias), ['main']);
  });
});

/**
 * @file transport/platform.ts 单元测试
 * @description 覆盖 parsePlatformOutput 对 uname 输出的归一化与不支持组合的
 *              拒绝（含畸形/空输出），以及 buildCommandWithEnv 的 PATH 前缀
 *              拼接、环境变量注入与 shell 转义。全部为纯函数测试，表驱动风格。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlatformOutput, buildCommandWithEnv } from '../../src/transport/platform.js';
import { RemoteError } from '../../src/util/errors.js';

// ─── parsePlatformOutput：合法组合 ─────────────────────────────────────────

describe('parsePlatformOutput 合法组合（表驱动）', () => {
  /** 合法输入表：输出 → 期望的归一化 os/arch */
  const validCases: ReadonlyArray<{ stdout: string; os: string; arch: string; title: string }> = [
    { stdout: 'Linux\nx86_64\n', os: 'linux', arch: 'x64', title: 'Linux x86_64' },
    { stdout: 'Linux\namd64\n', os: 'linux', arch: 'x64', title: 'Linux amd64（x64 别名）' },
    { stdout: 'Linux\narm64\n', os: 'linux', arch: 'arm64', title: 'Linux arm64' },
    { stdout: 'Linux\naarch64\n', os: 'linux', arch: 'arm64', title: 'Linux aarch64（arm64 别名）' },
    { stdout: 'Linux\narmv7l\n', os: 'linux', arch: 'armv7l', title: 'Linux armv7l' },
    { stdout: 'Linux\narmv7\n', os: 'linux', arch: 'armv7l', title: 'Linux armv7（armv7l 别名）' },
    { stdout: 'Darwin\nx86_64\n', os: 'darwin', arch: 'x64', title: 'macOS x86_64' },
    { stdout: 'Darwin\naarch64\n', os: 'darwin', arch: 'arm64', title: 'macOS aarch64' },
    { stdout: 'Linux\r\nx86_64\r\n', os: 'linux', arch: 'x64', title: 'CRLF 换行容忍' },
    { stdout: '  Linux  \n  x86_64  \n', os: 'linux', arch: 'x64', title: '行首尾空白被裁剪' },
  ];

  for (const { stdout, os, arch, title } of validCases) {
    it(`归一化 ${title}`, () => {
      const platform = parsePlatformOutput(stdout, '主机 myhost');
      assert.equal(platform.os, os);
      assert.equal(platform.arch, arch);
    });
  }

  it('raw 字段保留 uname 原始输出（供诊断展示）', () => {
    const platform = parsePlatformOutput('Linux\nx86_64\n', '主机 myhost');
    assert.equal(platform.rawOs, 'Linux');
    assert.equal(platform.rawArch, 'x86_64');
  });

  it('第三行及以后的输出被忽略（只取前两行）', () => {
    const platform = parsePlatformOutput('Linux\nx86_64\nextra line\n', '主机 myhost');
    assert.equal(platform.os, 'linux');
    assert.equal(platform.arch, 'x64');
  });
});

// ─── parsePlatformOutput：拒绝与容错 ───────────────────────────────────────

describe('parsePlatformOutput 不支持组合（表驱动）', () => {
  /** 非法输入表：输出 → 报错消息应含的关键词 */
  const invalidCases: ReadonlyArray<{ stdout: string; part: string; title: string }> = [
    { stdout: 'FreeBSD\nx86_64\n', part: 'FreeBSD', title: '未知系统 FreeBSD' },
    { stdout: 'Windows_NT\nx86_64\n', part: 'Windows_NT', title: 'Windows 系统（远端必须 POSIX）' },
    { stdout: 'linux\nx86_64\n', part: 'linux', title: '小写 os 不匹配（映射精确匹配首字母大写）' },
    { stdout: 'Linux\nriscv64\n', part: 'riscv64', title: '未知架构 riscv64' },
    { stdout: 'Darwin\ni686\n', part: 'i686', title: 'macOS 32 位架构不受支持' },
    { stdout: '', part: '(空)', title: '空输出报系统为空（而非架构）' },
    { stdout: '\nx86_64\n', part: 'x86_64', title: '首行为空（trim 后架构名上移，按未知系统拒绝）' },
    { stdout: 'Linux\n', part: '(空)', title: '缺架构行报架构为空' },
    { stdout: 'Linux', part: '(空)', title: '单行输出报架构为空' },
  ];

  for (const { stdout, part, title } of invalidCases) {
    it(`拒绝 ${title}`, () => {
      assert.throws(
        () => parsePlatformOutput(stdout, '主机 myhost'),
        (err: unknown) => {
          assert.ok(err instanceof RemoteError, `应抛 RemoteError，实际 ${String(err)}`);
          assert.equal(err.code, 'PLATFORM_UNSUPPORTED');
          assert.ok(
            err.message.includes('主机 myhost'),
            `错误消息应含定位标签，实际：「${err.message}」`,
          );
          assert.ok(err.message.includes(part), `错误消息应含「${part}」，实际：「${err.message}」`);
          return true;
        },
      );
    });
  }
});

// ─── buildCommandWithEnv ───────────────────────────────────────────────────

describe('buildCommandWithEnv（表驱动）', () => {
  /** 调用参数表：env / pathPrefix → 期望输出 */
  const cases: ReadonlyArray<{
    title: string;
    command: string;
    env?: Record<string, string>;
    pathPrefix?: string;
    expected: string;
  }> = [
    {
      title: '无 env 无前缀时命令原样返回',
      command: 'echo hi',
      expected: 'echo hi',
    },
    {
      title: '显式传 undefined 同样原样返回',
      command: 'echo hi',
      env: undefined,
      pathPrefix: undefined,
      expected: 'echo hi',
    },
    {
      title: '空 env 对象不加前缀',
      command: 'echo hi',
      env: {},
      pathPrefix: undefined,
      expected: 'echo hi',
    },
    {
      title: '空前缀字符串被忽略（不加 PATH 赋值）',
      command: 'echo hi',
      pathPrefix: '',
      expected: 'echo hi',
    },
    {
      title: 'PATH 前缀拼到 "$PATH" 之前',
      command: 'echo hi',
      pathPrefix: '/opt/node/bin',
      expected: 'env PATH=/opt/node/bin:"$PATH" echo hi',
    },
    {
      title: '含空格的前缀目录被单引号转义',
      command: 'echo hi',
      pathPrefix: '/opt/my bin',
      expected: `env PATH='/opt/my bin':"$PATH" echo hi`,
    },
    {
      title: '"$PATH" 保留在引号外由远端 shell 展开',
      command: 'echo hi',
      pathPrefix: '/p',
      expected: 'env PATH=/p:"$PATH" echo hi',
    },
    {
      title: '单个 env 变量注入',
      command: 'echo hi',
      env: { FOO: 'bar' },
      expected: 'env FOO=bar echo hi',
    },
    {
      title: 'env 值含空格被完整转义',
      command: 'echo hi',
      env: { GREETING: 'hello world' },
      expected: `env GREETING='hello world' echo hi`,
    },
    {
      title: 'env 值中的 $ 不展开（单引号内为字面量）',
      command: 'echo hi',
      env: { VAR: '$HOME' },
      expected: `env VAR='$HOME' echo hi`,
    },
    {
      title: '多个 env 变量按对象键序拼接',
      command: 'echo hi',
      env: { A: '1', B: '2' },
      expected: 'env A=1 B=2 echo hi',
    },
    {
      title: 'PATH 前缀排在 env 赋值之前',
      command: 'echo hi',
      env: { FOO: 'bar' },
      pathPrefix: '/p',
      expected: 'env PATH=/p:"$PATH" FOO=bar echo hi',
    },
    {
      title: 'env 值含 shell 元字符被安全包裹（注入防护）',
      command: 'echo hi',
      env: { EVIL: '; rm -rf /' },
      expected: `env EVIL='; rm -rf /' echo hi`,
    },
    {
      title: 'env 值含命令替换被安全包裹',
      command: 'echo hi',
      env: { EVIL: '$(id)' },
      expected: `env EVIL='$(id)' echo hi`,
    },
    {
      title: 'env 值含单引号被逐一转义',
      command: 'echo hi',
      env: { NAME: "it's" },
      expected: `env NAME='it'\\''s' echo hi`,
    },
  ];

  for (const { title, command, env, pathPrefix, expected } of cases) {
    it(title, () => {
      assert.equal(buildCommandWithEnv(command, env, pathPrefix), expected);
    });
  }
});

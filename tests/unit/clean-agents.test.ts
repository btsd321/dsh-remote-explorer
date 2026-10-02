/**
 * @file cli/commands/clean.ts 的 .agents 清理命令单元测试
 * @description 覆盖 buildAgentsCleanCommands 的目标路径与命令形状。
 *
 * 这个测试存在的唯一理由是：此处有一条 `rm -rf`。它删的必须是机器级
 * `.agents`，且必须恰好是那一个目录——多一层少一层都是删错东西。
 * 远端实跑不在此覆盖（属真机验证范畴）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRemotePaths } from '../../src/provision/remote-paths.js';
import { buildAgentsCleanCommands } from '../../src/cli/commands/clean.js';

const paths = createRemotePaths('/home/tester');

describe('buildAgentsCleanCommands', () => {
  describe('删除目标', () => {
    it('删除的是 .agents 目录本身', () => {
      const { remove } = buildAgentsCleanCommands(paths.agentsHome);
      assert.equal(remove, `rm -rf ${paths.agentsHome}`);
      assert.ok(remove.endsWith('/.agents'), remove);
    });

    it('不多删一层（不是 skills 子目录，也不含父目录）', () => {
      const { remove } = buildAgentsCleanCommands(paths.agentsHome);
      assert.ok(!remove.includes('/skills'), '删整棵 .agents，不是只删 skills');
      assert.ok(!remove.endsWith('/btsd321'), '不应波及 base 根目录');
      assert.ok(!remove.endsWith('/'), '路径不应带尾斜杠');
    });

    it('不含会话段——清的是机器级目录，不是某个会话', () => {
      const { remove } = buildAgentsCleanCommands(paths.agentsHome);
      assert.ok(!remove.includes('/sessions/'), remove);
    });

    it('不触碰受会话保护的目录（profiles/node/versions）', () => {
      const { remove } = buildAgentsCleanCommands(paths.agentsHome);
      for (const keep of ['profiles', 'node/', 'versions']) {
        assert.ok(!remove.includes(keep), `${remove} 不应包含 ${keep}`);
      }
    });
  });

  describe('命令形状', () => {
    it('探测用 test -d 且不因缺失而中断', () => {
      const { probe } = buildAgentsCleanCommands(paths.agentsHome);
      assert.ok(probe.startsWith('test -d '), probe);
      assert.ok(probe.includes('EXISTS'), probe);
      assert.ok(probe.includes('|| true'), '目录不存在是正常情形，不是错误');
    });

    it('统计用 du -sk 并按 KB 读出', () => {
      const { size } = buildAgentsCleanCommands(paths.agentsHome);
      assert.ok(size.includes('du -sk'), size);
      assert.ok(size.includes('2>/dev/null'), '权限/缺失噪声不进 stderr');
    });

    it('三条命令都以 | 之外的形式单列（无命令拼接）', () => {
      const commands = buildAgentsCleanCommands(paths.agentsHome);
      for (const [name, command] of Object.entries(commands)) {
        assert.ok(!command.includes('\n'), `${name} 不应是多行命令`);
      }
    });
  });

  describe('路径转义', () => {
    it('含空格的家目录被字面量化', () => {
      const odd = createRemotePaths('/home/my user');
      const { remove } = buildAgentsCleanCommands(odd.agentsHome);
      assert.ok(remove.includes("'/home/my user/.dsh-remote-explorer/btsd321/.agents'"), remove);
    });
  });
});

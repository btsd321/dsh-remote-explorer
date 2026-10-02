/**
 * @file provision/agents-lock.ts 单元测试
 * @description 覆盖 `.agents` 写临界区锁的命令构造与超时提示归一：
 *              flock 参数顺序与超时取值、锁文件落在所保护的那棵树内、
 *              命令体经单引号字面量化（含注入尝试）、以及 stderr 判据
 *              只认 flock 相关报错。
 *
 * 不覆盖远端 flock 实跑（内核行为已在 install-lock 的 P0 阶段实测）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRemotePaths } from '../../src/provision/remote-paths.js';
import {
  AGENTS_LOCK_WAIT_SECONDS, agentsLockHint, lockAgentsCommand,
} from '../../src/provision/agents-lock.js';

const paths = createRemotePaths('/home/tester');
const BASE = paths.base;

describe('lockAgentsCommand', () => {
  describe('命令构造', () => {
    it('以 flock -w 开头并带超时值', () => {
      const out = lockAgentsCommand(paths, 'mkdir -p /x');
      assert.ok(out.startsWith(`flock -w ${AGENTS_LOCK_WAIT_SECONDS} `), out);
    });

    it('锁文件是机器级 .agents/.lock（在所保护的那棵树内）', () => {
      const out = lockAgentsCommand(paths, 'true');
      assert.ok(out.includes(paths.agentsLockFile), out);
      assert.ok(out.includes(`${BASE}/.agents/.lock`), out);
    });

    it('锁文件不含会话段——并发方必须是同一把锁', () => {
      const out = lockAgentsCommand(paths, 'true');
      assert.ok(!out.includes('/sessions/'), out);
    });

    it('用 -c 传命令体（单一参数形式）', () => {
      const out = lockAgentsCommand(paths, 'true');
      assert.ok(out.includes(' -c '), out);
    });

    it('超时是秒级而非引导安装锁的分钟级', () => {
      // 两个锁的语义不同：本锁护的是秒级目录操作
      assert.ok(AGENTS_LOCK_WAIT_SECONDS > 0);
      assert.ok(AGENTS_LOCK_WAIT_SECONDS <= 300, '不应长到让用户干等');
    });
  });

  describe('命令体转义（注入防护）', () => {
    it('含空格的命令体被整体字面量化', () => {
      const out = lockAgentsCommand(paths, 'mkdir -p /a b');
      assert.ok(out.includes("'mkdir -p /a b'"), out);
    });

    it('含单引号的命令体闭合引号后转义', () => {
      const out = lockAgentsCommand(paths, "echo 'hi'");
      assert.ok(out.includes(`'echo '\\''hi'\\'''`), out);
    });

    it('命令体里的分号不会被 shell 当作命令分隔符', () => {
      const out = lockAgentsCommand(paths, 'true; rm -rf /tmp/x');
      // 整体被单引号包住 ⇒ 分号在字面量内，不产生第二条命令
      assert.ok(out.includes("'true; rm -rf /tmp/x'"), out);
    });

    it('替换尝试不逃出字面量', () => {
      const out = lockAgentsCommand(paths, 'echo $(whoami)');
      assert.ok(out.includes("'echo $(whoami)'"), out);
    });
  });
});

describe('agentsLockHint', () => {
  describe('命中锁超时', () => {
    it('stderr 含 flock 时给出等锁说明', () => {
      const hint = agentsLockHint('flock: failed to get lock');
      assert.ok(hint !== undefined);
      assert.match(hint!, /稍后重试/);
    });

    it('大小写不敏感', () => {
      assert.ok(agentsLockHint('FLOCK busy') !== undefined);
    });
  });

  describe('非锁超时', () => {
    it('普通报错不给等锁提示', () => {
      assert.equal(agentsLockHint('mkdir: cannot create directory'), undefined);
    });

    it('空 stderr 不给提示', () => {
      assert.equal(agentsLockHint(''), undefined);
    });
  });
});

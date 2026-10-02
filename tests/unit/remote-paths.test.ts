/**
 * @file provision/remote-paths.ts 单元测试
 * @description 覆盖 createRemotePaths() 的家目录校验、POSIX 拼接不变量，
 *              以及机器级 `.agents`（DSH_AGENTS_HOME 指向）与会话级路径的
 *              归属划分——后者是「agent 能力按机器共享」这一决策的回归护栏：
 *              `.agents` 必须挂在 base 下而非 `sessions/<id>/` 下，否则换个
 *              会话技能就得重装一遍。
 *
 * 不覆盖远端读写动作（本模块是纯字符串拼接，无 IO）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRemotePaths, BASE_DIR_NAME } from '../../src/provision/remote-paths.js';

/** 测试用远端家目录 */
const HOME = '/home/tester';

/** 该家目录下的预期根目录 */
const BASE = `${HOME}/${BASE_DIR_NAME}`;

describe('createRemotePaths', () => {
  // ─── 家目录校验 ─────────────────────────────────────────────
  describe('家目录校验', () => {
    it('相对路径被拒绝', () => {
      assert.throws(() => createRemotePaths('home/tester'), /绝对路径/);
    });

    it('空串被拒绝', () => {
      assert.throws(() => createRemotePaths(''), /绝对路径/);
    });

    it('尾部斜杠不产生双斜杠', () => {
      const paths = createRemotePaths(`${HOME}/`);
      assert.equal(paths.base, BASE);
      assert.ok(!paths.agentsHome.includes('//'), '路径不应含双斜杠');
    });
  });

  // ─── 机器级 .agents（本次决策的核心）───────────────────────
  describe('机器级 agent 能力根目录', () => {
    it('agentsHome 落在 base 下，与本机 ~/.agents 同形', () => {
      const paths = createRemotePaths(HOME);
      assert.equal(paths.agentsHome, `${BASE}/.agents`);
    });

    it('agentsSkills 是 agentsHome 的 skills 子目录', () => {
      const paths = createRemotePaths(HOME);
      // dsh 的 skill-filesystem 扫 `<agentsHome>/skills`，这层关系不能错
      assert.equal(paths.agentsSkills, `${paths.agentsHome}/skills`);
    });

    it('agentsLockFile 落在 agentsHome 内', () => {
      const paths = createRemotePaths(HOME);
      assert.equal(paths.agentsLockFile, `${paths.agentsHome}/.lock`);
    });

    it('agents 路径不含任何会话段——否则换会话即丢技能', () => {
      const paths = createRemotePaths(HOME);
      for (const path of [paths.agentsHome, paths.agentsSkills, paths.agentsLockFile]) {
        assert.ok(!path.includes('/sessions/'), `${path} 不应落在 sessions/ 下`);
      }
    });

    it('agents 路径与任何 sessionId 无关（机器级共享的判据）', () => {
      const paths = createRemotePaths(HOME);
      // 同一 paths 实例对不同会话给出同一个 agents 根：共享语义的直接断言
      assert.equal(paths.sessionHome('aaa') === paths.sessionHome('bbb'), false);
      assert.equal(paths.agentsHome, `${BASE}/.agents`);
    });
  });

  // ─── 机器级与会话级的归属划分 ───────────────────────────────
  describe('机器级与会话级归属', () => {
    it('插件 profile 是机器级（不含会话段）', () => {
      const paths = createRemotePaths(HOME);
      assert.equal(paths.hostProfileDir('web'), `${BASE}/profiles/web`);
      assert.ok(!paths.hostProfileDir('web').includes('/sessions/'));
    });

    it('会话实例状态仍按会话隔离', () => {
      const paths = createRemotePaths(HOME);
      assert.equal(paths.sessionHome('s1'), `${BASE}/sessions/s1`);
      assert.equal(paths.sessionRuntime('s1'), `${BASE}/sessions/s1/.runtime`);
      assert.notEqual(paths.sessionHome('s1'), paths.sessionHome('s2'));
    });

    it('会话 profile 仍指向会话内路径（其内容是指向 host profile 的 symlink）', () => {
      const paths = createRemotePaths(HOME);
      assert.equal(paths.sessionProfile('s1'), `${BASE}/sessions/s1/profiles/web`);
    });
  });

  // ─── POSIX 拼接不变量 ───────────────────────────────────────
  describe('POSIX 拼接不变量', () => {
    it('所有路径一律用正斜杠（本机可能是 Windows）', () => {
      const paths = createRemotePaths(HOME);
      const all = [
        paths.base, paths.mirrorCache, paths.npmCache, paths.tmpRoot,
        paths.installLockFile, paths.agentsHome, paths.agentsSkills, paths.agentsLockFile,
        paths.hostProfileDir('web'), paths.hostProfileManifest('web'),
        paths.hostProfileNodeModules('web'),
        paths.nodeDir('v24.21.0'), paths.nodeBin('v24.21.0'), paths.nodeBinDir('v24.21.0'),
        paths.dshDir('0.2.0'), paths.dshBin('0.2.0'),
        paths.sessionHome('s1'), paths.sessionProfile('s1'), paths.sessionRuntime('s1'),
        paths.sessionPidFile('s1'), paths.sessionLogFile('s1'), paths.sessionPatchFile('s1'),
        paths.sessionSettingsFile('s1'), paths.sessionHomePatchFile('s1'),
        paths.sessionProxyTokenFile('s1'), paths.sessionReversePortFile('s1'),
        paths.sessionReverseHostFile('s1'), paths.sessionOwnerFile('s1'),
        paths.tmpDir(1234, 'node'),
      ];
      for (const path of all) {
        assert.ok(!path.includes('\\'), `${path} 不应含反斜杠`);
        assert.ok(path.startsWith('/'), `${path} 应是绝对路径`);
        assert.ok(!path.includes('//'), `${path} 不应含双斜杠`);
      }
    });

    it('每条路径都在 base 之下（完全卸载 = rm -rf base 的前提）', () => {
      const paths = createRemotePaths(HOME);
      for (const path of [
        paths.agentsHome, paths.agentsSkills, paths.agentsLockFile,
        paths.hostProfileDir('web'), paths.nodeDir('v24.21.0'),
        paths.dshDir('0.2.0'), paths.sessionHome('s1'), paths.tmpDir(1, 'x'),
      ]) {
        assert.ok(path.startsWith(`${paths.base}/`), `${path} 应在 base 之下`);
      }
    });
  });
});

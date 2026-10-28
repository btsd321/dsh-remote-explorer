/**
 * @file provision/agents-migrate.ts 单元测试
 * @description 覆盖旧版技能根迁移计划的纯函数部分：只迁旧有新无的条目、
 *              同名冲突一律跳过（不覆盖、不删除）、AGENTS.md 冲突同样跳过、
 *              以及平铺 `.md` 技能与空清单的边界。
 *
 * 不覆盖远端 mv/flock 实跑（命令形状由 agents-lock 与集成验证兜底）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { planAgentsMigration } from '../../src/provision/agents-migrate.js';

describe('planAgentsMigration', () => {
  it('旧有新无：技能与 AGENTS.md 都迁', () => {
    const plan = planAgentsMigration({
      legacySkills: ['agent-browser', 'graphify'],
      targetSkills: [],
      legacyHasAgentsMd: true,
      targetHasAgentsMd: false,
    });
    assert.deepEqual(plan.moveSkills, ['agent-browser', 'graphify']);
    assert.deepEqual(plan.skippedSkills, []);
    assert.equal(plan.moveAgentsMd, true);
    assert.equal(plan.skippedAgentsMd, false);
  });

  it('同名冲突跳过，其余照迁（冲突项不迁移）', () => {
    const plan = planAgentsMigration({
      legacySkills: ['graphify', 'pdf-reader', 'old-only'],
      targetSkills: ['graphify'],
      legacyHasAgentsMd: false,
      targetHasAgentsMd: false,
    });
    assert.deepEqual(plan.moveSkills, ['pdf-reader', 'old-only']);
    assert.deepEqual(plan.skippedSkills, ['graphify']);
  });

  it('两侧都有 AGENTS.md 时跳过旧文件', () => {
    const plan = planAgentsMigration({
      legacySkills: [],
      targetSkills: [],
      legacyHasAgentsMd: true,
      targetHasAgentsMd: true,
    });
    assert.equal(plan.moveAgentsMd, false);
    assert.equal(plan.skippedAgentsMd, true);
  });

  it('旧根没有 AGENTS.md 时两个标志都为 false', () => {
    const plan = planAgentsMigration({
      legacySkills: [],
      targetSkills: [],
      legacyHasAgentsMd: false,
      targetHasAgentsMd: false,
    });
    assert.equal(plan.moveAgentsMd, false);
    assert.equal(plan.skippedAgentsMd, false);
  });

  it('空旧清单是空计划（幂等重连走这里）', () => {
    const plan = planAgentsMigration({
      legacySkills: [],
      targetSkills: ['graphify'],
      legacyHasAgentsMd: false,
      targetHasAgentsMd: false,
    });
    assert.deepEqual(plan.moveSkills, []);
    assert.deepEqual(plan.skippedSkills, []);
    assert.equal(plan.moveAgentsMd, false);
  });

  it('平铺 .md 技能与目录条目同等参与冲突判断', () => {
    const plan = planAgentsMigration({
      legacySkills: ['flat-skill.md', 'bundle-skill'],
      targetSkills: ['flat-skill.md'],
      legacyHasAgentsMd: false,
      targetHasAgentsMd: false,
    });
    assert.deepEqual(plan.moveSkills, ['bundle-skill']);
    assert.deepEqual(plan.skippedSkills, ['flat-skill.md']);
  });
});

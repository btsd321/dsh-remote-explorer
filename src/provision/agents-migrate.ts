/**
 * @file 旧版机器级 agent 能力根迁移
 * @description 旧版本把 `DSH_AGENTS_HOME` 指到本工具私有的 `<base>/.agents`；
 *              新版本改指远端账号真实的 `~/.agents`（dsh 默认值，与原生 dsh
 *              共享同一份技能与全局指令）。本模块负责把旧根里的技能条目与
 *              `AGENTS.md` 一次性并入新根，让升级前装的技能与全局指令继续生效。
 *
 * 迁移规则：
 * - **只迁旧有新无的条目**：新根已有同名技能或 `AGENTS.md` 时一律跳过，保留
 *   新版、旧副本原地不动——同名不代表同版本，本工具不擅自覆盖用户的选择。
 * - **只迁内容，不迁第三方安装器元数据**：`.skill-lock.json` 是外部 skills
 *   CLI 的版本化文件，dsh 的技能发现只扫目录；本工具不写它，避免伪造来源与
 *   hash 记录。迁走的技能对 dsh 立即可见。
 * - **幂等**：迁完旧目录只剩冲突项或空，再次连接是空操作。
 * - **失败不阻断会话**：调用方把异常降级为阶段跳过提示（迁移只是兼容旧数据，
 *   不参与会话成立条件）。
 *
 * 并发：同一远端账号下多个会话可能同时连接并同时触发迁移，写入经
 * agents-lock 的 flock 串行化；第三方安装器不读该锁（能力边界见
 * agents-lock.ts）。
 *
 * 分层：能力层（provision/），向下用 util 与传输层。
 */

import { RemoteError } from '../util/errors.js';
import { createLogger } from '../util/logger.js';
import { quote } from '../util/shell-quote.js';
import { agentsLockHint, lockAgentsCommand } from './agents-lock.js';
import type { RemoteContext } from './remote-context.js';

const log = createLogger('agents-migrate');

/** 清单分段标记：整行匹配，技能名不可能等于这些固定串 */
const MARKERS = [
  '__DSH_REMOTE_EXPLORER_LEGACY_SKILLS__',
  '__DSH_REMOTE_EXPLORER_TARGET_SKILLS__',
  '__DSH_REMOTE_EXPLORER_LEGACY_AGENTS_MD__',
  '__DSH_REMOTE_EXPLORER_TARGET_AGENTS_MD__',
] as const;

/** 迁移结果 */
export interface AgentsMigrationReport {
  /** 是否存在旧版根；false = 无需迁移（升级后绝大多数连接走这里） */
  hadLegacy: boolean;
  /** 实际迁移成功的技能名（目录名或平铺 `.md` 文件名） */
  migratedSkills: string[];
  /** 因新根已有同名条目而跳过的技能名（旧副本保留在原处） */
  skippedSkills: string[];
  /** 是否迁移了全局 `AGENTS.md` */
  migratedAgentsMd: boolean;
  /** 新根已有 `AGENTS.md`，按规则跳过（旧文件保留原处） */
  skippedAgentsMd: boolean;
}

/** 迁移计划（纯函数产物，便于单测钉住「冲突不迁移」这条规则） */
export interface AgentsMigrationPlan {
  /** 旧有新无、待迁移的技能名 */
  moveSkills: string[];
  /** 新旧同名的技能名（保守跳过：保留新版） */
  skippedSkills: string[];
  /** 是否迁移 `AGENTS.md`（仅当旧有新无） */
  moveAgentsMd: boolean;
  /** 新旧都有 `AGENTS.md`，按规则跳过（旧文件保留原处） */
  skippedAgentsMd: boolean;
}

/**
 * 计算旧版技能根迁移计划。
 *
 * 冲突判据只看名字存在性，不看内容：同名条目属于「用户在新位置已有自己的
 * 版本」，迁移一律让位（冲突项不迁移、不覆盖、不删除）。
 *
 * @param input - 旧/新两侧的技能名清单与 `AGENTS.md` 存在性
 * @returns 迁移计划
 */
export function planAgentsMigration(input: {
  /** 旧版技能根下的条目名（目录名或平铺 `.md` 文件名） */
  legacySkills: readonly string[];
  /** 新根 skills 下已有的条目名 */
  targetSkills: readonly string[];
  /** 旧根是否有 `AGENTS.md` */
  legacyHasAgentsMd: boolean;
  /** 新根是否有 `AGENTS.md` */
  targetHasAgentsMd: boolean;
}): AgentsMigrationPlan {
  const target = new Set(input.targetSkills);
  const moveSkills: string[] = [];
  const skippedSkills: string[] = [];
  for (const name of input.legacySkills) {
    if (target.has(name)) skippedSkills.push(name);
    else moveSkills.push(name);
  }
  return {
    moveSkills,
    skippedSkills,
    moveAgentsMd: input.legacyHasAgentsMd && !input.targetHasAgentsMd,
    skippedAgentsMd: input.legacyHasAgentsMd && input.targetHasAgentsMd,
  };
}

/**
 * 把旧版 `<base>/.agents` 里的技能与 `AGENTS.md` 并入真实 `~/.agents`。
 *
 * 调用方应在远端 dsh 启动前执行，且把异常降级为「跳过」——迁移失败只意味着
 * 旧技能暂时不可见，不影响新会话成立。
 *
 * @param ctx - 远端执行上下文
 * @param options - 取消信号
 * @returns 迁移结果（旧根不存在时 `hadLegacy: false`）
 * @throws RemoteError 远端命令失败或 flock 等锁超时
 */
export async function migrateLegacyAgentsHome(
  ctx: RemoteContext,
  options: { signal?: AbortSignal } = {},
): Promise<AgentsMigrationReport> {
  const { transport, paths } = ctx;
  const { signal } = options;
  const execOptions = {
    allowNonZeroExit: true,
    ...(signal ? { signal } : {}),
  };

  // 1. 旧根不存在即结束：升级后的常规连接零额外写入
  const legacyProbe = await transport.exec(
    `test -d ${quote(paths.legacyAgentsHome)} && echo EXISTS || true`,
    execOptions,
  );
  if (!legacyProbe.stdout.includes('EXISTS')) {
    return {
      hadLegacy: false,
      migratedSkills: [],
      skippedSkills: [],
      migratedAgentsMd: false,
      skippedAgentsMd: false,
    };
  }

  // 2. 一次 exec 拿全两侧清单，减少通道往返。技能根可能不存在（全新机器），
  //    `ls` 的失败经 `|| true` 归一为空清单。
  const legacyAgentsMd = `${paths.legacyAgentsHome}/AGENTS.md`;
  const targetAgentsMd = `${paths.agentsHome}/AGENTS.md`;
  const listing = await transport.exec([
    `printf '%s\\n' ${quote(MARKERS[0])}`,
    `ls -1A ${quote(paths.legacyAgentsSkills)} 2>/dev/null || true`,
    `printf '%s\\n' ${quote(MARKERS[1])}`,
    `ls -1A ${quote(paths.agentsSkills)} 2>/dev/null || true`,
    `printf '%s\\n' ${quote(MARKERS[2])}`,
    `test -f ${quote(legacyAgentsMd)} && echo 1 || echo 0`,
    `printf '%s\\n' ${quote(MARKERS[3])}`,
    `test -f ${quote(targetAgentsMd)} && echo 1 || echo 0`,
  ].join('\n'), execOptions);

  const sections: string[][] = MARKERS.map(() => []);
  let currentBucket: string[] | undefined;
  for (const raw of listing.stdout.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    const markerIndex = (MARKERS as readonly string[]).indexOf(line);
    if (markerIndex !== -1) {
      currentBucket = sections[markerIndex];
      continue;
    }
    currentBucket?.push(line);
  }

  const plan = planAgentsMigration({
    legacySkills: sections[0] ?? [],
    targetSkills: sections[1] ?? [],
    legacyHasAgentsMd: sections[2]?.includes('1') === true,
    targetHasAgentsMd: sections[3]?.includes('1') === true,
  });

  // 3. 没有可迁项：只可能是「全部重名」或旧目录已空。顺手收尾旧根里属于
  //    本工具的残留（旧版的 `.lock`）与空目录——收干净后下次连接直接短路，
  //    不必每次重扫。`rmdir` 只删空目录，重名冲突项不会被碰。
  if (plan.moveSkills.length === 0 && !plan.moveAgentsMd) {
    await transport.exec([
      `rm -f ${quote(`${paths.legacyAgentsHome}/.lock`)}`,
      `rmdir ${quote(paths.legacyAgentsSkills)} 2>/dev/null || true`,
      `rmdir ${quote(paths.legacyAgentsHome)} 2>/dev/null || true`,
    ].join('\n'), execOptions);
    return {
      hadLegacy: true,
      migratedSkills: [],
      skippedSkills: plan.skippedSkills,
      migratedAgentsMd: false,
      skippedAgentsMd: plan.skippedAgentsMd,
    };
  }

  // 4. 迁移脚本：在锁内逐项复核目标是否存在（列清单到真正搬运之间可能被
  //    另一个会话插队），已存在则跳过；同名冲突绝不覆盖。
  const targetSkillsDir = quote(paths.agentsSkills);
  const lines: string[] = [`mkdir -p ${targetSkillsDir}`];
  for (const name of plan.moveSkills) {
    const from = quote(`${paths.legacyAgentsSkills}/${name}`);
    const to = quote(`${paths.agentsSkills}/${name}`);
    const label = quote(name);
    lines.push(
      `if [ -e ${to} ]; then printf 'S\\t%s\\n' ${label}; `
      + `elif mv ${from} ${to} 2>/dev/null; then printf 'M\\t%s\\n' ${label}; `
      + `else printf 'F\\t%s\\n' ${label}; fi`,
    );
  }
  if (plan.moveAgentsMd) {
    const from = quote(legacyAgentsMd);
    const to = quote(targetAgentsMd);
    lines.push(
      `if [ -e ${to} ]; then printf 'S\\t%s\\n' 'AGENTS.md'; `
      + `elif mv ${from} ${to} 2>/dev/null; then printf 'M\\t%s\\n' 'AGENTS.md'; `
      + `else printf 'F\\t%s\\n' 'AGENTS.md'; fi`,
    );
  }
  // 旧版 `.lock` 是本工具自己的残留（现在的锁在 base/tmp），删掉才能让空旧根
  // 被 rmdir 收掉；rmdir 只删空目录，还有重名冲突项或第三方元数据时保留
  lines.push(`rm -f ${quote(`${paths.legacyAgentsHome}/.lock`)}`);
  lines.push(`rmdir ${quote(paths.legacyAgentsSkills)} 2>/dev/null || true`);
  lines.push(`rmdir ${quote(paths.legacyAgentsHome)} 2>/dev/null || true`);

  await transport.exec(`mkdir -p ${quote(paths.tmpRoot)}`, execOptions);
  const moved = await transport.exec(lockAgentsCommand(paths, lines.join('\n')), execOptions);
  if (moved.exitCode !== 0) {
    const detail = agentsLockHint(moved.stderr) ?? (moved.stderr.trim() || '未知错误');
    throw new RemoteError(
      'EXEC_FAILED',
      `迁移旧版技能根失败（${paths.legacyAgentsHome} → ${paths.agentsHome}）：${detail}`,
      { hostAlias: transport.hostAlias },
    );
  }

  // 5. 解析逐项结果。迁移是幂等的；部分失败把失败项报出来，已搬走的保留
  const migratedSkills: string[] = [];
  const skippedSkills = [...plan.skippedSkills];
  const failed: string[] = [];
  let migratedAgentsMd = false;
  let skippedAgentsMd = false;
  for (const raw of moved.stdout.split('\n')) {
    const [tag, name] = raw.trim().split('\t');
    if (name === undefined || name === '') continue;
    if (tag === 'M') {
      if (name === 'AGENTS.md') migratedAgentsMd = true;
      else migratedSkills.push(name);
    } else if (tag === 'S') {
      if (name === 'AGENTS.md') skippedAgentsMd = true;
      else if (!skippedSkills.includes(name)) skippedSkills.push(name);
    } else if (tag === 'F') {
      failed.push(name);
    }
  }
  if (failed.length > 0) {
    throw new RemoteError(
      'EXEC_FAILED',
      `迁移旧版技能根部分失败：${failed.join('、')}（已迁走的条目保留，下次连接重试剩余项）`,
      { hostAlias: transport.hostAlias },
    );
  }

  log.info('旧版 agent 能力根迁移完成', {
    migratedSkills: migratedSkills.length,
    skippedSkills: skippedSkills.length,
    migratedAgentsMd,
  });
  return { hadLegacy: true, migratedSkills, skippedSkills, migratedAgentsMd, skippedAgentsMd };
}

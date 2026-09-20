/**
 * @file 本机会话表
 * @description 记录本机正在维持的远端会话，支持多主机与同主机多会话并行（决策 9）。
 *
 * 落盘位置 `~/.dsh/remote-sessions.json`。两个必须处理的细节：
 *
 * 1. **陈旧条目。** CLI 被 `kill -9` 时不会走清理流程，表里会留下死条目。
 *    读表时按本机 pid 存活性过滤——`process.kill(pid, 0)` 只做存在性检查不发信号。
 * 2. **并发写竞争。** 两个 CLI 同时启动会同时写表。用锁文件 +
 *    「写临时文件再 rename」的原子替换：rename 在同一文件系统内是原子的，
 *    读者永远看到完整的旧版本或完整的新版本，不会读到半个文件。
 *
 * 不引入 dsh 自己的 `@deepseek-ai/dsh-atomic-write`：本仓库是独立 CLI，
 * 为一个几十行的功能引入跨仓依赖不值得。
 */

import {
  closeSync, mkdirSync, openSync, readFileSync, renameSync,
  rmSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { toErrorMessage } from '../util/errors.js';

/** 一条会话记录 */
export interface SessionRecord {
  /** 会话 id（由主机别名与远端工作目录算出） */
  sessionId: string;
  /** 主机别名 */
  hostAlias: string;
  /** 远端工作目录；未指定时为空串 */
  remoteCwd: string;
  /** 本机转发端口（浏览器访问用） */
  localPort: number;
  /** 远端 dsh 监听端口 */
  remotePort: number;
  /** 反向隧道端口（凭据代理用）；P4 前为 undefined */
  reversePort?: number;
  /** 远端 dsh 进程 pid */
  remotePid: number;
  /** 维持该会话的本机 CLI 进程 pid */
  localPid: number;
  /** 会话启动时间（ISO 8601） */
  startedAt: string;
}

/** 会话表文件结构 */
interface RegistryFile {
  /** 格式版本，便于日后迁移 */
  version: 1;
  /** 会话记录 */
  sessions: SessionRecord[];
}

/** 会话表落盘路径 */
const REGISTRY_PATH = join(homedir(), '.dsh', 'remote-sessions.json');

/** 锁文件路径 */
const LOCK_PATH = `${REGISTRY_PATH}.lock`;

/** 获取锁的最长等待时间（毫秒） */
const LOCK_TIMEOUT_MS = 5_000;

/** 锁重试间隔（毫秒） */
const LOCK_RETRY_MS = 50;

/**
 * 认定锁已失效的时长（毫秒）。
 *
 * 持锁进程被强杀会留下锁文件。超过这个时长就视为陈旧锁并强行接管——
 * 正常的读改写操作只涉及几 KB 的本地文件，远用不了 30 秒。
 */
const LOCK_STALE_MS = 30_000;

/**
 * 读取会话表并过滤掉陈旧条目。
 *
 * @returns 当前有效的会话记录
 */
export function listSessions(): SessionRecord[] {
  const file = readRegistry();
  return file.sessions.filter(record => isLocalPidAlive(record.localPid));
}

/**
 * 写入或更新一条会话记录。
 *
 * **主键是 `(sessionId, localPid)` 的组合，不是 `sessionId` 单独。**
 * 会话 id 是远端身份——同别名同目录的多个本机 CLI 会共享同一个远端 dsh
 * （后来者探到既有进程即复用），它们是同一远端会话的多个本机视图，
 * 各自维持着自己的隧道端口。只按 sessionId 去重会让后启动的 CLI
 * 挤掉先前那条记录，于是 `status` 漏报一个仍在工作的隧道。
 *
 * 同一 CLI 重连后端口变化仍会正确替换自身记录，因为 localPid 不变。
 *
 * @param record - 会话记录
 */
export function upsertSession(record: SessionRecord): void {
  mutate((sessions) => {
    const kept = sessions.filter(
      item => !(item.sessionId === record.sessionId && item.localPid === record.localPid),
    );
    kept.push(record);
    return kept;
  });
}

/**
 * 删除会话记录。
 *
 * @param sessionId - 会话 id
 * @param localPid - 本机 CLI 进程 pid；省略则删除该会话 id 的全部记录
 *   （`kill` 停掉远端进程后，所有本机视图都已失效）
 */
export function removeSession(sessionId: string, localPid?: number): void {
  mutate(sessions => sessions.filter((item) => {
    if (item.sessionId !== sessionId) return true;
    return localPid !== undefined && item.localPid !== localPid;
  }));
}

/**
 * 清理所有陈旧条目。
 *
 * @returns 被清理的条目数
 */
export function pruneSessions(): number {
  let removed = 0;
  mutate((sessions) => {
    const alive = sessions.filter(record => isLocalPidAlive(record.localPid));
    removed = sessions.length - alive.length;
    return alive;
  });
  return removed;
}

/**
 * 在持锁状态下读改写会话表。
 *
 * @param update - 接收当前记录，返回新记录
 */
function mutate(update: (sessions: SessionRecord[]) => SessionRecord[]): void {
  const release = acquireLock();
  try {
    const file = readRegistry();
    const next: RegistryFile = { version: 1, sessions: update(file.sessions) };
    writeRegistryAtomically(next);
  } finally {
    release();
  }
}

/**
 * 读取会话表文件。
 *
 * @returns 文件内容；不存在或损坏时返回空表
 */
function readRegistry(): RegistryFile {
  try {
    const text = readFileSync(REGISTRY_PATH, 'utf8');
    const parsed = JSON.parse(text) as RegistryFile;
    if (!Array.isArray(parsed.sessions)) return { version: 1, sessions: [] };
    return { version: 1, sessions: parsed.sessions };
  } catch { /* 文件缺失或损坏，当作空表——会话表是缓存性质，重建代价低 */ }
  return { version: 1, sessions: [] };
}

/**
 * 原子写入会话表。
 *
 * 先写同目录下的临时文件再 rename：rename 在同一文件系统内是原子操作，
 * 并发读者不会看到半个文件。
 *
 * @param file - 待写入内容
 */
function writeRegistryAtomically(file: RegistryFile): void {
  mkdirSync(join(homedir(), '.dsh'), { recursive: true });
  // 临时文件名带本机 pid，避免并发写时互相覆盖
  const tmpPath = `${REGISTRY_PATH}.${process.pid}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(file, undefined, 2)}\n`, 'utf8');
  try {
    renameSync(tmpPath, REGISTRY_PATH);
  } catch (error) {
    // rename 失败要清掉临时文件，否则会在目录里累积
    try { rmSync(tmpPath, { force: true }); } catch { /* 清理失败无妨 */ }
    throw new Error(`写入会话表失败（${REGISTRY_PATH}）：${toErrorMessage(error)}`);
  }
}

/**
 * 获取文件锁。
 *
 * 用 `openSync(..., 'wx')` 的排他创建语义实现——该标志在文件已存在时失败，
 * 这个「创建即获锁」的操作由内核保证原子性。
 *
 * @returns 释放锁的函数
 */
function acquireLock(): () => void {
  mkdirSync(join(homedir(), '.dsh'), { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  for (;;) {
    try {
      const fd = openSync(LOCK_PATH, 'wx');
      writeFileSync(fd, String(process.pid), 'utf8');
      closeSync(fd);
      return () => {
        try { unlinkSync(LOCK_PATH); } catch { /* 已被清理，无妨 */ }
      };
    } catch { /* 锁已被占用，判断是否陈旧后重试 */ }

    if (takeOverStaleLock()) continue;

    if (Date.now() >= deadline) {
      // 拿不到锁不应让整个会话失败——会话表只是本机簿记，
      // 丢一条记录的后果是 status 少显示一项，远轻于中断用户的会话
      return () => { /* 未持锁，无需释放 */ };
    }
    sleepBusy(LOCK_RETRY_MS);
  }
}

/**
 * 检查并接管陈旧锁。
 *
 * @returns 是否成功删除了陈旧锁
 */
function takeOverStaleLock(): boolean {
  try {
    const content = readFileSync(LOCK_PATH, 'utf8').trim();
    const holderPid = Number.parseInt(content, 10);
    // 持锁进程已不在 ⇒ 锁陈旧
    if (Number.isFinite(holderPid) && !isLocalPidAlive(holderPid)) {
      unlinkSync(LOCK_PATH);
      return true;
    }
    // 持锁进程在，但锁文件太老 ⇒ 同样视为异常（进程卡死）
    const mtimeMs = fileMtimeMs(LOCK_PATH);
    if (mtimeMs > 0 && Date.now() - mtimeMs > LOCK_STALE_MS) {
      unlinkSync(LOCK_PATH);
      return true;
    }
  } catch { /* 锁文件刚被别人释放，或读取失败，交由外层重试 */ }
  return false;
}

/**
 * 安全地取文件 mtime。
 *
 * @param path - 文件路径
 * @returns mtime 毫秒值；取不到时为 0
 */
function fileMtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * 判断本机某 pid 是否存活。
 *
 * `process.kill(pid, 0)` 不发送信号，只做存在性与权限检查。
 *
 * @param pid - 进程号
 * @returns 是否存活
 */
function isLocalPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM 表示进程存在但无权发信号——仍算存活
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * 忙等指定毫秒数。
 *
 * 会话表操作是同步的（要在进程退出钩子里可靠执行），所以只能忙等。
 * 等待时长极短（50ms 量级），代价可接受。
 *
 * @param ms - 毫秒
 */
function sleepBusy(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) { /* 忙等：同步上下文中无法 await */ }
}

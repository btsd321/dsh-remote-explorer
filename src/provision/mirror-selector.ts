/**
 * @file 镜像源连通性测速与自适应选取
 * @description 在**远端**实测各候选镜像的可达性与延迟，选出最快的一个。
 *              测的是远端到镜像的连通性——本机测出来的结果无参考价值。
 *
 * 两个必须遵守的实现约束（均由 P0 实测得出）：
 *
 * 1. **必须带 `-L` 跟随重定向，且必须校验响应内容。**
 *    阿里镜像对 `index.json` 返回 302，`curl -fsS`（不跟随）测到的是 nginx 的
 *    302 页面，耗时 0.25s，看起来比官方源（1.27s）快 5 倍。加 `-L` 并校验响应
 *    首字符后排名完全变了：中科大 0.471s 最快、阿里 0.494s、清华 0.543s、官方 1.140s。
 *    只测时间会把重定向页当成成功，并选出错误的"最快"镜像。
 *
 * 2. **腾讯与华为镜像已从候选中移除。** P0 实测两者 DNS 均解析失败
 *    （`Could not resolve host`），保留只会在每次测速里白等超时。
 *
 * 另外，"官方 Node 源被墙"这条经验已不再成立——P0 实测官方源可达（1.14s），
 * 只是比镜像慢。这恰好说明自适应测速比硬编码选某个镜像更可靠：网络状况会变。
 */

import { RemoteError } from '../util/errors.js';
import { quote } from '../util/shell-quote.js';
import type { RemoteTransport } from '../transport/types.js';

/** 镜像用途 */
export type MirrorKind =
  /** Node 官方发行版 tarball */
  | 'node'
  /** npm registry */
  | 'npm';

/** 一个候选镜像 */
export interface MirrorCandidate {
  /** 展示名 */
  name: string;
  /** 基础 URL（不含尾部斜杠） */
  baseUrl: string;
}

/** 单个候选的测速结果 */
export interface MirrorProbeResult {
  /** 候选镜像 */
  candidate: MirrorCandidate;
  /** 是否可用（可达且内容格式正确） */
  isUsable: boolean;
  /** 总耗时（秒）；不可用时为 undefined */
  seconds?: number;
  /** 不可用原因（诊断用） */
  reason?: string;
}

/** 测速与选取结果 */
export interface MirrorSelection {
  /** 选中的镜像 */
  selected: MirrorCandidate;
  /** 全部候选的测速详情，按耗时升序（不可用的排在最后） */
  results: MirrorProbeResult[];
  /** 是否来自缓存 */
  fromCache: boolean;
}

/**
 * Node 发行版候选镜像。
 *
 * 探测路径统一用 `index.json`——它是 Node 发行站的标准索引文件，
 * 各镜像都提供，且内容是 JSON 数组（首字符 `[`），便于校验。
 */
const NODE_MIRRORS: readonly MirrorCandidate[] = [
  { name: '中科大', baseUrl: 'https://mirrors.ustc.edu.cn/node' },
  { name: '阿里', baseUrl: 'https://npmmirror.com/mirrors/node' },
  { name: '清华', baseUrl: 'https://mirrors.tuna.tsinghua.edu.cn/nodejs-release' },
  { name: '官方', baseUrl: 'https://nodejs.org/dist' },
];

/**
 * npm registry 候选镜像。
 *
 * 探测路径用一个真实存在的包元数据，返回 JSON 对象（首字符 `{`）。
 */
const NPM_MIRRORS: readonly MirrorCandidate[] = [
  { name: '阿里', baseUrl: 'https://registry.npmmirror.com' },
  { name: '官方', baseUrl: 'https://registry.npmjs.org' },
];

/** 探测用的相对路径与期望的响应首字符 */
const PROBE_SPEC: Record<MirrorKind, { path: string; expectFirstChar: string }> = {
  node: { path: '/index.json', expectFirstChar: '[' },
  // 用 scope 包做探测；`/` 必须编码为 %2F
  npm: { path: '/@deepseek-ai%2Fdsh', expectFirstChar: '{' },
};

/** 单个候选的探测超时（秒）。被墙的表现是卡住而非快速失败，所以要短 */
const PROBE_TIMEOUT_SECONDS = 6;

/** 缓存有效期（毫秒）：一天。网络状况会变，但不必每次连接都重测 */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** 缓存文件中的单条记录 */
interface CacheEntry {
  /** 选中的 baseUrl */
  baseUrl: string;
  /** 写入时间戳（毫秒） */
  savedAt: number;
}

/** 缓存文件结构 */
interface MirrorCache {
  /** 按用途分别缓存 */
  node?: CacheEntry;
  /** npm registry 缓存 */
  npm?: CacheEntry;
}

/**
 * 取某用途的候选镜像列表。
 *
 * @param kind - 镜像用途
 * @returns 候选列表
 */
export function getCandidates(kind: MirrorKind): readonly MirrorCandidate[] {
  return kind === 'node' ? NODE_MIRRORS : NPM_MIRRORS;
}

/**
 * 在远端测速并选出最快可用的镜像。
 *
 * @param transport - 已连接的传输
 * @param kind - 镜像用途
 * @param options - 选项
 * @returns 选取结果
 * @throws RemoteError('MIRROR_ALL_UNREACHABLE') 所有候选均不可用
 */
export async function selectMirror(
  transport: RemoteTransport,
  kind: MirrorKind,
  options: {
    /** 缓存文件的远端绝对路径 */
    cachePath: string;
    /** 强制重测，忽略缓存 */
    force?: boolean;
    /** 取消信号 */
    signal?: AbortSignal;
  },
): Promise<MirrorSelection> {
  const candidates = getCandidates(kind);

  // 1. 尝试命中缓存
  if (!options.force) {
    const cached = await readCache(transport, options.cachePath, options.signal);
    const entry = cached?.[kind];
    if (entry && Date.now() - entry.savedAt < CACHE_TTL_MS) {
      const hit = candidates.find(c => c.baseUrl === entry.baseUrl);
      // 候选清单变更后旧缓存可能指向已移除的镜像，此时视为未命中
      if (hit) {
        return { selected: hit, results: [], fromCache: true };
      }
    }
  }

  // 2. 远端实测
  const results = await probeAll(transport, kind, candidates, options.signal);
  const usable = results.filter(r => r.isUsable);
  if (usable.length === 0) {
    const detail = results
      .map(r => `  ${r.candidate.name}（${r.candidate.baseUrl}）：${r.reason ?? '不可达'}`)
      .join('\n');
    throw new RemoteError(
      'MIRROR_ALL_UNREACHABLE',
      `主机 ${transport.hostAlias} 无法访问任何 ${kind === 'node' ? 'Node 发行版' : 'npm registry'} 镜像：\n${detail}`,
      { hostAlias: transport.hostAlias },
    );
  }

  const selected = usable[0]!.candidate;
  // 3. 写缓存（失败不影响使用）
  await writeCache(transport, options.cachePath, kind, selected.baseUrl, options.signal);

  return { selected, results, fromCache: false };
}

/**
 * 并发测速全部候选。
 *
 * 在远端用单条命令跑完所有候选，避免 N 次 SSH 往返。
 *
 * @param transport - 已连接的传输
 * @param kind - 镜像用途
 * @param candidates - 候选列表
 * @param signal - 取消信号
 * @returns 测速结果，按耗时升序（不可用的排最后）
 */
async function probeAll(
  transport: RemoteTransport,
  kind: MirrorKind,
  candidates: readonly MirrorCandidate[],
  signal?: AbortSignal,
): Promise<MirrorProbeResult[]> {
  const spec = PROBE_SPEC[kind];

  // 每个候选：跟随重定向取首字节校验内容，再单独测总耗时。
  // 两次请求看似浪费，但第一次通常命中 CDN 缓存，且正确性比省一次请求重要。
  //
  // 用换行连接，不用空格——`head=$(...) if [ ... ]` 是 shell 语法错误，
  // 整段脚本会在解析期就失败，表现为所有候选「探测无输出」。
  const lines = candidates.map((candidate, index) => {
    const url = quote(`${candidate.baseUrl}${spec.path}`);
    return [
      `head=$(curl -fsSL -m ${PROBE_TIMEOUT_SECONDS} ${url} 2>/dev/null | head -c 1)`,
      `if [ "$head" = ${quote(spec.expectFirstChar)} ]; then`,
      `  t=$(curl -fsSL -m ${PROBE_TIMEOUT_SECONDS} -o /dev/null -w '%{time_total}' ${url} 2>/dev/null)`,
      `  printf 'R=%s OK %s\\n' ${index} "$t"`,
      'else',
      `  printf 'R=%s BAD %s\\n' ${index} "$head"`,
      'fi',
    ].join('\n');
  });

  const result = await transport.exec(lines.join('\n'), {
    allowNonZeroExit: true,
    // 候选串行探测，每个最多两次请求
    timeoutMs: (PROBE_TIMEOUT_SECONDS * 2 * candidates.length + 10) * 1000,
    ...(signal ? { signal } : {}),
  });

  const parsed = new Map<number, MirrorProbeResult>();
  for (const line of result.stdout.split('\n')) {
    const match = /^R=(\d+)\s+(OK|BAD)\s*(.*)$/.exec(line.trim());
    if (!match) continue;
    const index = Number.parseInt(match[1]!, 10);
    const candidate = candidates[index];
    if (!candidate) continue;

    if (match[2] === 'OK') {
      const seconds = Number.parseFloat(match[3]!);
      parsed.set(index, {
        candidate,
        isUsable: Number.isFinite(seconds),
        ...(Number.isFinite(seconds) ? { seconds } : { reason: '耗时解析失败' }),
      });
    } else {
      // 内容校验失败：可能是 DNS 失败、超时，也可能返回了重定向页或错误页
      const got = match[3]!.trim();
      parsed.set(index, {
        candidate,
        isUsable: false,
        reason: got.length === 0
          ? '无响应（DNS 失败、连接超时或被拒）'
          : `响应内容非预期（期望以 ${spec.expectFirstChar} 开头，实际 ${got}）`,
      });
    }
  }

  // 未出现在输出里的候选一律记为不可用，保证结果覆盖全部候选
  const all = candidates.map((candidate, index) =>
    parsed.get(index) ?? { candidate, isUsable: false, reason: '探测无输出' },
  );

  return all.sort((a, b) => {
    if (a.isUsable !== b.isUsable) return a.isUsable ? -1 : 1;
    return (a.seconds ?? Number.POSITIVE_INFINITY) - (b.seconds ?? Number.POSITIVE_INFINITY);
  });
}

/**
 * 读取远端缓存文件。
 *
 * @param transport - 已连接的传输
 * @param cachePath - 缓存文件远端绝对路径
 * @param signal - 取消信号
 * @returns 缓存内容；不存在或损坏时 undefined
 */
async function readCache(
  transport: RemoteTransport,
  cachePath: string,
  signal?: AbortSignal,
): Promise<MirrorCache | undefined> {
  const result = await transport.exec(`cat ${quote(cachePath)} 2>/dev/null || true`, {
    allowNonZeroExit: true,
    ...(signal ? { signal } : {}),
  });
  const text = result.stdout.trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as MirrorCache;
  } catch { /* 文件损坏，当作未命中重新测速 */ }
  return undefined;
}

/**
 * 写入远端缓存文件。
 *
 * 写失败不影响运行时——下次重新测速即可。
 *
 * @param transport - 已连接的传输
 * @param cachePath - 缓存文件远端绝对路径
 * @param kind - 镜像用途
 * @param baseUrl - 选中的 baseUrl
 * @param signal - 取消信号
 */
async function writeCache(
  transport: RemoteTransport,
  cachePath: string,
  kind: MirrorKind,
  baseUrl: string,
  signal?: AbortSignal,
): Promise<void> {
  const existing = (await readCache(transport, cachePath, signal)) ?? {};
  const next: MirrorCache = { ...existing, [kind]: { baseUrl, savedAt: Date.now() } };
  const json = JSON.stringify(next);
  const dir = cachePath.slice(0, cachePath.lastIndexOf('/'));
  try {
    await transport.exec(
      `mkdir -p ${quote(dir)} && printf '%s' ${quote(json)} > ${quote(cachePath)}`,
      { allowNonZeroExit: true, ...(signal ? { signal } : {}) },
    );
  } catch { /* 缓存写入失败不影响本次引导 */ }
}

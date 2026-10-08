/**
 * @file provision/local-mirror-race.ts 单元测试
 * @description 用 mock fetch 覆盖竞速核心语义：
 *   - 真正的竞速：首候选慢（超时）不阻塞后续快候选的胜出
 *   - 全部失败降级为 undefined（不抛错）
 *   - 缓存命中走单次请求、缓存镜像失败时清缓存走竞速重试
 *
 * mock 策略：按 URL 前缀分发到自定义 handler，handler 控制响应延迟与状态。
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { raceMirrors, clearLocalMirrorCache } from '../../src/provision/local-mirror-race.js';
import type { MirrorCandidate } from '../../src/provision/mirror-selector.js';

// ─── mock fetch 基础设施 ─────────────────────────────────────────────────

/** mock fetch handler：按 URL 前缀匹配，返回 { status, json?, delayMs? } */
type MockHandler = {
  /** URL 前缀匹配（startsWith） */
  urlPrefix: string;
  /** HTTP 状态码 */
  status: number;
  /** 响应 body（JSON 序列化后返回）；省略时返回空对象 */
  body?: unknown;
  /** 人为延迟（毫秒），模拟慢镜像；0 或省略为立即返回 */
  delayMs?: number;
};

/** 原始全局 fetch（恢复用） */
const originalFetch = globalThis.fetch;

/** 当前活跃的 mock handler 列表 */
let mockHandlers: MockHandler[] = [];

/**
 * 安装 mock fetch：按 urlPrefix 匹配，命中后按 handler 配置返回。
 * 未命中前缀的请求一律返回 500（视为不应发生）。
 */
function installMockFetch(handlers: MockHandler[]): void {
  mockHandlers = handlers;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const handler = mockHandlers.find(h => url.startsWith(h.urlPrefix));
    // 模拟延迟（若有）
    const delay = handler?.delayMs ?? 0;
    const responsePromise = delay > 0
      ? new Promise<void>(resolve => setTimeout(resolve, delay))
      : Promise.resolve();
    return responsePromise.then(() => {
      // 若请求已 abort，reject（模拟真实 fetch 在 abort 时的行为）
      if (init?.signal?.aborted) {
        throw new DOMException('The operation was aborted.', 'AbortError');
      }
      const status = handler?.status ?? 500;
      const body = JSON.stringify(handler?.body ?? {});
      return new Response(body, {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }) as Promise<Response>;
  }) as typeof fetch;
}

/** 恢复全局 fetch */
function restoreFetch(): void {
  globalThis.fetch = originalFetch;
}

// ─── 测试用候选列表 ─────────────────────────────────────────────────────

/** 慢候选（模拟被墙/超时） */
const SLOW: MirrorCandidate = { name: '慢镜像', baseUrl: 'https://slow.example.com' };
/** 快候选（模拟正常镜像） */
const FAST: MirrorCandidate = { name: '快镜像', baseUrl: 'https://fast.example.com' };

// ─── raceMirrors ───────────────────────────────────────────────────────

describe('raceMirrors', () => {
  beforeEach(() => {
    clearLocalMirrorCache();
  });

  afterEach(() => {
    restoreFetch();
  });

  describe('空输入', () => {
    it('空候选列表返回 undefined', async () => {
      const result = await raceMirrors([], '/index.json');
      assert.equal(result, undefined);
    });
  });

  describe('真正竞速（核心语义）', () => {
    it('首候选慢（延迟）不阻塞后续快候选胜出', async () => {
      // 慢候选延迟 200ms 成功，快候选立即成功
      // 真正的竞速应选快候选，不干等慢候选
      installMockFetch([
        { urlPrefix: SLOW.baseUrl, status: 200, body: { from: 'slow' }, delayMs: 200 },
        { urlPrefix: FAST.baseUrl, status: 200, body: { from: 'fast' } },
      ]);

      const result = await raceMirrors<{ from: string }>([SLOW, FAST], '/index.json');
      assert.ok(result, '应有胜出者');
      assert.equal(result.baseUrl, FAST.baseUrl, '快候选应胜出');
      assert.equal(result.data.from, 'fast');
    });

    it('首候选返回非 2xx 不阻塞后续成功候选', async () => {
      // 首候选立即返回 404（快失败），后续候选成功
      // 顺序 await 会立即拿到首候选的 null 再查后续——这个场景顺序 await 也能过，
      // 但确保 Promise.any 路径也正确
      installMockFetch([
        { urlPrefix: SLOW.baseUrl, status: 404 },
        { urlPrefix: FAST.baseUrl, status: 200, body: { ok: true } },
      ]);

      const result = await raceMirrors<{ ok: boolean }>([SLOW, FAST], '/index.json');
      assert.ok(result);
      assert.equal(result.baseUrl, FAST.baseUrl);
      assert.equal(result.data.ok, true);
    });
  });

  describe('全部失败降级', () => {
    it('全部候选都返回非 2xx 时返回 undefined', async () => {
      installMockFetch([
        { urlPrefix: SLOW.baseUrl, status: 500 },
        { urlPrefix: FAST.baseUrl, status: 404 },
      ]);

      const result = await raceMirrors([SLOW, FAST], '/index.json');
      assert.equal(result, undefined);
    });

    it('单个候选失败时返回 undefined', async () => {
      installMockFetch([
        { urlPrefix: FAST.baseUrl, status: 503 },
      ]);

      const result = await raceMirrors([FAST], '/index.json');
      assert.equal(result, undefined);
    });
  });

  describe('缓存', () => {
    it('首次竞速后缓存选中镜像，二次调用走单次请求', async () => {
      let fetchCallCount = 0;
      globalThis.fetch = ((input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        fetchCallCount++;
        const status = url.startsWith(FAST.baseUrl) ? 200 : 500;
        const body = url.startsWith(FAST.baseUrl) ? { cached: true } : {};
        return Promise.resolve(new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }));
      }) as typeof fetch;

      // 第一次竞速：FAST 胜出（2 次请求：SLOW + FAST）
      const first = await raceMirrors<{ cached: boolean }>([SLOW, FAST], '/index.json');
      assert.ok(first);
      assert.equal(first.baseUrl, FAST.baseUrl);
      const firstCallCount = fetchCallCount;

      // 第二次：应命中缓存，只对 FAST 发 1 次请求
      const second = await raceMirrors<{ cached: boolean }>([SLOW, FAST], '/index.json');
      assert.ok(second);
      assert.equal(second.baseUrl, FAST.baseUrl);
      assert.equal(second.data.cached, true);
      // 第二次只多 1 次请求（缓存命中的单次查询），而非 2 次（重新竞速）
      assert.equal(fetchCallCount - firstCallCount, 1);
    });

    it('缓存镜像失败时清缓存走竞速重试', async () => {
      // 第一次：FAST 胜出并缓存
      let fastStatus = 200;
      globalThis.fetch = ((input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const status = url.startsWith(FAST.baseUrl) ? fastStatus : 500;
        const body = url.startsWith(FAST.baseUrl) ? { v: 1 } : {};
        return Promise.resolve(new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }));
      }) as typeof fetch;

      const first = await raceMirrors<{ v: number }>([SLOW, FAST], '/index.json');
      assert.ok(first);
      assert.equal(first.baseUrl, FAST.baseUrl);

      // 第二次：缓存命中但 FAST 这次返回 500——应清缓存走竞速
      // SLOW 仍 500，FAST 也 500——全部失败返回 undefined
      fastStatus = 500;
      const second = await raceMirrors<{ v: number }>([SLOW, FAST], '/index.json');
      assert.equal(second, undefined);

      // 第三次：FAST 恢复 200——缓存已清，重新竞速应胜出
      fastStatus = 200;
      const third = await raceMirrors<{ v: number }>([SLOW, FAST], '/index.json');
      assert.ok(third);
      assert.equal(third.baseUrl, FAST.baseUrl);
    });
  });
});

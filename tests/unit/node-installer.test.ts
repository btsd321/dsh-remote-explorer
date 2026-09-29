/**
 * @file provision/node-installer.ts 单元测试（纯函数部分）
 * @description 覆盖 Node 下载镜像候选链的构造：首选置顶、官方垫底、去重、
 *              未知首选的合成、空串首选退化为默认链。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { nodeMirrorChain } from '../../src/provision/node-installer.js';
import { getCandidates, OFFICIAL_NODE_BASE_URL } from '../../src/provision/mirror-selector.js';

/** 非官方候选的 baseUrl 集合（断言「官方垫底」用） */
const NON_OFFICIAL_BASE_URLS = getCandidates('node')
  .filter(c => c.baseUrl !== OFFICIAL_NODE_BASE_URL)
  .map(c => c.baseUrl);

describe('nodeMirrorChain', () => {
  it('首选镜像置顶，官方源垫底', () => {
    // 清华不在官方位：应出现在链首；官方应在链尾
    const chain = nodeMirrorChain('https://mirrors.tuna.tsinghua.edu.cn/nodejs-release');
    assert.equal(chain[0]?.baseUrl, 'https://mirrors.tuna.tsinghua.edu.cn/nodejs-release');
    assert.equal(chain.at(-1)?.baseUrl, OFFICIAL_NODE_BASE_URL);
    // 中间的非官方项与候选列表顺序一致（去重不影响相对顺序）
    const middle = chain.slice(1, -1).map(c => c.baseUrl);
    assert.deepEqual(
      middle,
      NON_OFFICIAL_BASE_URLS.filter(b => b !== 'https://mirrors.tuna.tsinghua.edu.cn/nodejs-release'),
    );
  });

  it('首选即官方时官方置首且不重复', () => {
    const chain = nodeMirrorChain(OFFICIAL_NODE_BASE_URL);
    assert.equal(chain[0]?.baseUrl, OFFICIAL_NODE_BASE_URL);
    assert.equal(chain.filter(c => c.baseUrl === OFFICIAL_NODE_BASE_URL).length, 1);
    // 官方之后的其余镜像依旧全量在场
    assert.deepEqual(chain.slice(1).map(c => c.baseUrl), NON_OFFICIAL_BASE_URLS);
  });

  it('未知首选按合成候选置于链首', () => {
    const chain = nodeMirrorChain('https://example.invalid/node');
    assert.equal(chain[0]?.name, '首选');
    assert.equal(chain[0]?.baseUrl, 'https://example.invalid/node');
    // 其余候选全量跟随，官方仍垫底
    assert.equal(chain.at(-1)?.baseUrl, OFFICIAL_NODE_BASE_URL);
    assert.equal(chain.length, NON_OFFICIAL_BASE_URLS.length + 2);
  });

  it('空串首选退化为默认链（镜像 → 官方垫底）', () => {
    const chain = nodeMirrorChain('');
    assert.deepEqual(
      chain.map(c => c.baseUrl),
      [...NON_OFFICIAL_BASE_URLS, OFFICIAL_NODE_BASE_URL],
    );
  });

  it('链内 baseUrl 互不相同（去重）', () => {
    const chain = nodeMirrorChain('https://mirrors.ustc.edu.cn/node');
    const urls = chain.map(c => c.baseUrl);
    assert.equal(new Set(urls).size, urls.length);
  });
});

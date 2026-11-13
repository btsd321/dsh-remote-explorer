/**
 * @file credential/provider-routes.ts 单元测试
 * @description 覆盖 extractProviderRoutes() 的路由解析与 deepseekRoute() 的默认值。
 *              仅测试纯函数部分，不涉及文件 IO（readLocalSettings 等跳过）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  extractProviderRoutes, deepseekRoute, deepseekModelsRoute, extractDeepseekBaseURL,
  readLocalSettings, setProfilePatchPath,
} from '../../src/credential/provider-routes.js';
import type { ProxyRoute } from '../../src/credential/provider-routes.js';

describe('deepseekRoute', () => {
  it('返回固定前缀 /anthropic', () => {
    const route = deepseekRoute();
    assert.equal(route.prefix, '/anthropic');
  });

  it('上游 origin 为 https://api.deepseek.com', () => {
    const route = deepseekRoute();
    assert.equal(route.upstreamOrigin, 'https://api.deepseek.com');
  });

  it('上游路径为 /anthropic', () => {
    const route = deepseekRoute();
    assert.equal(route.upstreamPath, '/anthropic');
  });

  it('keyEnv 为 DEEPSEEK_API_KEY', () => {
    const route = deepseekRoute();
    assert.equal(route.keyEnv, 'DEEPSEEK_API_KEY');
  });

  it('label 为 DeepSeek', () => {
    const route = deepseekRoute();
    assert.equal(route.label, 'DeepSeek');
  });

  it('每次调用返回结构相同的对象', () => {
    const a = deepseekRoute();
    const b = deepseekRoute();
    assert.deepEqual(a, b);
  });
});

describe('DeepSeek 官方模型自定义 baseURL', () => {
  it('从 llm-deepseek 配置提取 baseURL', () => {
    const yaml = `
llm-deepseek:
  baseURL: https://gateway.example.com/api
`;
    assert.equal(extractDeepseekBaseURL(yaml), 'https://gateway.example.com/api');
  });

  it('兼容 llm-deepseek.config.baseURL 包装层', () => {
    const yaml = `
llm-deepseek:
  config:
    baseURL: https://gateway.example.com/v1
`;
    assert.equal(extractDeepseekBaseURL(yaml), 'https://gateway.example.com/v1');
  });

  it('llm-deepseek 未配置时回退 llm-deepseek-account', () => {
    const yaml = `
llm-deepseek-account:
  baseURL: https://account-gateway.example.com/v1
`;
    assert.equal(extractDeepseekBaseURL(yaml), 'https://account-gateway.example.com/v1');
  });

  it('自定义路径以 /v1 结尾时去掉 v1（远端仍会追加 /v1）', () => {
    const route = deepseekRoute('https://gateway.example.com/api/v1');
    assert.equal(route.prefix, '/anthropic');
    assert.equal(route.upstreamOrigin, 'https://gateway.example.com');
    assert.equal(route.upstreamPath, '/api');
  });

  it('自定义路径不以 /v1 结尾时原样保留', () => {
    const route = deepseekRoute('https://gateway.example.com/api');
    assert.equal(route.upstreamOrigin, 'https://gateway.example.com');
    assert.equal(route.upstreamPath, '/api');
  });

  it('模型列表路由跟随自定义 origin', () => {
    const route = deepseekModelsRoute('https://gateway.example.com/api/v1');
    assert.equal(route.prefix, '/models');
    assert.equal(route.upstreamOrigin, 'https://gateway.example.com');
    assert.equal(route.upstreamPath, '/models');
  });

  it('默认仍为官方 api.deepseek.com', () => {
    assert.deepEqual(deepseekRoute(), {
      prefix: '/anthropic',
      upstreamOrigin: 'https://api.deepseek.com',
      upstreamPath: '/anthropic',
      keyEnv: 'DEEPSEEK_API_KEY',
      label: 'DeepSeek',
    });
  });
});

describe('extractProviderRoutes', () => {
  // ─── 有效输入 ───────────────────────────────────────────────
  describe('有效 settings 文本', () => {
    it('单个供应商正确解析', () => {
      const yaml = `
llm-pi-ai:
  providers:
    openai:
      apiKeyEnv: OPENAI_API_KEY
      baseURL: https://api.openai.com/v1
`;
      const routes = extractProviderRoutes(yaml);
      assert.equal(routes.length, 1);
      assert.equal(routes[0].prefix, '/r/openai');
      assert.equal(routes[0].upstreamOrigin, 'https://api.openai.com');
      assert.equal(routes[0].upstreamPath, '/v1');
      assert.equal(routes[0].keyEnv, 'OPENAI_API_KEY');
      assert.equal(routes[0].label, 'openai');
    });

    it('多个供应商全部解析', () => {
      const yaml = `
llm-pi-ai:
  providers:
    openai:
      apiKeyEnv: OPENAI_API_KEY
      baseURL: https://api.openai.com/v1
    anthropic:
      apiKeyEnv: ANTHROPIC_API_KEY
      baseURL: https://api.anthropic.com
    gemini:
      apiKeyEnv: GEMINI_API_KEY
      baseURL: https://generativelanguage.googleapis.com/v1beta
`;
      const routes = extractProviderRoutes(yaml);
      assert.equal(routes.length, 3);
      const names = routes.map(r => r.label).sort();
      assert.deepEqual(names, ['anthropic', 'gemini', 'openai']);
    });

    it('baseURL 无路径时 upstreamPath 为空串', () => {
      const yaml = `
llm-pi-ai:
  providers:
    test:
      apiKeyEnv: TEST_KEY
      baseURL: https://example.com
`;
      const routes = extractProviderRoutes(yaml);
      assert.equal(routes.length, 1);
      assert.equal(routes[0].upstreamPath, '');
      assert.equal(routes[0].upstreamOrigin, 'https://example.com');
    });

    it('baseURL 尾部斜杠被去除', () => {
      const yaml = `
llm-pi-ai:
  providers:
    test:
      apiKeyEnv: TEST_KEY
      baseURL: https://example.com/api/v1/
`;
      const routes = extractProviderRoutes(yaml);
      assert.equal(routes.length, 1);
      assert.equal(routes[0].upstreamPath, '/api/v1');
    });

    it('http 协议也接受', () => {
      const yaml = `
llm-pi-ai:
  providers:
    local:
      apiKeyEnv: LOCAL_KEY
      baseURL: http://localhost:8080/v1
`;
      const routes = extractProviderRoutes(yaml);
      assert.equal(routes.length, 1);
      assert.equal(routes[0].upstreamOrigin, 'http://localhost:8080');
    });
  });

  // ─── 过滤规则 ───────────────────────────────────────────────
  describe('过滤不完整供应商', () => {
    it('缺少 apiKeyEnv 的供应商被跳过', () => {
      const yaml = `
llm-pi-ai:
  providers:
    incomplete:
      baseURL: https://api.example.com
`;
      const routes = extractProviderRoutes(yaml);
      assert.equal(routes.length, 0);
    });

    it('缺少 baseURL 的供应商被跳过', () => {
      const yaml = `
llm-pi-ai:
  providers:
    incomplete:
      apiKeyEnv: MY_KEY
`;
      const routes = extractProviderRoutes(yaml);
      assert.equal(routes.length, 0);
    });

    it('apiKeyEnv 非法环境变量名被跳过', () => {
      const yaml = `
llm-pi-ai:
  providers:
    bad:
      apiKeyEnv: "123INVALID"
      baseURL: https://api.example.com
`;
      const routes = extractProviderRoutes(yaml);
      assert.equal(routes.length, 0);
    });

    it('apiKeyEnv 含特殊字符被跳过', () => {
      const yaml = `
llm-pi-ai:
  providers:
    bad:
      apiKeyEnv: "MY-KEY"
      baseURL: https://api.example.com
`;
      const routes = extractProviderRoutes(yaml);
      assert.equal(routes.length, 0);
    });

    it('baseURL 非法 URL 被跳过', () => {
      const yaml = `
llm-pi-ai:
  providers:
    bad:
      apiKeyEnv: MY_KEY
      baseURL: "not a url"
`;
      const routes = extractProviderRoutes(yaml);
      assert.equal(routes.length, 0);
    });

    it('baseURL 非 http/https 协议被跳过', () => {
      const yaml = `
llm-pi-ai:
  providers:
    ftp:
      apiKeyEnv: FTP_KEY
      baseURL: ftp://files.example.com
`;
      const routes = extractProviderRoutes(yaml);
      assert.equal(routes.length, 0);
    });

    it('混合有效和无效供应商只返回有效的', () => {
      const yaml = `
llm-pi-ai:
  providers:
    good:
      apiKeyEnv: GOOD_KEY
      baseURL: https://api.good.com
    no-key:
      baseURL: https://api.nokey.com
    no-url:
      apiKeyEnv: NOURL_KEY
`;
      const routes = extractProviderRoutes(yaml);
      assert.equal(routes.length, 1);
      assert.equal(routes[0].label, 'good');
    });
  });

  // ─── 空/无效输入 ────────────────────────────────────────────
  describe('空与无效输入', () => {
    it('空字符串返回空数组', () => {
      assert.deepEqual(extractProviderRoutes(''), []);
    });

    it('无 llm-pi-ai 段返回空数组', () => {
      const yaml = `
other-section:
  key: value
`;
      assert.deepEqual(extractProviderRoutes(yaml), []);
    });

    it('providers 为空对象返回空数组', () => {
      const yaml = `
llm-pi-ai:
  providers: {}
`;
      assert.deepEqual(extractProviderRoutes(yaml), []);
    });

    it('providers 缺失返回空数组', () => {
      const yaml = `
llm-pi-ai:
  otherKey: value
`;
      assert.deepEqual(extractProviderRoutes(yaml), []);
    });

    it('YAML 语法错误返回空数组而非抛异常', () => {
      assert.deepEqual(extractProviderRoutes('{{invalid yaml'), []);
    });

    it('顶层不是对象返回空数组', () => {
      assert.deepEqual(extractProviderRoutes('- just a list'), []);
    });
  });

  // ─── 路由前缀命名空间 ──────────────────────────────────────
  describe('路由前缀格式', () => {
    it('所有 pi-ai 路由以 /r/ 开头', () => {
      const yaml = `
llm-pi-ai:
  providers:
    openai:
      apiKeyEnv: OPENAI_API_KEY
      baseURL: https://api.openai.com/v1
    azure:
      apiKeyEnv: AZURE_KEY
      baseURL: https://azure.openai.com/v1
`;
      const routes = extractProviderRoutes(yaml);
      for (const route of routes) {
        assert.ok(route.prefix.startsWith('/r/'));
      }
    });

    it('不与 DeepSeek 前缀 /anthropic 冲突', () => {
      const yaml = `
llm-pi-ai:
  providers:
    anthropic:
      apiKeyEnv: ANTHROPIC_KEY
      baseURL: https://api.anthropic.com
`;
      const routes = extractProviderRoutes(yaml);
      assert.equal(routes.length, 1);
      assert.notEqual(routes[0].prefix, '/anthropic');
      assert.equal(routes[0].prefix, '/r/anthropic');
    });
  });
});

describe('readLocalSettings（profile patch）', () => {
  it('同时返回 llm-deepseek 与 llm-pi-ai 配置段', () => {
    const dir = mkdtempSync(join(tmpdir(), 'provider-routes-'));
    const patchPath = join(dir, 'cordis.patch.yml');
    try {
      writeFileSync(patchPath, `
- id: llm-deepseek
  config:
    baseURL: https://gateway.example.com/api
- id: llm-pi-ai
  config:
    providers:
      custom:
        apiKeyEnv: CUSTOM_KEY
        baseURL: https://custom.example.com/v1
`);
      setProfilePatchPath(patchPath);
      const settings = readLocalSettings();
      assert.ok(settings !== undefined);
      assert.equal(extractDeepseekBaseURL(settings), 'https://gateway.example.com/api');
      assert.equal(extractProviderRoutes(settings).length, 1);
    } finally {
      // 恢复为不存在的路径，避免影响同进程其他用例
      setProfilePatchPath(join(dir, 'missing.yml'));
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

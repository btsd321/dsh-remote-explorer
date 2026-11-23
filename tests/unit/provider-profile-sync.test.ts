/**
 * @file provision/profile-writer.ts 的供应商设置文档同步单元测试
 * @description 用带内存文件表的远端替身捕获「探测 → 读取 → 合并 → 原子写」全流程，
 *              验证三条安全契约：只换 llm-pi-ai 一条、读取失败绝不当成新文档、
 *              内容等价时不重写。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'yaml';
import { syncProviderProfileEntry } from '../../src/credential/provider-profile-sync.ts';
import { createRemotePaths } from '../../src/provision/remote-paths.ts';
import type { RemoteTransport } from '../../src/transport/types.ts';
import type { ProviderPatchEntry } from '../../src/credential/provider-routes.ts';

/** 远端文件表 + 命令替身（只认本模块实际发出的那几条命令）。 */
function fixture(files: Record<string, string> = {}) {
  const tree = new Map<string, string>(Object.entries(files));
  /** `cat` 的退出码可被调小以模拟读取失败 */
  let catExitCode = 0;
  const commands: string[] = [];

  /**
   * 按 POSIX 引号规则切分命令参数。
   *
   * 注意 `quote()` 对「只含安全字符」的值**不加引号**（远端路径就属于这种），
   * 所以不能只靠正则抓单引号片段。
   */
  function tokens(command: string): string[] {
    const out: string[] = [];
    let current = '';
    let quoted = false;
    for (let index = 0; index < command.length; index += 1) {
      const char = command[index]!;
      if (char === "'") {
        quoted = !quoted;
        continue;
      }
      if (!quoted && /\s/.test(char)) {
        if (current !== '') {
          out.push(current);
          current = '';
        }
        continue;
      }
      current += char;
    }
    if (current !== '') out.push(current);
    return out;
  }

  const transport = {
    hostAlias: 'myhost',
    async exec(command: string) {
      commands.push(command);
      const parts = tokens(command);
      if (command.startsWith('test -e ')) {
        const path = parts[2] ?? '';
        return { stdout: tree.has(path) ? 'YES\n' : 'NO\n', stderr: '', exitCode: 0 };
      }
      if (command.startsWith('cat ')) {
        const path = parts[1] ?? '';
        if (catExitCode !== 0) return { stdout: '', stderr: 'read failed', exitCode: catExitCode };
        return {
          stdout: tree.get(path) ?? '',
          stderr: tree.has(path) ? '' : 'No such file',
          exitCode: tree.has(path) ? 0 : 1,
        };
      }
      if (command.startsWith('chmod 600 ')) {
        const from = parts[2] ?? '';
        const to = parts[parts.length - 1] ?? '';
        const content = tree.get(from);
        if (content === undefined) return { stdout: '', stderr: 'missing', exitCode: 1 };
        tree.delete(from);
        tree.set(to, content);
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    },
    async writeRemoteFile(path: string, content: string) {
      tree.set(path, content);
    },
  } as unknown as RemoteTransport;

  const paths = createRemotePaths('/home/youruser');
  return {
    ctx: { transport, paths },
    paths,
    read: (path: string) => tree.get(path),
    commands,
    failCat: () => { catExitCode = 1; },
  };
}

/** 供应商条目替身（baseURL 已指向隧道）。 */
const ENTRY: ProviderPatchEntry = {
  id: 'llm-pi-ai',
  name: '@deepseek-ai/dsh-llm-pi-ai',
  config: {
    providers: {
      gw: { apiKeyEnv: 'GW_KEY', api: 'openai-completions', baseURL: 'http://127.0.0.1:40123/r/gw', models: [{ id: 'model-a', name: 'model-a' }] },
    },
  },
};

test('写入走临时文件 + rename，且保留其它条目与头部注释', async () => {
  const patchPath = createRemotePaths('/home/youruser').hostProfilePatch('web');
  const f = fixture({
    [patchPath]: `# Your patch layer for this dsh profile
- id: agent-default-model
  config:
    provider: gw
    model: model-a
`,
  });

  const written = await syncProviderProfileEntry(f.ctx, ENTRY);

  assert.equal(written, patchPath);
  // 原子写：先写 .tmp，再 mv 到目标；不直接截断目标文件
  assert.ok(f.commands.some(command => command.startsWith('chmod 600 ') && command.includes(`${patchPath}.tmp`)));
  assert.equal(f.read(`${patchPath}.tmp`), undefined);

  const text = f.read(patchPath);
  assert.ok(text !== undefined);
  assert.ok(text.startsWith('# Your patch layer for this dsh profile\n'));
  const entries = parse(text) as Record<string, unknown>[];
  assert.deepEqual(entries.map(item => item['id']), ['agent-default-model', 'llm-pi-ai']);
  const llm = entries[1] as { config: { providers: Record<string, { baseURL?: string }> } };
  assert.equal(llm.config.providers['gw']?.baseURL, 'http://127.0.0.1:40123/r/gw');
});

test('文件不存在时创建该条目', async () => {
  const f = fixture();
  await syncProviderProfileEntry(f.ctx, ENTRY);
  const text = f.read(f.paths.hostProfilePatch('web'));
  assert.ok(text !== undefined);
  assert.deepEqual((parse(text) as Record<string, unknown>[]).map(item => item['id']), ['llm-pi-ai']);
});

test('读取失败（非零退出）时抛错且不写文件——绝不把读失败当成新文档', async () => {
  const patchPath = createRemotePaths('/home/youruser').hostProfilePatch('web');
  const original = '- id: agent-default-model\n  config:\n    provider: gw\n';
  const f = fixture({ [patchPath]: original });
  f.failCat();

  await assert.rejects(syncProviderProfileEntry(f.ctx, ENTRY), /读取 profile 设置文档失败/);
  assert.equal(f.read(patchPath), original);
  assert.ok(!f.commands.some(command => command.startsWith('chmod 600 ')));
});

test('文档无法解析时抛错且不写文件（不覆盖用户配置）', async () => {
  const patchPath = createRemotePaths('/home/youruser').hostProfilePatch('web');
  const f = fixture({ [patchPath]: '{{broken yaml' });

  await assert.rejects(syncProviderProfileEntry(f.ctx, ENTRY), /无法解析/);
  assert.equal(f.read(patchPath), '{{broken yaml');
  assert.ok(!f.commands.some(command => command.startsWith('chmod 600 ')));
});

test('内容已等价时跳过写入（不触动远端 hmr / 设置页刷新）', async () => {
  const patchPath = createRemotePaths('/home/youruser').hostProfilePatch('web');
  // 先写一次得到规范化文本，再用同一 entry 同步第二次
  const first = fixture({ [patchPath]: '- id: other\n  config: {}\n' });
  await syncProviderProfileEntry(first.ctx, ENTRY);
  const settled = first.read(patchPath)!;

  const second = fixture({ [patchPath]: settled });
  await syncProviderProfileEntry(second.ctx, ENTRY);
  assert.ok(!second.commands.some(command => command.startsWith('chmod 600 ')));
  assert.equal(second.read(patchPath), settled);
});

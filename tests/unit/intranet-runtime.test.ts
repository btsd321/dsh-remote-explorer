/**
 * @file 内网运行时部署（existing）单元与真实 shell 回归
 * @description 覆盖部署方式归一、内网 npm 源/Node 路径校验，以及 existing
 *              模式在真实 POSIX shell 下的私有 shim、.npmrc 写入与完整引导
 *              路径。测试不访问公网：任何 Node 镜像或公共 registry 调用都会
 *              在最小替身环境中失败，从而暴露回归。
 *
 * Windows 上没有 POSIX 符号链接与 /bin/sh，整体跳过；对应纯函数用例仍可运行。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm, readlink, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  inspectExistingNode,
  isValidDeploymentMode,
  nodeVersionAccepted,
  normalizeNpmRegistry,
  prepareExistingRuntime,
  resolveDeploymentMode,
  validateNodePath,
  validateNpmRegistry,
  ensureProfileNpmRegistry,
} from '../../src/provision/intranet-runtime.ts';
import { installLockHint, lockInstallCommand } from '../../src/provision/install-lock.ts';
import { provision } from '../../src/provision/provisioner.ts';
import { createRemotePaths } from '../../src/provision/remote-paths.ts';
import type { ExecOptions, RemoteTransport } from '../../src/transport/types.ts';

const exec = promisify(execFile);
const posixOnly = process.platform === 'win32' ? '需要真实 POSIX shell 与符号链接' : false;

/** 创建带 fake node/npm 的隔离 HOME。 */
async function createFixture(): Promise<{ root: string; home: string; fakeBin: string }> {
  const root = await mkdtemp(join(tmpdir(), 'intranet-runtime-'));
  const home = join(root, 'home');
  const fakeBin = join(root, 'fake-bin');
  await mkdir(home, { recursive: true });
  await mkdir(fakeBin, { recursive: true });

  const node = `#!/bin/sh
if [ "$1" = "-v" ]; then echo v24.21.0; exit 0; fi
exit 0
`;
  const npm = `#!/bin/sh
set -e
if [ "$1" = "-v" ]; then echo 10.9.0; exit 0; fi
if [ "$1" = "view" ]; then
  if [ "$2" = "@deepseek-ai/dsh" ]; then
    if [ "$3" = "versions" ]; then echo '["0.2.0-rc.2"]'; else echo 0.2.0-rc.2; fi
    exit 0
  fi
fi
if [ "$1" = "install" ]; then
  prefix=""
  prev=""
  for arg in "$@"; do
    if [ "$prev" = "--prefix" ]; then prefix="$arg"; fi
    prev="$arg"
  done
  case "$*" in
    *"@deepseek-ai/dsh@"*)
      ver=$(printf '%s' "$*" | sed -n 's/.*@deepseek-ai\\/dsh@\\([^ ]*\\).*/\\1/p')
      mkdir -p "$PWD/node_modules/@deepseek-ai/dsh" "$PWD/node_modules/.bin"
      printf '{"version":"%s"}' "$ver" > "$PWD/node_modules/@deepseek-ai/dsh/package.json"
      cat > "$PWD/node_modules/.bin/dsh" <<EOF
#!/bin/sh
case " \\$* " in
  *" --version "*) echo "$ver"; exit 0 ;;
esac
case " \\$* " in
  *" --dump-config "*)
    mkdir -p "\\$DSH_HOME/profiles/web"
    printf '{"dependencies":{},"dsh":{"profile":{"bundles":[]}}}' > "\\$DSH_HOME/profiles/web/package.json"
    exit 0
    ;;
esac
exit 0
EOF
      chmod +x "$PWD/node_modules/.bin/dsh"
      ;;
    *"pnpm@"*)
      mkdir -p "$prefix/lib/node_modules/pnpm" "$prefix/bin"
      printf '{"version":"11.7.0","name":"pnpm"}' > "$prefix/lib/node_modules/pnpm/package.json"
      printf '#!/bin/sh\nexit 0\n' > "$prefix/bin/pnpm"
      chmod +x "$prefix/bin/pnpm"
      ;;
  esac
  exit 0
fi
exit 0
`;
  await writeFile(join(fakeBin, 'node'), node, { mode: 0o755 });
  await writeFile(join(fakeBin, 'npm'), npm, { mode: 0o755 });
  // macOS 自带没有 flock；测试只替代互斥包装，不替代被测 shell/文件系统
  await writeFile(join(fakeBin, 'flock'), '#!/bin/sh\nshift 4\nexec /bin/sh -c "$1"\n', { mode: 0o755 });
  await chmod(join(fakeBin, 'node'), 0o755);
  await chmod(join(fakeBin, 'npm'), 0o755);
  await chmod(join(fakeBin, 'flock'), 0o755);
  return { root, home, fakeBin };
}

/** 用真实 /bin/sh 承载命令；只暴露 fake node/npm 与系统基础命令。 */
function makeTransport(root: string, fakeBin: string): RemoteTransport & { commands: string[] } {
  const commands: string[] = [];
  return {
    hostAlias: 'myhost',
    isAlive: true,
    platform: { os: 'darwin', arch: 'arm64', rawOs: 'Darwin', rawArch: 'arm64' },
    commands,
    async exec(command: string, options: ExecOptions = {}) {
      commands.push(command);
      try {
        const result = await exec('/bin/sh', ['-c', command], {
          cwd: root,
          env: {
            HOME: root,
            ...options.env,
            PATH: `${options.pathPrefix ? `${options.pathPrefix}:` : ''}${fakeBin}:/usr/bin:/bin:/usr/sbin:/sbin`,
          },
          timeout: options.timeoutMs ?? 30_000,
        });
        return { ...result, exitCode: 0 };
      } catch (error) {
        if (!options.allowNonZeroExit) throw error;
        const e = error as Error & { stdout: string; stderr: string; code: number };
        return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', exitCode: e.code ?? 1 };
      }
    },
    async writeRemoteFile(path: string, content: string) {
      await writeFile(path, content, 'utf8');
    },
    async uploadFile(local: string, remote: string) {
      await writeFile(remote, await readFile(local));
    },
    async readRemoteFile(path: string) {
      return await readFile(path);
    },
  } as unknown as RemoteTransport & { commands: string[] };
}

test('部署方式/地址/路径纯函数校验', () => {
  assert.equal(isValidDeploymentMode('existing'), true);
  assert.equal(isValidDeploymentMode('auto'), true);
  assert.equal(isValidDeploymentMode('offline'), true);
  assert.equal(isValidDeploymentMode('bogus'), false);

  assert.equal(nodeVersionAccepted('v24.21.0'), true);
  assert.equal(nodeVersionAccepted('v22.19.0'), true);
  assert.equal(nodeVersionAccepted('v22.18.9'), false);
  assert.equal(nodeVersionAccepted('v20.11.0'), false);
  assert.equal(nodeVersionAccepted('not-a-version'), false);

  assert.equal(validateNpmRegistry('https://nexus.example.com/repository/npm/'), undefined);
  assert.match(validateNpmRegistry('https://user:pass@nexus.example.com/npm') ?? '', /用户名或密码/);
  assert.match(validateNpmRegistry('ftp://nexus.example.com/npm') ?? '', /http 或 https/);
  assert.match(validateNpmRegistry('https://nexus.example.com/npm?x=1') ?? '', /查询串/);
  assert.match(validateNpmRegistry('') ?? '', /不能为空/);
  assert.equal(normalizeNpmRegistry('https://nexus.example.com/npm/'), 'https://nexus.example.com/npm');

  assert.equal(validateNodePath('/opt/node/bin/node'), undefined);
  assert.match(validateNodePath('C:/node/node.exe') ?? '', /绝对路径/);
  assert.match(validateNodePath('/opt/node\\bin\\node') ?? '', /POSIX/);
});

test('部署方式优先级：环境变量硬开关优先、显式值覆盖旧 offline', () => {
  const old = process.env.DSH_REMOTE_OFFLINE;
  try {
    delete process.env.DSH_REMOTE_OFFLINE;
    assert.equal(resolveDeploymentMode(undefined, undefined), 'auto');
    assert.equal(resolveDeploymentMode(undefined, true), 'offline');
    assert.equal(resolveDeploymentMode('existing', true), 'existing');
    assert.equal(resolveDeploymentMode('auto', true), 'auto');

    process.env.DSH_REMOTE_OFFLINE = '1';
    assert.equal(resolveDeploymentMode(undefined, false), 'offline');
    assert.equal(resolveDeploymentMode('auto', false), 'offline');
    assert.throws(() => resolveDeploymentMode('existing', false), /严格离线/);
  } finally {
    if (old === undefined) delete process.env.DSH_REMOTE_OFFLINE;
    else process.env.DSH_REMOTE_OFFLINE = old;
  }
});

test('安装锁先创建 tmp 父目录，且不会把 flock 缺命令误报成等锁', () => {
  const paths = createRemotePaths('/home/tester');
  const command = lockInstallCommand(paths, 'echo ok');
  assert.ok(command.startsWith(`mkdir -p ${paths.tmpRoot} && flock -w `), command);
  assert.match(installLockHint('/bin/sh: flock: command not found') ?? '', /缺少 flock/);
  assert.match(installLockHint('flock: cannot open lock file /x: No such file or directory') ?? '', /锁文件不可写/);
  assert.match(installLockHint('flock: failed to get lock') ?? '', /等锁超时/);
});

test('existing 模式创建私有 shim，不写系统 Node 目录', { skip: posixOnly }, async () => {
  const { root, fakeBin } = await createFixture();
  try {
    const paths = createRemotePaths(root);
    const ctx = { transport: makeTransport(root, fakeBin), paths };
    const result = await prepareExistingRuntime(ctx, { nodePath: join(fakeBin, 'node') });
    assert.equal(result.node.version, 'v24.21.0');
    assert.equal(result.node.binDir, paths.existingRuntimeBinDir);
    assert.equal(await readlink(join(paths.existingRuntimeBinDir, 'node')), join(fakeBin, 'node'));
    assert.equal(await readlink(join(paths.existingRuntimeBinDir, 'npm')), join(fakeBin, 'npm'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ensureProfileNpmRegistry 保留其它 .npmrc 配置并幂等', { skip: posixOnly }, async () => {
  const { root, fakeBin } = await createFixture();
  try {
    const paths = createRemotePaths(root);
    const profileDir = paths.hostProfileDir('web');
    await mkdir(profileDir, { recursive: true });
    await writeFile(join(profileDir, '.npmrc'), 'strict-peer-dependencies=true\nregistry=https://old.example.com/\n', 'utf8');
    const ctx = { transport: makeTransport(root, fakeBin), paths };
    assert.equal(await ensureProfileNpmRegistry(ctx, 'https://nexus.example.com/repository/npm/'), true);
    const first = await readFile(join(profileDir, '.npmrc'), 'utf8');
    assert.match(first, /strict-peer-dependencies=true/);
    assert.match(first, /registry=https:\/\/nexus\.example\.com\/repository\/npm/);
    assert.match(first, /old\.example\.com/);
    assert.equal(await ensureProfileNpmRegistry(ctx, 'https://nexus.example.com/repository/npm/'), false);
    assert.equal(await ensureProfileNpmRegistry(ctx, undefined), true);
    assert.equal(await readFile(join(profileDir, '.npmrc'), 'utf8'), 'strict-peer-dependencies=true\nregistry=https://old.example.com/\n');
    assert.equal(await ensureProfileNpmRegistry(ctx, undefined), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('existing 模式完整引导：只访问内网源，不触发公共 Node/registry', { skip: posixOnly }, async () => {
  const { root, fakeBin } = await createFixture();
  const transport = makeTransport(root, fakeBin);
  try {
    const result = await provision(transport, {
      sessionId: 'test-session',
      deploymentMode: 'existing',
      nodePath: join(fakeBin, 'node'),
      npmRegistry: 'https://nexus.example.com/repository/npm/',
    });
    assert.equal(result.deploymentMode, 'existing');
    assert.equal(result.node.version, 'v24.21.0');
    assert.equal(result.dsh.version, '0.2.0-rc.2');
    const commands = transport.commands.join('\n');
    assert.doesNotMatch(commands, /nodejs\.org|registry\.npmjs\.org|mirrors\./);
    assert.match(commands, /--registry='?https:\/\/nexus\.example\.com\/repository\/npm/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test('existing 探测支持带空格的 Node/npm 路径', { skip: posixOnly }, async () => {
  const fixture = await createFixture();
  try {
    const bin = join(fixture.root, 'node with spaces');
    await mkdir(bin);
    for (const name of ['node', 'npm']) {
      await writeFile(join(bin, name), await readFile(join(fixture.fakeBin, name)), { mode: 0o755 });
    }
    const transport = makeTransport(fixture.home, bin);
    const result = await inspectExistingNode({ transport, paths: createRemotePaths(fixture.home) }, { nodePath: join(bin, 'node') });
    assert.equal(result.nodeVersion, 'v24.21.0');
    assert.equal(result.npmVersion, '10.9.0');
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('existing 指定不存在的 Node 路径报告路径错误而不是版本错误', { skip: posixOnly }, async () => {
  const fixture = await createFixture();
  try {
    const transport = makeTransport(fixture.home, fixture.fakeBin);
    await assert.rejects(inspectExistingNode({ transport, paths: createRemotePaths(fixture.home) }, {
      nodePath: join(fixture.root, 'missing-node'),
    }), /指定 Node 路径不存在或不可执行/);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

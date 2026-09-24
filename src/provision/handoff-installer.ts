/**
 * @file 远端交接组件（handoff）的 store 级安装
 * @description 合成包 `dsh-remote-handoff`（宿主半 + 浏览器半 + insert patch）
 *              写进**用户级 plugin store**（不再写会话 profile）：该远程账号的
 *              所有会话经 store symlink 共享同一份 handoff，新会话零额外安装。
 *
 * 0.4.0 的「远端不装插件」红线经用户拍板解除——前提是每个会话的远端 dsh 跑
 * 在独立 `DSH_HOME`（`sessions/<id>/`），与远端他人的 `~/.dsh` 零交集；store
 * 同样在本工具远端根内，隔离契约不破。
 *
 * 幂等按包目录标记：store 里已有 handoff 包目录则只确保登记（manifest 含
 * deps+bundles），文件内容每次重写自愈（老内容如空 patch 重连一次即修复）。
 * 老会话补装时若远端进程仍存活复用，菜单要等下一次远端重启才出现（迟到但
 * 不缺席，降级期间远端页面零感知）。
 */

import { quote } from '../util/shell-quote.js';
import { writeRemoteTextFile } from '../transport/write-text.js';
import { HANDOFF_PKG_NAME } from '../handoff/protocol.js';
import { loadHandoffPayload } from '../handoff/payload.js';
import {
  ensureHostProfile, readPluginStoreManifest, transportIo, writePluginStoreManifest,
  DEFAULT_PLATFORM,
} from './plugin-store.js';
import type { RemoteContext } from './remote-context.js';

/**
 * handoff 合成包的 bundle patch：bundle 层在 boot 里就是**一层 patch**——宿主半
 * entry 靠 insert 行进 entry 树（本仓库 cordis.patch.yml 的同款机制）。空 patch
 * 列表等于这层什么都不贡献，宿主半永远不加载（实测踩过）。
 */
const HANDOFF_PATCH_YAML = `- insert:
    - id: ${HANDOFF_PKG_NAME}
      name: '${HANDOFF_PKG_NAME}'
`;

/**
 * 合成包清单：bundle 元数据指向上面的 insert patch，client 元数据让 boot graph
 * 把浏览器半扫进组合脚本。
 * @returns 清单文本
 */
function renderHandoffPackageJson(): string {
  return `${JSON.stringify({
    name: HANDOFF_PKG_NAME,
    version: '0.0.0',
    private: true,
    type: 'module',
    main: 'index.js',
    exports: {
      '.': './index.js',
      './client': './client.js',
      './cordis.patch.yml': './cordis.patch.yml',
      './package.json': './package.json',
    },
    dsh: {
      bundle: { patch: './cordis.patch.yml' },
      client: {
        inject: [
          '@deepseek-ai/dsh-client-ui-renderer',
          '@deepseek-ai/dsh-client-locale',
        ],
        platform: 'web',
      },
    },
  }, undefined, 2)}\n`;
}

/**
 * 安装/自愈 store 里的 handoff 合成包并登记启用。
 *
 * @param ctx - 远端执行上下文
 * @param dshVersion - 会话使用的 dsh 版本（store 回退链接锚定）
 * @returns true = 本次新装包目录；false = 已存在（内容仍重写自愈）
 * @throws Error 产物载荷缺失（开发流程没跑过 build-plugin）
 */
export async function installHandoffBundle(
  ctx: RemoteContext,
  dshVersion: string,
): Promise<boolean> {
  const { transport, paths } = ctx;
  await ensureHostProfile(ctx, dshVersion);

  const pkgDir = `${paths.hostProfileNodeModules(DEFAULT_PLATFORM)}/${HANDOFF_PKG_NAME}`;
  const marker = await transport.exec(
    `test -f ${quote(`${pkgDir}/package.json`)} && echo EXISTS || true`,
    { allowNonZeroExit: true },
  );
  const fresh = !marker.stdout.includes('EXISTS');

  const payload = loadHandoffPayload();
  if (payload === undefined) {
    throw new Error('handoff 产物缺失——分发形态需先跑 scripts/build-plugin.ts');
  }

  await transport.exec(`mkdir -p ${quote(pkgDir)}`, {});
  const files: [string, string][] = [
    ['package.json', renderHandoffPackageJson()],
    ['index.js', payload.host],
    ['client.js', payload.client],
    ['cordis.patch.yml', HANDOFF_PATCH_YAML],
  ];
  for (const [name, content] of files) {
    await writeRemoteTextFile(transport, `${pkgDir}/${name}`, content, {});
  }

  // 登记进 store manifest：**只进 bundles，不进 dependencies**——handoff 是
  // 本工具直接落盘的合成包，不经 pnpm；deps 里的 file: 自指 spec 会让 pnpm
  // 把它当 linked dependency 安装并报 LINKED_PKG_DIR_NOT_FOUND（实测）。
  // 旧版本写过的 deps 条目在此迁移清除
  const io = transportIo(transport);
  const manifest = await readPluginStoreManifest(io, paths);
  const deps = { ...(manifest.dependencies ?? {}) };
  const bundles = manifest.dsh?.profile?.bundles ?? [];
  let changed = false;
  if (deps[HANDOFF_PKG_NAME] !== undefined) {
    delete deps[HANDOFF_PKG_NAME];
    changed = true;
  }
  if (!bundles.includes(HANDOFF_PKG_NAME)) {
    bundles.push(HANDOFF_PKG_NAME);
    changed = true;
  }
  if (changed) {
    await writePluginStoreManifest(io, paths, {
      ...manifest,
      dependencies: deps,
      dsh: { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles } },
    });
  }
  return fresh;
}

/**
 * @file 会话级 handoff 组件的远端安装
 * @description 把合成包 `dsh-remote-handoff`（宿主半 + 浏览器半 + 空 patch）
 *              写进**新会话** profile 的 node_modules，并登记进 profile 清单的
 *              dependencies 与 `dsh.profile.bundles`——远端 dsh 启动时即加载它，
 *              远端页面由此获得「本机连接管理」菜单（VS Code 状态栏远端标识的
 *              等价物，设计见 src/handoff/protocol.ts 文件头）。
 *
 * **幂等按合成包标记安装**：远端已有包目录则立即跳过（每次连接只多一条
 * `test -f`）。老会话（功能上线前建的 profile）在下次连接时补装；若远端 dsh
 * 进程彼时仍存活复用，bundle 要等下一次远端重启才加载——菜单迟到但不缺席，
 * 优雅降级期间远端页面零感知。
 *
 * 隔离依据：会话 profile 在 `sessions/<id>/` 下（每会话独立 DSH_HOME），
 * 与远端他人的 `~/.dsh` 零交集——这是用户拍板解除「远端不装组件」红线的前提。
 *
 * 落盘走 SFTP 主路径（writeRemoteTextFile，远端没开 sftp 子系统时回退 printf）。
 * 文本内容全部本机生成，无远端拼接；包内文件为构建产物原文，不含动态值。
 */

import { quote } from '../util/shell-quote.js';
import { writeRemoteTextFile } from '../transport/write-text.js';
import { loadHandoffPayload } from '../handoff/payload.js';
import { HANDOFF_PKG_NAME } from '../handoff/protocol.js';
import type { RemotePaths } from './remote-paths.js';
import type { RemoteTransport } from '../transport/types.js';

/**
 * 合成包的 bundle patch：bundle 层在 boot 里就是**一层 patch**——宿主半 entry
 * 靠 insert 行进 entry 树（本仓库 cordis.patch.yml 的同款机制）。空 patch 列表
 * 等于这层什么都不贡献，宿主半永远不加载（实测踩过）。
 */
const HANDOFF_PATCH_YAML = `- insert:
    - id: ${HANDOFF_PKG_NAME}
      name: '${HANDOFF_PKG_NAME}'
`;

/**
 * 合成包清单：bundle 元数据指向上面的 insert patch，client 元数据让 boot graph
 * 把浏览器半扫进组合脚本。dependencies 用 file: 自指，pnpm 万一在远端跑起来
 * 也能就地解析而不是去 registry 找不存在的发布版。
 * @param version - 占位版本（诊断用，无发布语义）
 * @returns 清单文本
 */
function renderPackageJson(version: string): string {
  return `${JSON.stringify({
    name: HANDOFF_PKG_NAME,
    version,
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
 * 安装 handoff 合成包进会话 profile 并登记 bundle（幂等）。
 *
 * @param transport - 已连接的传输
 * @param paths - 远端路径集合
 * @param sessionId - 会话 id
 * @returns true = 本次新装；false = 远端已有（文件内容仍重写自愈）
 * @throws Error 产物载荷缺失（开发流程没跑过 build-plugin）或落盘/登记失败
 */
export async function installHandoffBundle(
  transport: RemoteTransport,
  paths: RemotePaths,
  sessionId: string,
): Promise<boolean> {
  const pkgDir = `${paths.sessionProfile(sessionId)}/node_modules/${HANDOFF_PKG_NAME}`;

  // 标记检查只用于回报「新装/已就位」；文件内容每次重写（静态产物，幂等自愈——
  // 装过旧内容（如空 patch）的老会话重连一次即修复）
  const marker = await transport.exec(
    `test -f ${quote(`${pkgDir}/package.json`)} && echo EXISTS || true`,
    { allowNonZeroExit: true },
  );
  const fresh = !marker.stdout.includes('EXISTS');

  const payload = loadHandoffPayload();
  if (payload === undefined) {
    throw new Error('handoff 产物缺失——分发形态需先跑 scripts/build-plugin.ts');
  }

  // 远端 profile 经 --dump-config 初始化，不保证有 node_modules 目录；
  // writeRemoteTextFile 不建父目录，这里先补齐
  await transport.exec(`mkdir -p ${quote(pkgDir)}`, {});
  const files: [string, string][] = [
    ['package.json', renderPackageJson('0.0.0')],
    ['index.js', payload.host],
    ['client.js', payload.client],
    ['cordis.patch.yml', HANDOFF_PATCH_YAML],
  ];
  for (const [name, content] of files) {
    await writeRemoteTextFile(transport, `${pkgDir}/${name}`, content, {});
  }

  // 登记进 profile 清单：dependencies（解析锚）+ dsh.profile.bundles（加载开关）。
  // 读-改-写全程经传输层，清单是本工具自己初始化的 profile，字段形状已知
  const manifestPath = `${paths.sessionProfile(sessionId)}/package.json`;
  const read = await transport.exec(`cat ${quote(manifestPath)}`);
  const manifest = JSON.parse(read.stdout) as {
    dependencies?: Record<string, string>;
    dsh?: { profile?: { bundles?: string[] } };
  };
  const dependencies = manifest.dependencies ?? {};
  dependencies[HANDOFF_PKG_NAME] = `file:./node_modules/${HANDOFF_PKG_NAME}`;
  const bundles = manifest.dsh?.profile?.bundles ?? [];
  if (!bundles.includes(HANDOFF_PKG_NAME)) bundles.push(HANDOFF_PKG_NAME);
  const next = {
    ...manifest,
    dependencies,
    dsh: { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles } },
  };
  await writeRemoteTextFile(
    transport,
    manifestPath,
    `${JSON.stringify(next, undefined, 2)}\n`,
    {},
  );
  return fresh;
}

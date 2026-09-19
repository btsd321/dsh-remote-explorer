/**
 * @file 远端环境自动引导模块
 * @description 自动检测、安装和配置远端 Node 运行时和 harness helper，
 *              实现"连接干净机器即开即用"的体验。
 *
 * 引导流程：
 * 1. 探测远端：检查 Node 是否存在、版本是否足够（>=22）
 * 2. 安装 Node：若缺失，尝试远端包管理器安装；若包管理器不可用，
 *    从 Node 官网下载二进制并解压；若远端下载失败，本地下载后 scp 上传
 * 3. 上传 helper：将 dsh-ssh 的 bundled helper 上传到远端固定目录
 * 4. 计算 helper 摘要并回填到主机档案
 *
 * 安全约束：
 * - helper 安装到 ~/.dsh/helper/（远端用户可写但不工作目录）
 * - 摘要校验沿用 dsh-ssh 的 helperHash 机制
 * - Node 安装到 ~/.dsh/node/（避免污染系统目录）
 */

import { Client, type ClientChannel, type SFTPWrapper } from 'ssh2';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import type { RemoteHostProfile } from './remote-hosts.js';
import { collectHelperDependencies } from './dependency-collector.js';
import { createNodeAddonStub } from './native-stub.js';
import type { ResolvedHost, ResolvedHostWithJump } from './ssh-config-parser.js';

/** 远端探测结果 */
export interface RemoteProbe {
  /** 远端操作系统（uname 输出） */
  os: string;
  /** 远端 CPU 架构（uname -m 输出） */
  arch: string;
  /** Node 可执行文件路径（若存在） */
  nodePath: string | null;
  /** Node 版本（若存在） */
  nodeVersion: string | null;
  /** Node 版本是否满足 >=22.19 或 >=24 */
  nodeSufficient: boolean;
  /** helper 是否已安装 */
  helperInstalled: boolean;
  /** helper 摘要是否匹配（若已安装） */
  helperHashMatch: boolean | null;
}

/** 引导结果：可直接喂给 Ssh2Connection 的配置 */
export interface BootstrapResult {
  /** 远端 Node 路径 */
  node: string;
  /** 远端 helper 路径 */
  helper: string;
  /** helper SHA-256 */
  helperHash: string;
  /** 是否新安装了 Node */
  nodeInstalled: boolean;
  /** 是否新上传了 helper */
  helperUploaded: boolean;
}

/** helper 在远端的安装目录（相对 home 目录） */
const HELPER_DIR = '.dsh/helper';
/** Node 在远端的安装目录（相对 home 目录） */
const NODE_DIR = '.dsh/node';
/** 最小 Node 版本要求 */
const MIN_NODE_MAJOR = 22;
const MIN_NODE_MINOR = 19;

/**
 * 远端环境引导器。
 *
 * 通过 ssh2 连接远端，执行探测和安装命令，
 * 并通过 SFTP 上传 helper 文件。
 */
export class RemoteBootstrap {
  /**
   * 探测远端环境
   * @param profile - 主机档案
   * @returns 探测结果
   */
  async probe(resolved: ResolvedHostWithJump): Promise<RemoteProbe> {
    const { execOutput } = await this.connect(resolved);
    try {
      // 探测 OS 和架构
      const uname = await execOutput('uname -s && uname -m');
      const [os, arch] = uname.trim().split('\n');

      // 探测 Node
      const nodeCheck = await execOutput('which node 2>/dev/null && node --version 2>/dev/null || true');
      const lines = nodeCheck.trim().split('\n').filter(Boolean);
      const nodePath = lines[0] || null;
      const nodeVersion = lines[1] || null;

      let nodeSufficient = false;
      if (nodeVersion) {
        const match = nodeVersion.match(/^v(\d+)\.(\d+)/);
        if (match) {
          const major = parseInt(match[1], 10);
          const minor = parseInt(match[2], 10);
          nodeSufficient = major > MIN_NODE_MAJOR || (major === MIN_NODE_MAJOR && minor >= MIN_NODE_MINOR) || major >= 24;
        }
      }

      // 检查已安装的 helper
      const helperCheck = await execOutput(
        `ls ~/.dsh/helper/helper-entry.js 2>/dev/null && sha256sum ~/.dsh/helper/helper-entry.js 2>/dev/null || true`
      );
      const helperInstalled = helperCheck.trim().length > 0;
      let helperHashMatch: boolean | null = null;
      if (helperInstalled && profile.helperHash) {
        const hashLine = helperCheck.trim().split('\n')[1] || '';
        const installedHash = hashLine.split(/\s+/)[0];
        helperHashMatch = installedHash === profile.helperHash;
      }

      return {
        os, arch, nodePath, nodeVersion, nodeSufficient,
        helperInstalled, helperHashMatch,
      };
    } finally {
      await this.disconnect();
    }
  }

  /**
   * 全自动引导远端环境
   * @param resolved - 从 SSH config 解析的主机配置（含跳板机链）
   * @param helperDirPath - 本地 helper 构建目录路径
   * @returns 引导结果
   */
  async bootstrap(resolved: ResolvedHostWithJump, helperDirPath: string): Promise<BootstrapResult> {
    const client = await this.connectClient(resolved);
    try {
      const { execOutput, sftpUpload } = await this.getClientMethods(client, undefined);

      // 获取远端 home 目录绝对路径（SFTP 不解析 ~）
      const homeDir = (await execOutput('echo $HOME')).trim();

      // 1. 确保 ~/.dsh 目录存在
      const helperDirAbs = `${homeDir}/${HELPER_DIR}`;
      const nodeDirAbs = `${homeDir}/${NODE_DIR}`;
      await execOutput(`mkdir -p ${helperDirAbs} ${nodeDirAbs}`);

      // 2. 探测并安装 Node
      let nodePath = '';
      let nodeInstalled = false;
      const probe = await this.probeWithClient(execOutput);
      if (probe.nodeSufficient && probe.nodePath) {
        nodePath = probe.nodePath;
      } else {
        // 尝试自动安装 Node
      nodePath = await this.installNode(execOutput, sftpUpload, probe, homeDir, undefined);
        nodeInstalled = true;
      }

      // 3. 上传 helper bundle 文件
      const { readdirSync, readFileSync: readSync, statSync } = await import('node:fs');
      const helperFiles = readdirSync(helperDirPath)
        .filter(f => (f.endsWith('.js') || f.endsWith('.mjs')) && !f.endsWith('.d.ts'));

      let helperEntryName = '';
      let helperHash = '';
      for (const file of helperFiles) {
        const localPath = join(helperDirPath, file);
        if (!statSync(localPath).isFile()) continue;
        const data = readSync(localPath);
        const remotePath = `${helperDirAbs}/${file}`;
        await sftpUpload(data, remotePath);
        if (file === 'helper.mjs' || file === 'helper.js') {
          helperEntryName = file;
          helperHash = createHash('sha256').update(data).digest('hex');
        }
      }
      if (!helperHash) throw new Error('未找到 helper 入口文件（helper.mjs 或 helper.js）');

      // 4. 上传 npm 依赖到远端 node_modules
      console.log('  正在收集 npm 依赖...');
      const deps = collectHelperDependencies(helperDirPath);
      console.log(`  上传 ${deps.length} 个依赖文件...`);
      // 先创建目录结构
      const depDirs = new Set<string>();
      for (const dep of deps) {
        const dirPath = `${helperDirAbs}/${dirname(dep.remotePath)}`;
        depDirs.add(dirPath);
      }
      // 批量创建目录（用一条命令避免多次 exec）
      const dirList = [...depDirs];
      for (let i = 0; i < dirList.length; i += 50) {
        const batch = dirList.slice(i, i + 50);
        await execOutput(`mkdir -p ${batch.map(d => `'${d}'`).join(' ')}`);
      }
      // 用单个 SFTP 会话串行上传所有依赖文件，避免并发通道超限
      const sftpSession: SFTPWrapper = await new Promise((resolve, reject) => {
        client.sftp((err, sftp) => { if (err) reject(err); else resolve(sftp); });
      });
      try {
        for (const dep of deps) {
          await new Promise<void>((resolve, reject) => {
            const stream = sftpSession.createWriteStream(`${helperDirAbs}/${dep.remotePath}`);
            stream.on('error', reject);
            stream.on('close', () => resolve());
            stream.end(dep.data);
          });
        }
      } finally {
        sftpSession.end();
      }

      // 4b. 上传 node-addon-system stub 包（原生二进制无法跨平台，用 no-op 替代）
      const stubFiles = createNodeAddonStub();
      const stubSftp: SFTPWrapper = await new Promise((resolve, reject) => {
        client.sftp((err, sftp) => { if (err) reject(err); else resolve(sftp); });
      });
      try {
        for (const stub of stubFiles) {
          const stubDir = `${helperDirAbs}/${dirname(stub.remotePath)}`;
          await execOutput(`mkdir -p '${stubDir}'`);
          await new Promise<void>((resolve, reject) => {
            const stream = stubSftp.createWriteStream(`${helperDirAbs}/${stub.remotePath}`);
            stream.on('error', reject);
            stream.on('close', () => resolve());
            stream.end(stub.data);
          });
        }
      } finally {
        stubSftp.end();
      }

      // 5. 验证入口文件摘要
      const helperEntryRemotePath = `${helperDirAbs}/${helperEntryName}`;
      const verifyHash = await execOutput(`sha256sum ${helperEntryRemotePath}`);
      const installedHash = verifyHash.trim().split(/\s+/)[0];
      if (installedHash !== helperHash) {
        throw new Error(`helper 入口文件摘要不匹配：期望 ${helperHash}，实际 ${installedHash}`);
      }

      return {
        node: nodePath,
        helper: helperEntryRemotePath,
        helperHash,
        nodeInstalled,
        helperUploaded: true,
      };
    } finally {
      client.end();
    }
  }

  /** 私有：连接状态 */
  private client: Client | undefined;

  /**
   * 建立 SSH 连接并返回 exec 输出函数
   * @param profile - 主机档案
   * @param proxy - 可选的远端 HTTP 代理地址
   */
  private async connect(resolved: ResolvedHostWithJump): Promise<{
    execOutput: (cmd: string) => Promise<string>;
    disconnect: () => Promise<void>;
  }> {
    const client = await this.connectClient(resolved);
    const { execOutput } = await this.getClientMethods(client, undefined);
    return {
      execOutput,
      disconnect: async () => { client.end(); this.client = undefined; },
    };
  }

  /** 建立 ssh2 客户端连接（支持跳板机队列） */
  private async connectClient(resolved: ResolvedHostWithJump): Promise<Client> {
    const target = resolved.target;
    const jumpHosts = resolved.jumpHosts;
    const client = new Client();
    this.client = client;
    const auth: { privateKey?: Buffer; passphrase?: string; password?: string } = {};
    if (target.identityFile) {
      auth.privateKey = readFileSync(target.identityFile);
    } else {
      throw new Error('主机配置需要 IdentityFile');
    }

    // 如果配置了跳板机队列，逐级建立连接
    let sock: any = undefined;
    if (jumpHosts.length > 0) {
      for (let i = 0; i < jumpHosts.length; i++) {
        const jh = jumpHosts[i];
        const jumpClient = new Client();
        const jumpAuth: { privateKey?: Buffer; passphrase?: string; password?: string } = {};
        if (jh.identityFile) {
          jumpAuth.privateKey = readFileSync(jh.identityFile);
        } else {
          throw new Error(`跳板机 ${i + 1} (${jh.host}) 需要 IdentityFile`);
        }
        // 连接跳板机
        await new Promise<void>((resolve, reject) => {
          jumpClient.once('ready', resolve);
          jumpClient.once('error', (err: Error) => reject(new Error(`跳板机 ${i + 1} (${jh.host}:${jh.port}) 连接失败: ${err.message}`)));
          jumpClient.connect({
            host: jh.host, port: jh.port, username: jh.username,
            ...jumpAuth, readyTimeout: 30_000,
            ...(sock ? { sock } : {}),
          });
        });
        // forwardOut 到下一跳或目标
        const nextHost = i < jumpHosts.length - 1 ? jumpHosts[i + 1] : target;
        sock = await new Promise<any>((resolve, reject) => {
          jumpClient.forwardOut('127.0.0.1', 0, nextHost.host, nextHost.port, (err: Error | undefined, channel: any) => {
            if (err) reject(new Error(`跳板机 ${i + 1} forwardOut 到 ${nextHost.host}:${nextHost.port} 失败: ${err.message}`));
            else resolve(channel);
          });
        });
      }
    }

    await new Promise<void>((resolve, reject) => {
      client.once('ready', resolve);
      client.once('error', reject);
      client.connect({
        host: target.host, port: target.port, username: target.username,
        ...auth, readyTimeout: 30_000,
        ...(sock ? { sock } : {}),
      });
    });
    return client;
  }

  /** 获取客户端的 exec 和 sftp 方法 */
  private async getClientMethods(client: Client, proxy?: string): Promise<{
    execOutput: (cmd: string) => Promise<string>;
    sftpUpload: (data: Buffer, remotePath: string) => Promise<void>;
  }> {
    // 如果配置了代理，在执行命令前注入代理环境变量
    const proxyPrefix = proxy
      ? `export http_proxy=${proxy} https_proxy=${proxy} HTTP_PROXY=${proxy} HTTPS_PROXY=${proxy} && `
      : '';

    /** 执行远端命令并返回 stdout */
    const execOutput = (cmd: string): Promise<string> => new Promise((resolve, reject) => {
      client.exec(proxyPrefix + cmd, (err, stream) => {
        if (err) { reject(err); return; }
        let stdout = '';
        let stderr = '';
        stream.on('data', (d: Buffer) => { stdout += d.toString(); });
        stream.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
        stream.on('close', () => {
          if (stderr.trim()) reject(new Error(`远端命令失败: ${stderr.trim()}`));
          else resolve(stdout);
        });
      });
    });

    /** 通过 SFTP 上传文件 */
    const sftpUpload = (data: Buffer, remotePath: string): Promise<void> => new Promise((resolve, reject) => {
      client.sftp((err, sftp) => {
        if (err) { reject(err); return; }
        const stream = sftp.createWriteStream(remotePath);
        stream.on('error', reject);
        stream.on('close', () => resolve());
        stream.end(data);
      });
    });

    return { execOutput, sftpUpload };
  }

  /** 使用已建立的连接探测远端环境 */
  private async probeWithClient(
    execOutput: (cmd: string) => Promise<string>,
  ): Promise<{ nodePath: string | null; nodeVersion: string | null; nodeSufficient: boolean; os: string; arch: string }> {
    const uname = await execOutput('uname -s && uname -m');
    const [os, arch] = uname.trim().split('\n');
    const nodeCheck = await execOutput('which node 2>/dev/null && node --version 2>/dev/null || true');
    const lines = nodeCheck.trim().split('\n').filter(Boolean);
    const nodePath = lines[0] || null;
    const nodeVersion = lines[1] || null;
    let nodeSufficient = false;
    if (nodeVersion) {
      const match = nodeVersion.match(/^v(\d+)\.(\d+)/);
      if (match) {
        const major = parseInt(match[1], 10);
        const minor = parseInt(match[2], 10);
        nodeSufficient = major > MIN_NODE_MAJOR || (major === MIN_NODE_MAJOR && minor >= MIN_NODE_MINOR) || major >= 24;
      }
    }
    return { nodePath, nodeVersion, nodeSufficient, os, arch };
  }

/** Node 下载镜像源 */
export type NodeMirror = 'official' | 'aliyun' | 'tsinghua' | 'ustc';

/** 镜像源 URL 前缀映射 */
const MIRROR_URLS: Record<NodeMirror, string> = {
  official: 'https://nodejs.org/dist',
  aliyun: 'https://npmmirror.com/mirrors/node',
  tsinghua: 'https://mirrors.tuna.tsinghua.edu.cn/nodejs-release',
  ustc: 'https://mirrors.ustc.edu.cn/node',
};

/** 当前镜像源（默认官方） */
let currentMirror: NodeMirror = 'official';

/**
 * 设置 Node 下载镜像源
 * @param mirror - 镜像源标识
 */
export function setNodeMirror(mirror: NodeMirror): void {
  currentMirror = mirror;
}

/**
 * 获取当前镜像源
 */
export function getNodeMirror(): NodeMirror {
  return currentMirror;
}

/**
 * 自动安装 Node 到远端
 * 策略：1. 尝试包管理器（apt/dnf/yum）2. 下载二进制解压 3. 本地下载 scp 上传
 */
  private async installNode(
    execOutput: (cmd: string) => Promise<string>,
    sftpUpload: (data: Buffer, remotePath: string) => Promise<void>,
    probe: { os: string; arch: string },
    homeDir: string,
    proxy?: string,
  ): Promise<string> {
    const nodeDir = `${homeDir}/${NODE_DIR}`;
    // 确定目标版本
    const targetVersion = 'v22.20.0'; // LTS
    const arch = probe.arch;
    const platform = probe.os.toLowerCase();

    // 映射架构名
    let nodeArch: string;
    if (arch === 'aarch64' || arch === 'arm64') nodeArch = 'arm64';
    else if (arch === 'x86_64' || arch === 'amd64') nodeArch = 'x64';
    else if (arch.startsWith('armv7')) nodeArch = 'armv7l';
    else nodeArch = 'x64';

    const tarballName = `node-${targetVersion}-linux-${nodeArch}.tar.xz`;
    const baseUrl = MIRROR_URLS[currentMirror];
    const url = `${baseUrl}/${targetVersion}/${tarballName}`;

    // 策略 1：尝试包管理器安装（快速但版本可能不够新）
    try {
      if (platform === 'linux') {
        // 尝试 apt
        const aptCheck = await execOutput('which apt-get 2>/dev/null || which dnf 2>/dev/null || which yum 2>/dev/null || true');
        if (aptCheck.trim()) {
          // 包管理器安装的 Node 版本可能太旧，直接跳到二进制下载
        }
      }
    } catch {
      // 包管理器不可用，继续
    }

    // 策略 2：远端直接下载并解压
    try {
      const downloadCmd = `cd /tmp && curl -fsSL ${url} -o ${tarballName} 2>/dev/null || wget -q ${url} -O ${tarballName} 2>/dev/null`;
      await execOutput(downloadCmd);
      // 检查文件是否下载成功
      const sizeCheck = await execOutput(`ls -la /tmp/${tarballName} 2>/dev/null | awk '{print $5}'`);
      if (sizeCheck.trim() && parseInt(sizeCheck.trim(), 10) > 1000) {
        // 解压
        await execOutput(`cd /tmp && tar xf ${tarballName} && mkdir -p ${nodeDir} && cp -r node-${targetVersion}-linux-${nodeArch}/bin/node ${nodeDir}/node && chmod +x ${nodeDir}/node && rm -rf /tmp/${tarballName} /tmp/node-${targetVersion}-linux-${nodeArch}`);
        // 验证
        const version = await execOutput(`${nodeDir}/node --version`);
        if (version.trim().startsWith('v')) {
          return `${nodeDir}/node`;
        }
      }
    } catch {
      // 远端下载失败，继续到策略 3
    }

    // 策略 3：本地下载后 scp/sftp 上传
    // 注意：这里需要从本地下载 Node 二进制并上传
    // 由于本地可能也是 Windows，需要用 Node 的 https 模块下载
    const { default: https } = await import('node:https');
    const localData: Buffer = await new Promise((resolve, reject) => {
      https.get(url, (res) => {
        if (res.statusCode === 302 || res.statusCode === 301) {
          https.get(res.headers.location!, (res2) => {
            const chunks: Buffer[] = [];
            res2.on('data', (c: Buffer) => chunks.push(c));
            res2.on('end', () => resolve(Buffer.concat(chunks)));
            res2.on('error', reject);
          });
        } else {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => resolve(Buffer.concat(chunks)));
          res.on('error', reject);
        }
      });
    });

    // 上传 tarball 到远端
    await sftpUpload(localData, `/tmp/${tarballName}`);
    // 解压并安装
    await execOutput(`cd /tmp && tar xf ${tarballName} && mkdir -p ${nodeDir} && cp -r node-${targetVersion}-linux-${nodeArch}/bin/node ${nodeDir}/node && chmod +x ${nodeDir}/node && rm -rf /tmp/${tarballName} /tmp/node-${targetVersion}-linux-${nodeArch}`);
    const version = await execOutput(`${nodeDir}/node --version`);
    if (!version.trim().startsWith('v')) {
      throw new Error(`Node 安装后验证失败：${version}`);
    }
    return `${nodeDir}/node`;
  }

  /** 断开连接 */
  private async disconnect(): Promise<void> {
    this.client?.end();
    this.client = undefined;
  }
}

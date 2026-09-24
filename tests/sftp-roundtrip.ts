/**
 * @file SFTP 池化传输验证脚本（需真实主机）
 * @description 验证传输层 SFTP 升级的四件事：
 *              1. 池化会话只占 1 个 admin 通道配额，操作后无泄漏
 *              2. 数 MB 二进制经 writeRemoteFile/readRemoteFile 往返字节一致
 *              3. 特殊字符文本（引号/反斜杠/换行/中文/$ 变量）往返一致——
 *                 printf-over-exec 路径的天敌，SFTP 主路径必须无感
 *              4. uploadFiles 批量并发上传（会话内 4 路）逐个摘要一致
 *
 * 用法：pnpm exec tsx tests/sftp-roundtrip.ts <主机别名>
 */

import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertConnectable, resolveHostWithAuth } from '../src/hosts/ssh-config-parser.js';
import { probeRemote } from '../src/provision/probe.js';
import { createRemotePaths } from '../src/provision/remote-paths.js';
import { SshTransport } from '../src/transport/ssh-transport.js';
import { writeRemoteTextFile } from '../src/transport/write-text.js';
import { quote } from '../src/util/shell-quote.js';

const alias = process.argv[2];
if (alias === undefined) {
  console.error('用法：pnpm exec tsx tests/sftp-roundtrip.ts <主机别名>');
  process.exit(64);
}

/** 失败计数（非零则退出码 1） */
let failures = 0;

/**
 * 断言并打印结果。
 * @param label - 检查项名
 * @param ok - 是否通过
 * @param detail - 附加信息（耗时、实际值等）
 */
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail === '' ? '' : `（${detail}）`}`);
  if (!ok) failures += 1;
}

/**
 * 计算 sha256。
 * @param data - 内容
 * @returns 十六进制摘要
 */
function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

const resolved = resolveHostWithAuth(alias, {});
assertConnectable(resolved, alias, { passwordAuth: false });
const transport = new SshTransport(alias, resolved);

try {
  await transport.connect();
  const probe = await probeRemote(transport);
  const paths = createRemotePaths(probe.homeDir);
  const remoteDir = paths.tmpDir(process.pid, 'sftp-roundtrip');
  await transport.exec(`mkdir -p ${quote(remoteDir)}`);

  // 1. SFTP 可用性与池化配额
  await transport.checkSftp();
  const afterOpen = transport.channelUsage;
  check('checkSftp 成功且池化只占 1 个 admin 额度', afterOpen.admin === 1,
    `admin=${afterOpen.admin} forward=${afterOpen.forward} waiting=${afterOpen.waiting}`);

  // 2. 4MB 二进制往返
  const payload = randomBytes(4 * 1024 * 1024);
  const payloadDigest = sha256(payload);
  const writeStart = Date.now();
  await transport.writeRemoteFile(`${remoteDir}/blob.bin`, payload);
  const writeMs = Date.now() - writeStart;
  const readStart = Date.now();
  const readBack = await transport.readRemoteFile(`${remoteDir}/blob.bin`);
  const readMs = Date.now() - readStart;
  check('4MB 二进制往返字节一致',
    readBack.length === payload.length && sha256(readBack) === payloadDigest,
    `写 ${writeMs}ms，读 ${readMs}ms`);

  // 3. 特殊字符文本（printf 回退路径处理不了的部分：$ 展开、反引号、换行）
  const nasty = '单引号\'双引号"反斜杠\\美元 $HOME 反引号 `id` 换行\n第二行中文🚀';
  await writeRemoteTextFile(transport, `${remoteDir}/nasty.txt`, nasty);
  const nastyBack = (await transport.readRemoteFile(`${remoteDir}/nasty.txt`)).toString('utf8');
  check('特殊字符文本往返一致', nastyBack === nasty,
    nastyBack === nasty ? '' : `实际读回 ${JSON.stringify(nastyBack.slice(0, 60))}`);

  // 4. 批量上传（8 × 256KB，会话内 4 路并发），逐个校验远端摘要
  const localDir = mkdtempSync(join(tmpdir(), 'sftp-roundtrip-'));
  try {
    const files: { localPath: string; remotePath: string; digest: string }[] = [];
    for (let index = 0; index < 8; index += 1) {
      const content = randomBytes(256 * 1024);
      const localPath = join(localDir, `f${index}.bin`);
      writeFileSync(localPath, content);
      files.push({ localPath, remotePath: `${remoteDir}/f${index}.bin`, digest: sha256(content) });
    }
    const batchStart = Date.now();
    await transport.uploadFiles(files);
    const batchMs = Date.now() - batchStart;

    const listing = await transport.exec(`cd ${quote(remoteDir)} && sha256sum f0.bin f1.bin f2.bin f3.bin f4.bin f5.bin f6.bin f7.bin`);
    const remoteDigests = new Map(
      listing.stdout.trim().split('\n').map(line => {
        const [digest = '', name = ''] = line.trim().split(/\s+/);
        return [name, digest] as const;
      }),
    );
    const allMatch = files.every(file =>
      remoteDigests.get(`f${files.indexOf(file)}.bin`) === file.digest);
    check('批量上传 8×256KB 摘要全一致', allMatch, `${batchMs}ms`);
  } finally {
    rmSync(localDir, { recursive: true, force: true });
  }

  // 5. 全程结束后配额无泄漏（仍只有池化会话那 1 个）
  const afterAll = transport.channelUsage;
  check('admin 配额无泄漏', afterAll.admin === 1, `admin=${afterAll.admin}`);

  await transport.exec(`rm -rf ${quote(remoteDir)}`);
} catch (error) {
  console.error('测试过程异常：', error);
  failures += 1;
} finally {
  await transport.dispose();
}

console.log(failures === 0 ? 'SFTP 往返测试全部通过' : `${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);

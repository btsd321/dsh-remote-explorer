/**
 * @file 归档执行权限回归
 * @description 不依赖测试宿主平台，锁定 Windows/macOS/GNU tar 参数策略。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packageTarArgs } from '../../scripts/package-tar-args.ts';

test('Windows bsdtar 拒绝静默丢弃 POSIX 执行位', () => {
  assert.throws(() => packageTarArgs(['-czf', 'x.tar.gz', '--mode=755'], true, 'win32'), /需要 GNU tar/);
});
test('GNU tar 保留执行位选项并保护 Windows 盘符', () => {
  assert.deepEqual(packageTarArgs(['-czf', 'C:/x.tar.gz', '--mode=755'], false, 'win32'),
    ['--force-local', '-czf', 'C:/x.tar.gz', '--mode=755']);
});
test('POSIX bsdtar 使用 staging 权限，Windows zip 不受影响', () => {
  assert.deepEqual(packageTarArgs(['-czf', 'x.tar.gz', '--mode=755'], true, 'darwin'), ['-czf', 'x.tar.gz']);
  assert.deepEqual(packageTarArgs(['-a', '-cf', 'x.zip'], true, 'win32'), ['-a', '-cf', 'x.zip']);
});

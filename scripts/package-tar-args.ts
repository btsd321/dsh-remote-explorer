/**
 * @file 分发归档权限策略
 * @description 为系统 tar 归一参数；Windows 无 POSIX 执行位，不能静默删除 --mode。
 */

/**
 * 根据宿主平台与 tar 实现选择参数，拒绝会生成不可执行 POSIX 包的组合。
 * @param args - 已归一为正斜杠的参数
 * @param isBsdtar - 是否为不支持 --mode 的 bsdtar
 * @param platform - 打包宿主平台
 * @returns 可安全执行的参数
 * @throws Error Windows bsdtar 无法保留要求的执行权限
 */
export function packageTarArgs(args: string[], isBsdtar: boolean, platform: NodeJS.Platform): string[] {
  if (isBsdtar && platform === 'win32' && args.some(arg => arg.startsWith('--mode='))) {
    throw new Error('Windows 上打包 Linux/macOS 需要 GNU tar（支持 --mode）；系统 bsdtar 无法写入执行位，请安装 GNU tar 并加入 PATH');
  }
  const supported = isBsdtar ? args.filter(arg => !arg.startsWith('--mode=')) : args;
  return !isBsdtar && supported.some(arg => /^[A-Za-z]:/.test(arg))
    ? ['--force-local', ...supported]
    : supported;
}

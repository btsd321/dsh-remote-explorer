/**
 * @file 远端工作目录校验与归一化
 * @description 所有「接受远端 POSIX 路径参数」的入口共用的防御逻辑：
 *              CLI 的 `--cwd` 与插件形态（slash 命令/agent 工具/面板路由）
 *              的 cwd 参数都走这一份。下移到 util 层正是为了让插件适配层
 *              不必穿过 cli/ 就能复用（分层：入口层与插件层都可 import util）。
 *
 * 分层约束：基础层，纯函数，不感知连接与命令语义。
 */

/**
 * 校验远端工作目录是合法的 POSIX 绝对路径。
 *
 * 必须校验而不能放过，是因为 **Git Bash（MSYS）会在参数到达本程序之前就改写它**：
 * 在 Git Bash 里写 `--cwd /home/user`，程序实际收到的是
 * `D:/SoftWare/Git/home/user`——MSYS 把看起来像 Unix 路径的参数当成
 * Windows 路径做了转换。这个改写发生在 shell 层，本程序无法阻止，只能识别并拒绝。
 *
 * 放过它的后果不只是路径错：远端工作目录参与会话 id 计算，
 * 同一个逻辑会话会因调用方式不同得到不同 id，于是复用与 kill 都会失灵。
 *
 * @param cwd - 原始参数值；空串表示未指定
 * @returns 错误消息；合法时 undefined
 */
export function validateRemoteCwd(cwd: string): string | undefined {
  if (cwd.length === 0) return undefined;

  if (/^[A-Za-z]:/.test(cwd)) {
    return `远端目录看起来被 shell 改写成了 Windows 路径：${cwd}\n`
      + '这是 Git Bash（MSYS）的路径转换所致，它在参数到达本程序前就已发生。\n'
      + '两种绕过方式：用双斜杠写 --cwd //home/xxx，'
      + '或设环境变量 MSYS_NO_PATHCONV=1 后再执行。';
  }
  if (cwd.includes('\\')) {
    return `远端目录含反斜杠：${cwd}。远端一定是 POSIX，路径请用 / 分隔`;
  }
  if (!cwd.startsWith('/')) {
    return `远端目录必须是绝对路径，实际为 ${cwd}`;
  }
  return undefined;
}

/**
 * 归一化远端工作目录。
 *
 * MSYS 对以 `//` 开头的参数不做转换，所以推荐写法 `--cwd //home/xxx`
 * 传进来就是 `//home/xxx`；远端 POSIX 语义下前导双斜杠是实现定义行为，
 * 这里折叠成单斜杠，保证会话 id 对两种写法一致。
 *
 * @param cwd - 已校验的路径
 * @returns 归一化后的路径
 */
export function normalizeRemoteCwd(cwd: string): string {
  return cwd.startsWith('//') ? cwd.slice(1) : cwd;
}

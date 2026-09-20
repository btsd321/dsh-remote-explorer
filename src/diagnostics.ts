/**
 * @file 临时诊断模块
 * @description 排查 "Cannot read properties of undefined (reading 'prepare')" 用。
 *              问题定位后应整体删除此文件及 index.ts 里的调用。
 *
 * 为什么需要：
 * dsh 在 agent.ts 的 catch 里用 errorChain(error) 把错误压成纯文本
 * （`{ message: errorChain(error), code: 'UNKNOWN' }`）写进会话日志，
 * 只保留消息不保留栈，所以 Web GUI 只显示一行报错。
 * 但紧接着 throwError() 会 emit('agent/error', { turn, step, error })，
 * 带的是**原始 error 对象**（errorChain 只生成字符串，不改动该对象）。
 * 这里挂上监听，把完整栈和 cause 链打到 dsh 的 stderr。
 *
 * 同时探测 ctx.tools 的调度器 symbol：TOOL_RUNTIME_SCHEDULER 是
 * Symbol('@deepseek-ai/dsh-tools.scheduler') 而非 Symbol.for(...)，
 * 两份 dsh-tools 模块实例会产生两个不相等的 symbol，使
 * ctx.tools[TOOL_RUNTIME_SCHEDULER] 返回 undefined——报错文本正好是
 * `.prepare` 读取失败。此探测用于证实或排除这个猜测。
 */

import type { Context } from '@deepseek-ai/cordis';

/** 日志前缀 */
const TAG = '[dsh-remote-ssh:诊断]';

/**
 * 打印一个错误的完整栈与 cause 链
 * @param error - 捕获到的原始值
 * @param depth - 当前 cause 深度
 */
function dumpError(error: unknown, depth = 0): void {
  const pad = '  '.repeat(depth + 1);
  if (!(error instanceof Error)) {
    console.error(`${pad}[非 Error 值 ${typeof error}]`, error);
    return;
  }
  console.error(`${pad}${error.name}: ${error.message}`);
  for (const line of (error.stack ?? '').split('\n').slice(1)) {
    console.error(`${pad}  ${line.trim()}`);
  }
  // AggregateError 的成员
  if (error instanceof AggregateError) {
    for (const member of error.errors) {
      console.error(`${pad}--- AggregateError 成员 ---`);
      dumpError(member, depth + 1);
    }
  }
  if (error.cause !== undefined && error.cause !== null && depth < 8) {
    console.error(`${pad}--- cause ---`);
    dumpError(error.cause, depth + 1);
  }
}

/**
 * 探测 ctx.tools 上的工具调度器 symbol 是否可解析。
 *
 * 若 ctx.tools 存在但自有 symbol 里找不到 scheduler，或找到了多个同名 symbol，
 * 就说明存在重复的 dsh-tools 模块实例。
 *
 * @param ctx - Cordis 上下文
 */
function probeToolScheduler(ctx: Context): void {
  try {
    probeToolSchedulerUnsafe(ctx);
  } catch (error) {
    // 探测本身失败不能影响插件运行
    console.error(`${TAG} 调度器探测失败:`, error instanceof Error ? error.message : String(error));
  }
}

/**
 * 探测实现（可能抛错，由 probeToolScheduler 包裹）
 * @param ctx - Cordis 上下文
 */
function probeToolSchedulerUnsafe(ctx: Context): void {
  const tools: any = ctx.get('tools');
  if (!tools) {
    console.error(`${TAG} ctx.tools 不存在（服务未注册或本 ctx 不可见）`);
    return;
  }
  probeToolsObject(tools, '宿主 ctx');
}

/**
 * 列出一个 tools 服务对象上的调度器 symbol 情况。
 *
 * @param tools - ctx.tools（可能是 cordis 代理）
 * @param where - 来源标注，用于区分宿主 ctx 与会话 realm ctx
 */
function probeToolsObject(tools: any, where: string): void {
  // 取原始对象，绕过 cordis 的 traceable 代理，才能列出自有 symbol
  const raw = tools[Symbol.for('cordis.original')] ?? tools;
  console.error(`${TAG} [${where}] tools 构造函数 = ${raw?.constructor?.name}`);
  const symbols = Object.getOwnPropertySymbols(raw);
  console.error(`${TAG} [${where}] 自有 symbol 共 ${symbols.length} 个:`);
  for (const sym of symbols) {
    const value = (raw as any)[sym];
    const hasPrepare = value !== null && typeof value === 'object' && typeof (value as any).prepare === 'function';
    console.error(`${TAG}   ${String(sym)} => ${value === undefined ? 'undefined' : typeof value}${hasPrepare ? '（有 prepare）' : ''}`);
  }
  // 决定性比对：找出哪种加载方式的 symbol 能从这个 tools 实例上取到调度器。
  // 纯 Node 下裸包名与 lib 绝对路径解析到同一实例（已本地验证），
  // 但 dsh 源码启动经 tsx 的 ESM 钩子，解析结果可能不同；
  // 若"裸包名"这一项取不到，就解释了 agent-loop 为何读到 undefined。
  void compareSchedulerSymbols(raw, where);
}

/**
 * dsh-tools 的候选加载方式。
 *
 * 每种方式若解析到不同的模块实例，导出的 TOOL_RUNTIME_SCHEDULER 就是不同的
 * symbol 对象（描述文字相同，恒等比较不相等）。
 * 第一项最关键：agent-loop 的构建产物正是用裸包名导入的。
 */
const TOOLS_CANDIDATES: { label: string; spec: string }[] = [
  { label: '裸包名（agent-loop/lib 的导入方式）', spec: '@deepseek-ai/dsh-tools' },
  { label: 'lib 大写 D 盘符（栈里显示的拼写）', spec: 'file:///D:/Project/deepseek-harness/packages/core/tools/lib/index.js' },
  { label: 'lib 小写 d 盘符', spec: 'file:///d:/Project/deepseek-harness/packages/core/tools/lib/index.js' },
  { label: 'src 源码面（tsx 解析目标）', spec: 'file:///D:/Project/deepseek-harness/packages/core/tools/src/index.ts' },
];

/**
 * 逐个候选取出 TOOL_RUNTIME_SCHEDULER，检查它能否从 ctx.tools 上取到调度器。
 *
 * 能取到的那个，就是创建 ToolRuntime 实例的模块；取不到的说明是另一个实例。
 * 若"裸包名"这一项取不到，就证实了 agent-loop 读不到调度器的原因。
 *
 * @param raw - ctx.tools 的原始对象（已绕过 cordis 代理）
 */
async function compareSchedulerSymbols(raw: any, where: string): Promise<void> {
  console.error(`${TAG} ---- [${where}] 调度器 symbol 归属比对 ----`);
  const loaded: { label: string; sym: symbol }[] = [];
  for (const { label, spec } of TOOLS_CANDIDATES) {
    try {
      const mod: any = await import(spec);
      const sym = mod.TOOL_RUNTIME_SCHEDULER;
      if (typeof sym !== 'symbol') {
        console.error(`${TAG}   ${label} => 未导出 symbol`);
        continue;
      }
      loaded.push({ label, sym });
      const value = raw[sym];
      const ok = value !== undefined && typeof value?.prepare === 'function';
      console.error(`${TAG}   ${label} => ${ok ? '✓ 能取到调度器' : '✗ 取到 undefined'}`);
    } catch (error) {
      console.error(`${TAG}   ${label} => 加载失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  // 两两比对恒等性，暴露出现了几个不同的实例
  const distinct: symbol[] = [];
  for (const { sym } of loaded) if (!distinct.includes(sym)) distinct.push(sym);
  console.error(`${TAG}   成功加载 ${loaded.length} 个候选，其中不同的 symbol 有 ${distinct.length} 个`);
  if (distinct.length > 1) {
    console.error(`${TAG} ⚠ 存在多个 dsh-tools 模块实例 —— 这就是 ctx.tools 上有调度器而 agent-loop 读不到的机制`);
  }
  console.error(`${TAG} ---- 比对结束 ----`);
}

/**
 * 安装诊断监听。
 *
 * @param ctx - Cordis 上下文
 */
export function installDiagnostics(ctx: Context): void {
  console.error(`${TAG} 已启用（定位 .prepare 报错用；问题解决后请删除 src/diagnostics.ts）`);

  // 1. agent/error 带原始 error 对象，在 errorChain 压平之前。
  //    该事件是 scoped（按 agent 键控），宿主层注册未必被接受，
  //    所以整段容错——诊断代码绝不能让插件加载失败。
  try {
    ctx.on('agent/error' as any, (payload: any) => {
      const { turn, step, error, agent } = payload ?? {};
      console.error(`${TAG} ===== agent/error (turn=${turn} step=${step}) =====`);
      dumpError(error);
      console.error(`${TAG} ===== agent/error 结束 =====`);
      // 宿主 ctx 的基线状态
      probeToolScheduler(ctx);
      // 真正出错的是会话 realm 的 ctx（Agent.ctx 取自它自己的 scope）。
      // 宿主 ctx 正常不代表 realm 内也正常——这里才是 agent-loop 实际读取的那个。
      try {
        const agentCtx: any = agent?.ctx;
        if (!agentCtx) {
          console.error(`${TAG} payload.agent.ctx 不可用，无法探测会话 realm`);
          return;
        }
        const realmTools = agentCtx.get?.('tools') ?? agentCtx.tools;
        if (!realmTools) {
          console.error(`${TAG} ⚠ 会话 realm 的 ctx 上取不到 tools 服务 —— 这与 agent-loop 读到 undefined 一致`);
          return;
        }
        probeToolsObject(realmTools, '会话 realm ctx');
        console.error(`${TAG} 宿主 tools 与 realm tools 是否同一实例 = ${(ctx.get('tools') as any) === realmTools}`);
      } catch (probeError) {
        console.error(`${TAG} 探测会话 realm 失败:`, probeError instanceof Error ? probeError.message : String(probeError));
      }
    });
    console.error(`${TAG} 已挂上 agent/error 监听`);
  } catch (error) {
    // 宿主层拿不到 scoped 事件时走下面的进程级兜底
    console.error(`${TAG} agent/error 监听注册失败（将依赖进程级兜底）:`, error instanceof Error ? error.message : String(error));
  }

  // 2. 兜底：agent/error 是 scoped 事件（按 agent 键控），本插件在宿主层，
  //    监听可能收不到会话 realm 内的事件。这里用进程级钩子兜底，
  //    只要错误消息命中 .prepare 就打全栈，不限来源。
  const hit = (reason: unknown): boolean =>
    reason instanceof Error && /reading '?prepare'?/.test(reason.message);

  const onRejection = (reason: unknown): void => {
    if (!hit(reason)) return;
    console.error(`${TAG} ===== unhandledRejection 命中 .prepare =====`);
    dumpError(reason);
    probeToolScheduler(ctx);
  };
  const onUncaught = (error: Error): void => {
    if (!hit(error)) return;
    console.error(`${TAG} ===== uncaughtException 命中 .prepare =====`);
    dumpError(error);
    probeToolScheduler(ctx);
  };
  process.on('unhandledRejection', onRejection);
  process.on('uncaughtException', onUncaught);
  ctx.effect(() => () => {
    process.off('unhandledRejection', onRejection);
    process.off('uncaughtException', onUncaught);
  });

  // 3. 启动时先报一次基线状态（宿主层 ctx）。
  //    注意：出错处的 ctx 是会话 preset realm 的 ctx，与这里的宿主 ctx 可能不同，
  //    所以基线正常不代表 realm 内也正常——两处都看才有结论。
  probeToolScheduler(ctx);
}

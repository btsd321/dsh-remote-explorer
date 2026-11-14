/**
 * @file DeepSeek 远端配置白名单
 * @description 仅镜像模型目录与推理档位；headers、明文密钥及未知扩展不能落远端。
 *
 * 字段集合对齐 DSH `llm-deepseek` 的 `catalogModel` schema（`id` 必填，其余
 * 可选：name / description / contextWindow / maxTokens / inputModalities /
 * imagePixelBudget / imageMaxBytes / systemPromptUpdate / toolUpdate）。
 * schema 不接受字符串条目，缺 `id` 的条目会让远端配置校验失败，因此这类
 * 条目直接丢弃，而不是替换成空对象。
 */

/** 推理档位的合法值（与 DSH `reasoningEffort` union 一致） */
const REASONING_EFFORTS = new Set(['off', 'low', 'high', 'max']);
/** 输入模态的合法值（与 DSH `MODEL_MODALITIES` 一致） */
const MODALITIES = new Set(['text', 'image']);
/** 工具更新策略的合法值 */
const TOOL_UPDATES = new Set(['in-history', 'addition-only']);

/**
 * 判断值是否为正整数（DSH schema 的 `z.number().step(1).min(1)`）。
 *
 * @param value - 待判断的值
 * @returns 是否为正整数
 */
function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

/**
 * 投影一条模型目录条目；不符合 schema 的字段丢弃，缺 id 时整条丢弃。
 *
 * @param model - 本机配置里的模型条目
 * @returns 安全条目；不可用时 undefined
 */
function safeModel(model: unknown): Record<string, unknown> | undefined {
  if (model === null || typeof model !== 'object' || Array.isArray(model)) return undefined;
  const source = model as Record<string, unknown>;
  const id = source['id'];
  if (typeof id !== 'string' || id === '') return undefined;
  const safe: Record<string, unknown> = { id };
  for (const key of ['name', 'description'] as const) {
    if (typeof source[key] === 'string') safe[key] = source[key];
  }
  for (const key of ['contextWindow', 'maxTokens', 'imageMaxBytes'] as const) {
    if (isPositiveInteger(source[key])) safe[key] = source[key];
  }
  const pixelBudget = source['imagePixelBudget'];
  if (pixelBudget === 'low' || isPositiveInteger(pixelBudget)) safe['imagePixelBudget'] = pixelBudget;
  const modalities = source['inputModalities'];
  if (Array.isArray(modalities)) {
    const kept = modalities.filter((item): item is string => typeof item === 'string' && MODALITIES.has(item));
    // schema 要求至少一项；过滤后为空时省略，让远端回落默认 ['text']
    if (kept.length > 0) safe['inputModalities'] = kept;
  }
  if (source['systemPromptUpdate'] === 'in-history') safe['systemPromptUpdate'] = 'in-history';
  const toolUpdate = source['toolUpdate'];
  if (typeof toolUpdate === 'string' && TOOL_UPDATES.has(toolUpdate)) safe['toolUpdate'] = toolUpdate;
  return safe;
}

/**
 * 投影本机配置的安全子集；未知字段默认不传播。
 *
 * @param config - 本机配置
 * @returns 不含认证材料的远端配置
 */
export function remoteDeepseekConfig(config?: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const effort = config?.['reasoningEffort'];
  if (typeof effort === 'string' && REASONING_EFFORTS.has(effort)) result['reasoningEffort'] = effort;
  const models = config?.['models'];
  if (Array.isArray(models)) {
    const kept = models
      .map(safeModel)
      .filter((model): model is Record<string, unknown> => model !== undefined);
    // 全部条目都不可用时省略 models，让远端回落内置目录，而不是下发空目录
    if (kept.length > 0) result['models'] = kept;
  }
  return result;
}

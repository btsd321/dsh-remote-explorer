/**
 * @file DeepSeek 远端配置白名单
 * @description 仅镜像模型目录与推理档位；headers、明文密钥及未知扩展不能落远端。
 */

/** 允许镜像的模型元数据，不包含请求头、端点或认证字段。 */
const MODEL_FIELDS = new Set(['id', 'name', 'contextWindow', 'maxTokens', 'maxOutputTokens', 'reasoning', 'input', 'output', 'cost']);
/** 成本只接受数值，不能用嵌套对象夹带认证配置。 */
const COST_FIELDS = new Set(['input', 'output', 'cacheRead', 'cacheWrite']);

/**
 * 投影本机配置的安全子集；未知字段默认不传播。
 * @param config - 本机配置
 * @returns 不含认证材料的远端配置
 */
export function remoteDeepseekConfig(config?: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (typeof config?.['reasoningEffort'] === 'string') result['reasoningEffort'] = config['reasoningEffort'];
  if (Array.isArray(config?.['models'])) {
    result['models'] = config['models'].map((model: unknown) => {
      if (typeof model === 'string') return model;
      if (model === null || typeof model !== 'object' || Array.isArray(model)) return {};
      const safe: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(model)) {
        if (!MODEL_FIELDS.has(key)) continue;
        if (key === 'cost' && value !== null && typeof value === 'object') {
          safe[key] = Object.fromEntries(Object.entries(value).filter(([k, v]) => COST_FIELDS.has(k) && typeof v === 'number'));
        } else if (['string', 'number', 'boolean'].includes(typeof value)) {
          safe[key] = value;
        } else if ((key === 'input' || key === 'output') && Array.isArray(value)) {
          safe[key] = value.filter(item => typeof item === 'string');
        }
      }
      return safe;
    });
  }
  return result;
}

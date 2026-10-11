// 模型档案（per-model 调优）：按模型 id 识别厂商/家族，给出建议的上下文窗口与能力。
//
// 参考实现按自家模型深调（Claude 的 prompt cache/thinking、ZCode 的 GLM）；我们模型无关，
// 但可以按**模型名**做一层「已知家族」的建议——最直接的收益是上下文窗口：应用默认的
// 200k 是保守猜测，对 Gemini（1M）会严重低估、对 32k 的小模型会高估。用户一旦在能力里
// 声明了窗口，声明值优先（本模块只在未声明时兜底）。
//
// 纯函数、零依赖、可 Node 直测。窗口值是**家族级近似**（同一家族不同版本可能不同），
// 仅作兜底默认，可被用户声明覆盖。

// 家族档案（顺序 = 匹配优先级，先命中先返回）。
export const MODEL_PROFILES = Object.freeze([
  { id: 'claude', label: 'Claude', match: /claude/i, contextWindow: 200000, promptCache: 'anthropic', thinking: true, vision: true },
  { id: 'gemini', label: 'Gemini', match: /gemini/i, contextWindow: 1000000, promptCache: 'auto', thinking: true, vision: true },
  { id: 'gpt', label: 'GPT', match: /(^|[^a-z])(gpt|chatgpt|o[1-9])([^a-z]|$)/i, contextWindow: 128000, promptCache: 'auto', thinking: true, vision: true },
  { id: 'deepseek', label: 'DeepSeek', match: /deepseek/i, contextWindow: 128000, promptCache: 'auto', thinking: true, vision: false },
  { id: 'glm', label: 'GLM', match: /(^|[^a-z])(glm|chatglm|zhipu)/i, contextWindow: 128000, promptCache: 'auto', thinking: true, vision: false },
  { id: 'qwen', label: 'Qwen', match: /(^|[^a-z])(qwen|tongyi)/i, contextWindow: 131072, promptCache: 'auto', thinking: true, vision: true },
  { id: 'kimi', label: 'Kimi', match: /(kimi|moonshot)/i, contextWindow: 256000, promptCache: 'auto', thinking: true, vision: false },
  { id: 'grok', label: 'Grok', match: /grok/i, contextWindow: 131072, promptCache: 'auto', thinking: true, vision: true },
  { id: 'mistral', label: 'Mistral', match: /(mistral|mixtral|magistral|devstral)/i, contextWindow: 131072, promptCache: 'auto', thinking: false, vision: false },
  { id: 'llama', label: 'Llama', match: /llama/i, contextWindow: 131072, promptCache: 'auto', thinking: false, vision: false },
]);

// 按模型 id 解析家族档案；认不出返回 null（调用方走默认）。
export function resolveModelProfile(modelId) {
  const id = String(modelId == null ? '' : modelId).trim();
  if (!id) return null;
  for (const profile of MODEL_PROFILES) {
    if (profile.match.test(id)) {
      return {
        id: profile.id,
        label: profile.label,
        contextWindow: profile.contextWindow,
        promptCache: profile.promptCache,
        thinking: profile.thinking,
        vision: profile.vision,
      };
    }
  }
  return null;
}

// 家族建议的上下文窗口；认不出或非法时返回 fallback（默认 0）。
export function modelContextWindow(modelId, fallback = 0) {
  const profile = resolveModelProfile(modelId);
  return profile && profile.contextWindow > 0 ? profile.contextWindow : fallback;
}

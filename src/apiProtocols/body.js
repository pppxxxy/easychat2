// 统一请求体构造：把内部消息 + 采样/思考/工具配置翻译成各协议请求体。纯函数。
import {
  toAnthropicRequest,
  toOpenAiMessages,
  toResponsesRequest,
} from './messages.js';
import {
  buildAnthropicToolChoice,
  buildAnthropicTools,
  buildResponsesToolChoice,
  buildResponsesTools,
} from './tools.js';
// P1-1：Anthropic 显式缓存断点（OpenAI 系是自动缓存，不需要）。
import { applyAnthropicCacheControl, normalizePromptCacheTtl } from './cacheControl.js';

function normalizeSampling(samplingParams) {
  const source = samplingParams && typeof samplingParams === 'object' ? samplingParams : {};
  return {
    maxTokens: Number.isFinite(Number(source.max_tokens)) ? Math.round(Number(source.max_tokens)) : null,
    temperature: Number.isFinite(Number(source.temperature)) ? Number(source.temperature) : null,
    topP: Number.isFinite(Number(source.top_p)) ? Number(source.top_p) : null,
    topK: Number.isFinite(Number(source.top_k)) ? Math.round(Number(source.top_k)) : null,
  };
}

function anthropicThinkingBudget(level) {
  if (level === 'low') return 1024;
  if (level === 'high') return 8192;
  return 4096;
}

// 统一入口：返回可直接 send 的请求体对象（不含鉴权头与 URL）。
export function buildRequestBody({
  protocol,
  model,
  messages,
  stream = true,
  tools = null,
  toolChoice = undefined,
  samplingParams = null,
  thinkingParams = null,
  thinkingSettings = null,
  config = null,
  // 能力按模型解析后由调用方传入（本模块保持零存储依赖）；缺省回退 config 级旧字段，
  // 兼容既有调用与测试。
  capabilities = null,
} = {}) {
  const sampling = normalizeSampling(samplingParams);
  const toolList = Array.isArray(tools) ? tools : [];
  const thinkingCapable = capabilities
    ? capabilities.supportsThinking === true
    : !!(config && config.supportsThinking === true);
  const thinkingEnabled = !!(thinkingSettings && thinkingSettings.enabled === true)
    && thinkingCapable;
  const levelRaw = thinkingSettings && thinkingSettings.level;
  const level = ['low', 'medium', 'high'].includes(levelRaw) ? levelRaw : 'medium';

  if (protocol === 'anthropic') {
    const { system, messages: turns } = toAnthropicRequest(messages);
    // P1-1：显式缓存断点（system 尾 / tools 尾 / 历史稳定前缀）。关闭时逐字原样返回，
    // 请求体与加这个特性之前完全一致。
    const cached = applyAnthropicCacheControl({
      system,
      messages: turns,
      tools: toolList.length ? buildAnthropicTools(toolList) : null,
      ttl: normalizePromptCacheTtl(config && config.promptCacheTtl),
    });
    const body = {
      model,
      max_tokens: sampling.maxTokens || 4096,
      messages: cached.messages,
    };
    if (cached.system) body.system = cached.system;
    if (thinkingEnabled) {
      const budget = anthropicThinkingBudget(level);
      body.thinking = { type: 'enabled', budget_tokens: budget };
      // Anthropic 要求开启 thinking 时 max_tokens 大于 budget_tokens。
      body.max_tokens = Math.max(body.max_tokens, budget + 1024);
    } else {
      if (sampling.temperature !== null) body.temperature = sampling.temperature;
    }
    if (sampling.topP !== null) body.top_p = sampling.topP;
    if (sampling.topK !== null) body.top_k = sampling.topK;
    if (toolList.length) {
      body.tools = cached.tools || buildAnthropicTools(toolList);
      const choice = buildAnthropicToolChoice(toolChoice);
      if (choice) body.tool_choice = choice;
    }
    body.stream = stream !== false;
    return body;
  }

  if (protocol === 'openai-responses') {
    const { instructions, input } = toResponsesRequest(messages);
    const body = {
      model,
      input,
      store: false,
      stream: stream !== false,
    };
    if (instructions) body.instructions = instructions;
    if (sampling.maxTokens !== null) body.max_output_tokens = sampling.maxTokens;
    if (sampling.temperature !== null) body.temperature = sampling.temperature;
    if (sampling.topP !== null) body.top_p = sampling.topP;
    if (thinkingEnabled) body.reasoning = { effort: level };
    if (toolList.length) {
      body.tools = buildResponsesTools(toolList);
      if (toolChoice !== undefined) body.tool_choice = buildResponsesToolChoice(toolChoice);
    }
    return body;
  }

  // openai chat completions
  const body = {
    model,
    messages: toOpenAiMessages(messages),
    stream: stream !== false,
    ...(thinkingParams || {}),
    ...(samplingParams || {}),
  };
  if (toolList.length) {
    body.tools = toolList;
    if (toolChoice !== undefined) body.tool_choice = toolChoice;
  }
  return body;
}

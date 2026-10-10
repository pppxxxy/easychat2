import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  capabilitiesForModel,
  getActiveApiConfig,
  getActiveModel,
  getApiConfigs,
} from '../storage/apiConfigs.js';
import { getSamplingSettings, getThinkingSettings } from '../storage/settings.js';
import { registerSecretValues } from '../storage/secrets.js';
import { recordDiagnostic } from '../storage/diagnostics.js';
import {
  buildRequestBody,
  buildRequestHeaders,
  describeErrorPayload,
  normalizeProtocol,
  normalizeProtocolUrl,
  parseFinalPayload,
  parseProtocolError,
  parseStreamPayload,
} from '../apiProtocols.js';
import { tActive } from '../i18n/index.js';
import { trimMessagesToContext } from '../localModel/localContext.js';

// F4：在线路径上下文硬裁剪（纯函数，可测）。仅当模型声明了 contextWindow > 0 且未
// 显式关闭时生效；直接复用本地模型同款裁剪（系统提示恒保留）。未声明窗口 = 原样返回，
// 不做按兜底的激进裁剪。返回原始数组（不裁剪时）或裁剪后的数组。
export function trimOnlineMessages(messages, { contextWindow = 0, reserveOutputTokens = 0, enabled = true } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const declared = Math.floor(Number(contextWindow) || 0);
  if (!enabled || declared <= 0) return list;
  const result = trimMessagesToContext(list, {
    contextSize: declared,
    reserveOutputTokens: reserveOutputTokens > 0 ? reserveOutputTokens : 512,
    minKeep: 1,
  });
  return result.removedCount > 0 ? result.messages : list;
}

// 首包（首字节）等待单独放宽：推理模型思考期间可能几十秒不吐字，
// 用同一个 30s 阈值会误报“请求超时”。
const FIRST_BYTE_TIMEOUT_MS = 120000;
const IDLE_TIMEOUT_MS = 30000;

// 接口没有返回内容时的占位文本。调用方可用它区分“真的没回复”，
// 避免把这段占位当成角色的真实回复（例如写入动态评论）。
export const EMPTY_REPLY_TEXT = '没有收到回复。';
// 旧版哨兵文案：isConfigChangedError 仍兼容匹配它（老会话/旧调用方抛出的实例）。
export const CONFIG_CHANGED_ERROR = '模型来源已切换，请重新发送';

// 配置指纹变化时中止在途请求：文案走 i18n，分类判定改看 code，不再依赖文案相等。
function configChangedError() {
  const error = new Error(tActive('error.api.configChanged'));
  error.code = 'CONFIG_CHANGED';
  return error;
}

function fingerprint(value) {
  let hash = 2166136261;
  const text = String(value || '');
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

export function getConfigFingerprint(config) {
  const source = config && typeof config === 'object' ? config : {};
  // 能力按**当前模型**解析：换模型本来就会让指纹变化（activeModel 已在表内），
  // 同一配置下不同模型的能力差异也必须反映在指纹里（能力改到一半时中止在途请求）。
  const caps = capabilitiesForModel(source, getActiveModel(source));
  return fingerprint(JSON.stringify([
    String(source.id || ''),
    String(source.baseUrl || ''),
    String(getActiveModel(source) || ''),
    String(source.apiKey || ''),
    String(source.authHeader || 'Authorization'),
    String(source.authScheme === undefined ? 'Bearer ' : source.authScheme),
    normalizeProtocol(source.protocol),
    caps.supportsVision,
    caps.supportsVideo,
    caps.supportsThinking,
    caps.supportsAudio,
  ]));
}

export function isConfigChangedError(error) {
  return !!error && (error.code === 'CONFIG_CHANGED' || error.message === CONFIG_CHANGED_ERROR);
}

export function buildThinkingParams(config, settings) {
  if (!settings || settings.enabled !== true) return {};
  if (!config) return {};
  // 思考能力与字段名按**当前模型**解析（每个模型一套）。
  const caps = capabilitiesForModel(config, getActiveModel(config));
  if (caps.supportsThinking !== true) return {};
  const field = String(caps.thinkingField || 'reasoning_effort') || 'reasoning_effort';
  const level = ['low', 'medium', 'high'].includes(settings.level) ? settings.level : 'medium';
  const format = caps.thinkingFormat || 'effort';
  if (format === 'boolean') return { [field]: true };
  if (format === 'object') return { [field]: { type: 'enabled', depth: level } };
  return { [field]: level };
}

export function buildSamplingParams(settings) {
  const source = settings && typeof settings === 'object' ? settings : {};
  const params = {};
  const pick = (name, key, integer) => {
    const entry = source[name];
    if (!entry || entry.enabled !== true) return;
    const value = Number(entry.value);
    if (!Number.isFinite(value)) return;
    params[key] = integer ? Math.round(value) : value;
  };
  pick('maxTokens', 'max_tokens', true);
  pick('temperature', 'temperature', false);
  pick('topP', 'top_p', false);
  pick('topK', 'top_k', true);
  return params;
}

// 把单次请求的 overrides（{ temperature?, maxTokens? }）叠加到采样参数上。
// 只认这两个键，值为有限数字才生效；结果仍用请求体的 snake_case 键名，
// 交给 buildRequestBody 按协议归一（openai 原样、responses 转 max_output_tokens、anthropic 转 max_tokens）。
export function mergeSamplingOverrides(samplingParams, overrides) {
  const base = samplingParams && typeof samplingParams === 'object' ? { ...samplingParams } : {};
  const source = overrides && typeof overrides === 'object' ? overrides : null;
  if (!source) return base;
  const temperature = Number(source.temperature);
  if (Number.isFinite(temperature)) base.temperature = temperature;
  const maxTokens = Number(source.maxTokens);
  if (Number.isFinite(maxTokens)) base.max_tokens = Math.round(maxTokens);
  return base;
}

export function normalizeChatUrl(baseUrl) {
  const trimmed = ((baseUrl || '').trim() || 'https://api.deepseek.com').replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(trimmed)) {
    return trimmed;
  }
  if (/\/v1$/i.test(trimmed)) {
    return `${trimmed}/chat/completions`;
  }
  return `${trimmed}/v1/chat/completions`;
}

function formatApiError(text, status) {
  try {
    const data = JSON.parse(text);
    // 复用共享错误解析：兼容 OpenRouter 形态的 metadata.raw（上游原始错误）。
    const described = describeErrorPayload(data.error)
      || (typeof data.message === 'string' ? data.message.trim() : '');
    if (described) return described;
  } catch (error) {}

  const trimmed = (text || '').trim();
  if (!trimmed || trimmed.startsWith('<')) {
    return `请求失败（HTTP ${status}）`;
  }
  return trimmed.slice(0, 300);
}

export function normalizeAssistantContent(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .map(part => {
      if (typeof part === 'string') return part;
      if (part && typeof part.text === 'string') return part.text;
      if (part && typeof part.content === 'string') return part.content;
      return '';
    })
    .join('');
}

function extractErrorMessage(payload) {
  if (!payload || !payload.error) return '';
  // 复用共享错误解析：error.message + metadata.raw（OpenRouter 上游真凶）。
  return describeErrorPayload(payload.error) || '接口返回错误。';
}

export function createAbortError() {
  const error = new Error('已停止生成。');
  error.name = 'AbortError';
  error.canceled = true;
  return error;
}

export function isCanceledError(error) {
  return !!error && (error.canceled === true || error.name === 'AbortError');
}

// E1：usage 宽容解析——三种方言一次归一（缓存经济学的地基：没有它就没有命中观测）。
//   · OpenAI 系：usage.prompt_tokens_details.cached_tokens
//   · DeepSeek：usage.prompt_cache_hit_tokens
//   · Anthropic：usage.cache_read_input_tokens（**input_tokens 不含缓存部分**，
//     这里把 cache_read + cache_creation 并进 prompt，统一成「prompt ⊇ cached」口径，
//     与 OpenAI/DeepSeek 可比）
// 流式与非流式共用；payload 里任何位置带 usage 都认（Anthropic 在 message.usage、
// 部分网关在 delta.usage）。解析不出返回 null——绝不影响主流程。
export function extractUsage(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const source = payload.usage
    || (payload.message && payload.message.usage)
    || (payload.delta && payload.delta.usage)
    || null;
  if (!source || typeof source !== 'object') return null;
  const num = value => {
    const n = Math.floor(Number(value));
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  const cacheRead = num(source.cache_read_input_tokens);
  const cacheCreation = num(source.cache_creation_input_tokens);
  const rawPrompt = num(source.prompt_tokens) || num(source.input_tokens);
  const promptTokens = rawPrompt + cacheRead + cacheCreation;
  const completionTokens = num(source.completion_tokens) || num(source.output_tokens);
  const cachedTokens = num(source.prompt_cache_hit_tokens)
    || num(source.prompt_tokens_details && source.prompt_tokens_details.cached_tokens)
    || cacheRead;
  if (!promptTokens && !completionTokens && !cachedTokens) return null;
  return { promptTokens, completionTokens, cachedTokens };
}

// 默认用激活配置；调用方（如角色日记）可显式指定 configId 与 model 覆盖，
// 这样不必改动全局激活项就能用另一套模型发请求。
async function resolveChatConfig(options = {}) {
  const configId = String((options && options.configId) || '').trim();
  if (!configId) return getActiveApiConfig();
  const { configs } = await getApiConfigs();
  const config = (Array.isArray(configs) ? configs : []).find(item => item.id === configId);
  if (!config) {
    throw new Error(tActive('error.api.configNotFound'));
  }
  const model = String((options && options.model) || '').trim();
  return model ? { ...config, activeModel: model } : config;
}

// 结构化流式请求：返回完整文本、思考文本与 tool_calls 累积结果，供 agent 循环使用。
// 注意：这里返回**原始空文本**，不做 EMPTY_REPLY_TEXT 兜底——工具轮里
// 「text 为空 + tool_calls」是正常形态，占位文本会污染 assistant 历史。
export async function streamChatCompletion(messages, options = {}) {
  const onChunk = options && typeof options.onChunk === 'function' ? options.onChunk : null;
  const onReasoning = options && typeof options.onReasoning === 'function' ? options.onReasoning : null;
  const signal = options && options.signal ? options.signal : null;
  const stream = options && options.stream === false ? false : true;
  const tools = Array.isArray(options && options.tools) ? options.tools : null;
  const toolChoice = options ? options.toolChoice : undefined;
  if (signal && signal.aborted) {
    throw createAbortError();
  }
  const config = await resolveChatConfig(options);
  if (!config) {
    throw configChangedError();
  }
  if (options && options.expectedConfigId && config.id !== options.expectedConfigId) {
    throw configChangedError();
  }
  if (
    options
    && options.expectedConfigFingerprint
    && getConfigFingerprint(config) !== options.expectedConfigFingerprint
  ) {
    throw configChangedError();
  }
  if (signal && signal.aborted) {
    throw createAbortError();
  }
  // 登记当前密钥：报错文本可能带出裸 Key，脱敏时才能按真实值兜住
  registerSecretValues([config.apiKey]);
  if (!config.apiKey) {
    throw new Error(tActive('error.api.apiKeyMissing'));
  }
  if (!String(config.baseUrl || '').trim()) {
    throw new Error(tActive('error.api.baseUrlMissing'));
  }
  const model = getActiveModel(config);
  const hasModel = (Array.isArray(config.models) && config.models.length > 0)
    || String(config.activeModel || '').trim()
    || String(config.model || '').trim();
  if (!hasModel) {
    throw new Error(tActive('error.api.modelMissing'));
  }
  const protocol = normalizeProtocol(config.protocol);

  const url = normalizeProtocolUrl(protocol, config.baseUrl);
  if (!/^https?:\/\/[^/\s]+/i.test(url)) {
    throw new Error(tActive('error.api.invalidUrl'));
  }
  const thinkingSettings = await getThinkingSettings().catch(() => null);
  const thinkingParams = buildThinkingParams(config, thinkingSettings);
  const samplingSettings = await getSamplingSettings().catch(() => null);
  // 本次请求的采样覆盖（制卡等需要低温 + 大输出预算的 JSON 生成）：
  // 只覆盖本次组装出的 samplingParams，不写回设置，不影响全局聊天。
  const samplingParams = mergeSamplingOverrides(
    buildSamplingParams(samplingSettings),
    options && options.overrides
  );
  // 输出长度：只在模型的「自定义参数」打开时介入（面板上写的就是「留空 = 默认 32000」）。
  // 关闭时完全不干预——不发 max_tokens，保持全局采样设置/服务端默认不动，
  // 避免给不支持大输出的模型悄悄带上 32000 而报错。
  const modelCaps = capabilitiesForModel(config, model);
  if (modelCaps.customParams === true) {
    samplingParams.max_tokens = modelCaps.maxOutput > 0
      ? modelCaps.maxOutput
      : DEFAULT_MAX_OUTPUT_TOKENS;
  }
  // F4 在线路径上下文硬裁剪：只在模型**声明了** contextWindow（且未显式关闭裁剪）时
  // 生效，复用本地模型同款 trimMessagesToContext（系统提示恒保留、最旧的非系统消息先丢）。
  // 未声明窗口时不做任何裁剪——避免按 200K 兜底误伤大窗口模型。这样即便「记忆总结」
  // 关闭、80% 自动压缩不接线，超窗请求也有最后一道防线。
  const requestMessages = trimOnlineMessages(messages, {
    contextWindow: modelCaps.contextWindow,
    reserveOutputTokens: Number(samplingParams.max_tokens) > 0 ? Number(samplingParams.max_tokens) : 0,
    enabled: !(options && options.disableContextTrim === true),
  });
  if (options && (options.expectedConfigId || options.expectedConfigFingerprint)) {
    const latestConfig = await getActiveApiConfig();
    if (
      (options.expectedConfigId && latestConfig.id !== options.expectedConfigId)
      || (
        options.expectedConfigFingerprint
        && getConfigFingerprint(latestConfig) !== options.expectedConfigFingerprint
      )
    ) {
      throw configChangedError();
    }
  }

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let consumed = 0;
    let lineBuffer = '';
    let dataLines = [];
    let fullText = '';
    let fullReasoning = '';
    let finishReason = null;
    const toolCallEntries = new Map();
    let sawSse = false;
    let sawPayloadData = false;
    let sawFirstByte = false;
    let parseFailures = 0;
    let canceled = false;
    let settled = false;
    let idleTimer = null;
    let removeAbortListener = null;
    // E1：usage 是缓存命中的观测来源。流式下通常在最后一个 chunk 才出现（OpenAI 的
    // stream_options / DeepSeek 尾部 / Anthropic 的 message_delta），取**最新一次**即可。
    let latestUsage = null;

    // parseStreamPayload 已把三种协议的增量归一成 { index, id, name, arguments }，
    // 这里只负责按 index 归并 arguments 分片。
    const mergeToolCallDeltas = list => {
      for (const raw of list) {
        const index = Number.isInteger(raw && raw.index) ? raw.index : 0;
        const entry = toolCallEntries.get(index) || { index, id: '', name: '', arguments: '' };
        if (raw && typeof raw.id === 'string' && raw.id) entry.id = raw.id;
        if (raw && typeof raw.name === 'string' && raw.name) entry.name = raw.name;
        if (raw && typeof raw.arguments === 'string') entry.arguments += raw.arguments;
        toolCallEntries.set(index, entry);
      }
    };
    const collectToolCalls = () => Array.from(toolCallEntries.values())
      .filter(entry => entry.name)
      .sort((a, b) => a.index - b.index)
      .map(entry => ({ id: entry.id, name: entry.name, arguments: entry.arguments }));
    const makeResult = () => ({
      text: fullText,
      reasoning: fullReasoning,
      toolCalls: collectToolCalls(),
      finishReason,
      // E1：可能为 null（端点不返回 usage）——调用方必须容忍缺失。
      usage: latestUsage,
    });

    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      if (removeAbortListener) {
        removeAbortListener();
        removeAbortListener = null;
      }
      fn(value);
    };
    const succeed = value => settle(resolve, value);
    const fail = error => {
      // 已结算后到达的失败（典型：失败结算后再触发 xhr.abort 引发的 onabort）
      // 必须忽略，否则会把用户主动停止误记成「请求已中断」污染诊断日志。
      if (settled) return undefined;
      // 中止与配置切换是预期的控制流，不进诊断日志；其余失败记录一次（脱敏）。
      const message = String((error && error.message) || '');
      if (message !== CONFIG_CHANGED_ERROR && !isCanceledError(error)) {
        recordDiagnostic('api', error, '聊天接口请求失败');
      }
      return settle(reject, error);
    };
    let configCheckInFlight = false;
    const checkCurrentConfig = async () => {
      if (!options || (!options.expectedConfigId && !options.expectedConfigFingerprint)) return;
      const latestConfig = await getActiveApiConfig();
      if (
        (options.expectedConfigId && latestConfig.id !== options.expectedConfigId)
        || (
          options.expectedConfigFingerprint
          && getConfigFingerprint(latestConfig) !== options.expectedConfigFingerprint
        )
      ) {
        throw configChangedError();
      }
    };
    const finishWithConfig = callback => {
      if (settled || configCheckInFlight) return;
      configCheckInFlight = true;
      checkCurrentConfig()
        .then(callback)
        .catch(error => {
          fail(error);
          try {
            xhr.abort();
          } catch (abortError) {}
        })
        .finally(() => {
          configCheckInFlight = false;
        });
    };

    const finishFromStream = () => {
      finishWithConfig(() => {
        if (fullText || toolCallEntries.size > 0) {
          succeed(makeResult());
          xhr.abort();
          return;
        }
        if (!sawPayloadData && parseFailures > 0) {
          fail(new Error('接口返回了无法解析的内容。'));
          xhr.abort();
          return;
        }
        succeed(makeResult());
        xhr.abort();
      });
    };

    const armIdleTimer = () => {
      if (settled) return;
      if (idleTimer) clearTimeout(idleTimer);
      const waitingFirstByte = !sawFirstByte;
      idleTimer = setTimeout(() => {
        const timeoutError = new Error(waitingFirstByte
          ? '等待首个响应超时，请检查网络或 API 地址（推理模型可能较慢，可稍后重试）'
          : '请求超时，请检查网络后重试');
        // 结构化标记（2026-10-10，P0-7）：降级链要判断「这次失败值不值得换模型重试」，
        // 靠文案匹配会被翻译/措辞改动带偏，所以在这里挂上可判定的字段。
        timeoutError.timeout = true;
        timeoutError.firstByte = waitingFirstByte;
        fail(timeoutError);
        xhr.abort();
      }, waitingFirstByte ? FIRST_BYTE_TIMEOUT_MS : IDLE_TIMEOUT_MS);
    };

    const tryDispatch = () => {
      if (settled || dataLines.length === 0) return false;
      const joined = dataLines.join('\n').trim();
      if (!joined) {
        dataLines = [];
        return false;
      }
      if (joined === '[DONE]') {
        dispatchEvent();
        return true;
      }
      try {
        JSON.parse(joined);
      } catch (error) {
        return false;
      }
      dispatchEvent();
      return true;
    };

    const dispatchEvent = () => {
      if (settled || dataLines.length === 0) {
        dataLines = [];
        return;
      }
      const payloadText = dataLines.join('\n').trim();
      dataLines = [];
      if (!payloadText) return;
      sawSse = true;
      if (payloadText === '[DONE]') {
        finishFromStream();
        return;
      }

      let payload;
      try {
        payload = JSON.parse(payloadText);
      } catch (error) {
        parseFailures += 1;
        return;
      }
      sawPayloadData = true;

      // E1：流式 usage（若有）——通常只在最后一个 chunk 出现，取最新一次。
      const streamUsage = extractUsage(payload);
      if (streamUsage) latestUsage = streamUsage;

      // 各协议的错误体位置不同；先看协议通用错误，再看 OpenAI 兼容的顶层 error。
      const parsed = parseStreamPayload(protocol, payload);
      const errorMessage = (parsed && parsed.error)
        || extractErrorMessage(payload);
      if (errorMessage) {
        throw new Error(errorMessage);
      }

      if (parsed.reasoning) {
        fullReasoning += parsed.reasoning;
        if (onReasoning) onReasoning(fullReasoning);
      }

      if (Array.isArray(parsed.toolCalls) && parsed.toolCalls.length) {
        mergeToolCallDeltas(parsed.toolCalls);
      }
      if (parsed.finishReason) finishReason = parsed.finishReason;

      const delta = parsed.text;
      if (!delta) return;
      fullText += delta;
      if (onChunk) onChunk(fullText);
    };

    // SSE 事件由若干行组成、以空行分隔；同一事件的多个 `data:` 行需按规范用
    // 换行拼接后再解析。但部分服务端不补空行，直接连发多条完整 `data:`，因此
    // 追加新行前先试探上一段是否已是完整事件：能解析就先派发，否则继续累积。
    const handleLine = line => {
      if (settled) return;
      const trimmed = line.replace(/\r$/, '').trim();
      if (!trimmed) {
        dispatchEvent();
        return;
      }
      if (trimmed.startsWith(':')) return;
      if (!trimmed.startsWith('data:')) return;
      tryDispatch();
      dataLines.push(trimmed.slice(5).trim());
    };

    const drainIncremental = () => {
      const incoming = (xhr.responseText || '').slice(consumed);
      if (!incoming) return;
      sawFirstByte = true;
      consumed = (xhr.responseText || '').length;
      lineBuffer += incoming;
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() || '';
      for (const line of lines) {
        handleLine(line);
      }
    };

    xhr.open('POST', url);
    const headers = buildRequestHeaders(protocol, config, { stream });
    Object.keys(headers).forEach(name => xhr.setRequestHeader(name, headers[name]));

    if (signal) {
      const onAbortSignal = () => {
        if (settled) return;
        canceled = true;
        fail(createAbortError());
        xhr.abort();
      };
      removeAbortListener = () => signal.removeEventListener('abort', onAbortSignal);
      signal.addEventListener('abort', onAbortSignal);
      if (signal.aborted) onAbortSignal();
    }

    xhr.onprogress = () => {
      if (settled) return;
      try {
        if (stream && (!xhr.status || (xhr.status >= 200 && xhr.status < 300))) drainIncremental();
        if (settled) return;
        armIdleTimer();
      } catch (error) {
        fail(error);
        xhr.abort();
      }
    };

    xhr.onload = () => {
      if (settled) return;
      if (xhr.status < 200 || xhr.status >= 300) {
        const httpError = new Error(formatApiError(xhr.responseText, xhr.status));
        // 结构化状态码（P0-7）：429 与 5xx 可降级重试，4xx 其余是确定性失败（换模型也一样）。
        httpError.httpStatus = xhr.status;
        fail(httpError);
        return;
      }
      try {
        drainIncremental();
        if (lineBuffer) {
          handleLine(lineBuffer);
          lineBuffer = '';
        }
        dispatchEvent();
      } catch (error) {
        fail(error);
        return;
      }

      if (settled) return;
      if (fullText || toolCallEntries.size > 0) {
        finishWithConfig(() => succeed(makeResult()));
        return;
      }

      if (sawSse) {
        finishFromStream();
        return;
      }

      const body = (xhr.responseText || '').trim();
      if (!body) {
        finishWithConfig(() => succeed(makeResult()));
        return;
      }
      try {
        const data = JSON.parse(body);
        // HTTP 200 也可能带 error（网关/服务商的错误体），必须按失败处理，
        // 否则会被当成“空回复”继续朗读、记账、写总结。
        const errorMessage = parseProtocolError(protocol, data) || extractErrorMessage(data);
        if (errorMessage) {
          fail(new Error(errorMessage));
          return;
        }
        // E1：非流式路径同样提取 usage（同一纯函数，口径一致）。
        const bodyUsage = extractUsage(data);
        if (bodyUsage) latestUsage = bodyUsage;
        const parsed = parseFinalPayload(protocol, data);
        if (parsed.reasoning) {
          fullReasoning = parsed.reasoning;
          if (onReasoning) onReasoning(parsed.reasoning);
        }
        if (Array.isArray(parsed.toolCalls) && parsed.toolCalls.length) {
          mergeToolCallDeltas(parsed.toolCalls);
        }
        if (parsed.finishReason) finishReason = parsed.finishReason;
        fullText = parsed.text;
        finishWithConfig(() => succeed(makeResult()));
      } catch (error) {
        fail(new Error('接口返回了无法解析的内容。'));
      }
    };

    xhr.onerror = () => {
      const networkError = new Error('网络请求失败，请检查网络或 API 地址。');
      // 结构化标记（P0-7）：网络不可达是可降级失败（换模型/换线路都可能成功）。
      networkError.network = true;
      fail(networkError);
    };
    xhr.onabort = () => fail(canceled ? createAbortError() : new Error('请求已中断。'));

    if (settled) return;
    try {
      const body = buildRequestBody({
        protocol,
        model,
        messages: requestMessages,
        stream,
        tools,
        toolChoice,
        samplingParams,
        thinkingParams,
        thinkingSettings,
        config,
        // 能力按模型解析后传入（apiProtocols 保持纯函数，不依赖存储层）。
        capabilities: capabilitiesForModel(config, model),
      });
      xhr.send(JSON.stringify(body));
      armIdleTimer();
    } catch (error) {
      fail(error);
    }
  });
}

// 兼容薄包装：保持既有 string 返回与 EMPTY_REPLY_TEXT 语义（流式/非流式两条
// 路径都在这里兜底），工具轮请直接用 streamChatCompletion。
export async function sendChatMessage(messages, options = {}) {
  const result = await streamChatCompletion(messages, options);
  return result.text || EMPTY_REPLY_TEXT;
}

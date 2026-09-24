import { getActiveApiConfig, getActiveModel, getSamplingSettings, getThinkingSettings } from './storage';
import { registerSecretValues } from './secrets';

// 首包（首字节）等待单独放宽：推理模型思考期间可能几十秒不吐字，
// 用同一个 30s 阈值会误报“请求超时”。
const FIRST_BYTE_TIMEOUT_MS = 120000;
const IDLE_TIMEOUT_MS = 30000;

// 接口没有返回内容时的占位文本。调用方可用它区分“真的没回复”，
// 避免把这段占位当成角色的真实回复（例如写入动态评论）。
export const EMPTY_REPLY_TEXT = '没有收到回复。';
export const CONFIG_CHANGED_ERROR = '模型来源已切换，请重新发送';

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
  return fingerprint(JSON.stringify([
    String(source.id || ''),
    String(source.baseUrl || ''),
    String(getActiveModel(source) || ''),
    String(source.apiKey || ''),
    String(source.authHeader || 'Authorization'),
    String(source.authScheme === undefined ? 'Bearer ' : source.authScheme),
    source.supportsVision === true,
    source.supportsThinking === true,
  ]));
}

export function isConfigChangedError(error) {
  return !!error && error.message === CONFIG_CHANGED_ERROR;
}

export function buildThinkingParams(config, settings) {
  if (!settings || settings.enabled !== true) return {};
  if (!config || config.supportsThinking !== true) return {};
  const declaration = config.thinking || {};
  const field = String(declaration.field || 'reasoning_effort') || 'reasoning_effort';
  const level = ['low', 'medium', 'high'].includes(settings.level) ? settings.level : 'medium';
  const format = declaration.format || 'effort';
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
    const message = data.error?.message || data.message || data.error;
    if (typeof message === 'string' && message.trim()) {
      return message.trim();
    }
  } catch (error) {}

  const trimmed = (text || '').trim();
  if (!trimmed || trimmed.startsWith('<')) {
    return `请求失败（HTTP ${status}）`;
  }
  return trimmed.slice(0, 300);
}

function extractDeltaContent(payload) {
  const choice = payload?.choices?.[0];
  const delta = choice?.delta?.content;
  if (typeof delta === 'string') return delta;
  const message = choice?.message?.content;
  return typeof message === 'string' ? message : '';
}

function extractReasoningDelta(payload) {
  const choice = payload?.choices?.[0];
  const delta = choice?.delta?.reasoning_content ?? choice?.delta?.reasoning;
  if (typeof delta === 'string') return delta;
  const message = choice?.message?.reasoning_content ?? choice?.message?.reasoning;
  return typeof message === 'string' ? message : '';
}

function extractErrorMessage(payload) {
  if (!payload || !payload.error) return '';
  if (typeof payload.error === 'string') return payload.error;
  if (typeof payload.error.message === 'string') return payload.error.message;
  return '接口返回错误。';
}

function createAbortError() {
  const error = new Error('已停止生成。');
  error.name = 'AbortError';
  error.canceled = true;
  return error;
}

export function isCanceledError(error) {
  return !!error && (error.canceled === true || error.name === 'AbortError');
}

export async function sendChatMessage(messages, options = {}) {
  const onChunk = options && typeof options.onChunk === 'function' ? options.onChunk : null;
  const onReasoning = options && typeof options.onReasoning === 'function' ? options.onReasoning : null;
  const signal = options && options.signal ? options.signal : null;
  const stream = options && options.stream === false ? false : true;
  if (signal && signal.aborted) {
    throw createAbortError();
  }
  const config = await getActiveApiConfig();
  if (options && options.expectedConfigId && config.id !== options.expectedConfigId) {
    throw new Error(CONFIG_CHANGED_ERROR);
  }
  if (
    options
    && options.expectedConfigFingerprint
    && getConfigFingerprint(config) !== options.expectedConfigFingerprint
  ) {
    throw new Error(CONFIG_CHANGED_ERROR);
  }
  if (signal && signal.aborted) {
    throw createAbortError();
  }
  // 登记当前密钥：报错文本可能带出裸 Key，脱敏时才能按真实值兜住
  registerSecretValues([config.apiKey]);
  if (!config.apiKey) {
    throw new Error('请先在“设置”里填写 API Key。');
  }
  if (!String(config.baseUrl || '').trim()) {
    throw new Error('请先在“设置 → API 配置”里填写 API 地址。');
  }
  const model = getActiveModel(config);
  const hasModel = (Array.isArray(config.models) && config.models.length > 0)
    || String(config.activeModel || '').trim()
    || String(config.model || '').trim();
  if (!hasModel) {
    throw new Error('请先在“设置 → API 配置”里添加并选择模型。');
  }
  if (config.protocol === 'anthropic') {
    throw new Error('Claude 协议暂未开放，请在「设置 → API 配置」改用 OpenAI 兼容协议。');
  }

  const url = normalizeChatUrl(config.baseUrl);
  const thinkingSettings = await getThinkingSettings().catch(() => null);
  const thinkingParams = buildThinkingParams(config, thinkingSettings);
  const samplingSettings = await getSamplingSettings().catch(() => null);
  const samplingParams = buildSamplingParams(samplingSettings);
  if (options && (options.expectedConfigId || options.expectedConfigFingerprint)) {
    const latestConfig = await getActiveApiConfig();
    if (
      (options.expectedConfigId && latestConfig.id !== options.expectedConfigId)
      || (
        options.expectedConfigFingerprint
        && getConfigFingerprint(latestConfig) !== options.expectedConfigFingerprint
      )
    ) {
      throw new Error(CONFIG_CHANGED_ERROR);
    }
  }

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let consumed = 0;
    let lineBuffer = '';
    let fullText = '';
    let fullReasoning = '';
    let sawSse = false;
    let sawPayloadData = false;
    let sawFirstByte = false;
    let parseFailures = 0;
    let canceled = false;
    let settled = false;
    let idleTimer = null;
    let removeAbortListener = null;

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
    const fail = error => settle(reject, error);

    const finishFromStream = () => {
      if (fullText) {
        succeed(fullText);
        return;
      }
      if (!sawPayloadData && parseFailures > 0) {
        fail(new Error('接口返回了无法解析的内容。'));
        return;
      }
      succeed(EMPTY_REPLY_TEXT);
    };

    const armIdleTimer = () => {
      if (settled) return;
      if (idleTimer) clearTimeout(idleTimer);
      const waitingFirstByte = !sawFirstByte;
      idleTimer = setTimeout(() => {
        fail(new Error(waitingFirstByte
          ? '等待首个响应超时，请检查网络或 API 地址（推理模型可能较慢，可稍后重试）'
          : '请求超时，请检查网络后重试'));
        xhr.abort();
      }, waitingFirstByte ? FIRST_BYTE_TIMEOUT_MS : IDLE_TIMEOUT_MS);
    };

    const handleLine = line => {
      if (settled) return;
      const trimmed = line.replace(/\r$/, '').trim();
      if (!trimmed || trimmed.startsWith(':')) return;
      if (!trimmed.startsWith('data:')) return;
      const payloadText = trimmed.slice(5).trim();
      if (!payloadText) return;
      sawSse = true;
      if (payloadText === '[DONE]') {
        finishFromStream();
        xhr.abort();
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

      const errorMessage = extractErrorMessage(payload);
      if (errorMessage) {
        throw new Error(errorMessage);
      }

      const reasoningDelta = extractReasoningDelta(payload);
      if (reasoningDelta) {
        fullReasoning += reasoningDelta;
        if (onReasoning) onReasoning(fullReasoning);
      }

      const delta = extractDeltaContent(payload);
      if (!delta) return;
      fullText += delta;
      if (onChunk) onChunk(fullText);
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
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.setRequestHeader('Accept', 'text/event-stream');
    const authHeader = String(config.authHeader || 'Authorization');
    const authScheme = config.authScheme === undefined ? 'Bearer ' : String(config.authScheme);
    xhr.setRequestHeader(authHeader, `${authScheme}${config.apiKey}`);

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
        fail(new Error(formatApiError(xhr.responseText, xhr.status)));
        return;
      }
      try {
        drainIncremental();
        if (lineBuffer) {
          handleLine(lineBuffer);
          lineBuffer = '';
        }
      } catch (error) {
        fail(error);
        return;
      }

      if (settled) return;
      if (fullText) {
        succeed(fullText);
        return;
      }

      if (sawSse) {
        finishFromStream();
        return;
      }

      const body = (xhr.responseText || '').trim();
      if (!body) {
        succeed(EMPTY_REPLY_TEXT);
        return;
      }
      try {
        const data = JSON.parse(body);
        // HTTP 200 也可能带 error（网关/服务商的错误体），必须按失败处理，
        // 否则会被当成“空回复”继续朗读、记账、写总结。
        const errorMessage = extractErrorMessage(data);
        if (errorMessage) {
          fail(new Error(errorMessage));
          return;
        }
        const message = data?.choices?.[0]?.message || {};
        const reasoning = typeof message.reasoning_content === 'string'
          ? message.reasoning_content
          : (typeof message.reasoning === 'string' ? message.reasoning : '');
        if (reasoning && onReasoning) onReasoning(reasoning);
        succeed(message.content || EMPTY_REPLY_TEXT);
      } catch (error) {
        fail(new Error('接口返回了无法解析的内容。'));
      }
    };

    xhr.onerror = () => fail(new Error('网络请求失败，请检查网络或 API 地址。'));
    xhr.onabort = () => fail(canceled ? createAbortError() : new Error('请求已中断。'));

    if (settled) return;
    try {
      xhr.send(JSON.stringify({ model, messages, stream, ...thinkingParams, ...samplingParams }));
      armIdleTimer();
    } catch (error) {
      fail(error);
    }
  });
}

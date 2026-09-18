import { getActiveApiConfig, getActiveModel, getThinkingSettings } from './storage';

const IDLE_TIMEOUT_MS = 30000;

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
  if (signal && signal.aborted) {
    throw createAbortError();
  }
  if (!config.apiKey) {
    throw new Error('请先在“设置”里填写 API Key。');
  }

  const model = getActiveModel(config);
  const url = normalizeChatUrl(config.baseUrl);
  const thinkingSettings = await getThinkingSettings().catch(() => null);
  const thinkingParams = buildThinkingParams(config, thinkingSettings);

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let consumed = 0;
    let lineBuffer = '';
    let fullText = '';
    let fullReasoning = '';
    let sawSse = false;
    let sawPayloadData = false;
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
      succeed('没有收到回复。');
    };

    const armIdleTimer = () => {
      if (settled) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        fail(new Error('请求超时，请检查网络后重试'));
        xhr.abort();
      }, IDLE_TIMEOUT_MS);
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
    xhr.setRequestHeader('Authorization', `Bearer ${config.apiKey}`);

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
        succeed('没有收到回复。');
        return;
      }
      try {
        const data = JSON.parse(body);
        const message = data?.choices?.[0]?.message || {};
        const reasoning = typeof message.reasoning_content === 'string'
          ? message.reasoning_content
          : (typeof message.reasoning === 'string' ? message.reasoning : '');
        if (reasoning && onReasoning) onReasoning(reasoning);
        succeed(message.content || '没有收到回复。');
      } catch (error) {
        fail(new Error('接口返回了无法解析的内容。'));
      }
    };

    xhr.onerror = () => fail(new Error('网络请求失败，请检查网络或 API 地址。'));
    xhr.onabort = () => fail(canceled ? createAbortError() : new Error('请求已中断。'));

    if (settled) return;
    try {
      xhr.send(JSON.stringify({ model, messages, stream, ...thinkingParams }));
      armIdleTimer();
    } catch (error) {
      fail(error);
    }
  });
}

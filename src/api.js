import { getApiConfig } from './storage';

const IDLE_TIMEOUT_MS = 30000;

function normalizeChatUrl(baseUrl) {
  const trimmed = (baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
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

function extractErrorMessage(payload) {
  if (!payload || !payload.error) return '';
  if (typeof payload.error === 'string') return payload.error;
  if (typeof payload.error.message === 'string') return payload.error.message;
  return '接口返回错误。';
}

export async function sendChatMessage(messages, options = {}) {
  const onChunk = options && typeof options.onChunk === 'function' ? options.onChunk : null;
  const config = await getApiConfig();
  if (!config.apiKey) {
    throw new Error('请先在“设置”里填写 API Key。');
  }

  const model = config.model || 'deepseek-chat';
  const url = normalizeChatUrl(config.baseUrl);

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let consumed = 0;
    let lineBuffer = '';
    let fullText = '';
    let sawSse = false;
    let settled = false;
    let idleTimer = null;

    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      fn(value);
    };
    const succeed = value => settle(resolve, value);
    const fail = error => settle(reject, error);

    const armIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        fail(new Error('请求超时，请检查网络后重试'));
        xhr.abort();
      }, IDLE_TIMEOUT_MS);
    };

    const handleLine = line => {
      const trimmed = line.replace(/\r$/, '').trim();
      if (!trimmed || trimmed.startsWith(':')) return;
      if (!trimmed.startsWith('data:')) return;
      const payloadText = trimmed.slice(5).trim();
      if (!payloadText) return;
      sawSse = true;
      if (payloadText === '[DONE]') {
        succeed(fullText || '没有收到回复。');
        xhr.abort();
        return;
      }

      let payload;
      try {
        payload = JSON.parse(payloadText);
      } catch (error) {
        return;
      }

      const errorMessage = extractErrorMessage(payload);
      if (errorMessage) {
        throw new Error(errorMessage);
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

    xhr.onprogress = () => {
      try {
        drainIncremental();
        if (settled) return;
        armIdleTimer();
      } catch (error) {
        fail(error);
        xhr.abort();
      }
    };

    xhr.onload = () => {
      if (settled) return;
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

      if (xhr.status < 200 || xhr.status >= 300) {
        fail(new Error(formatApiError(xhr.responseText, xhr.status)));
        return;
      }

      if (fullText) {
        succeed(fullText);
        return;
      }

      if (sawSse) {
        succeed('没有收到回复。');
        return;
      }

      const body = (xhr.responseText || '').trim();
      if (!body) {
        succeed('没有收到回复。');
        return;
      }
      try {
        const data = JSON.parse(body);
        const content = data?.choices?.[0]?.message?.content;
        succeed(content || '没有收到回复。');
      } catch (error) {
        fail(new Error('接口返回了无法解析的内容。'));
      }
    };

    xhr.onerror = () => fail(new Error('网络请求失败，请检查网络或 API 地址。'));
    xhr.onabort = () => fail(new Error('请求已中断。'));

    try {
      xhr.send(JSON.stringify({ model, messages, stream: true }));
      armIdleTimer();
    } catch (error) {
      fail(error);
    }
  });
}

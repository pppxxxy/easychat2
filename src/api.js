import { getApiConfig } from './storage';

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

export async function sendChatMessage(messages) {
  const config = await getApiConfig();
  if (!config.apiKey) {
    throw new Error('请先在“设置”里填写 API Key。');
  }

  const model = config.model || 'deepseek-chat';
  const url = normalizeChatUrl(config.baseUrl);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`
    },
    body: JSON.stringify({ model, messages, stream: false })
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(formatApiError(text, response.status));
  }

  try {
    const data = JSON.parse(text);
    return data.choices?.[0]?.message?.content || '没有收到回复。';
  } catch (error) {
    throw new Error('接口返回了无法解析的内容。');
  }
}

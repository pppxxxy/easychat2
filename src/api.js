import { getApiConfig } from './storage';

export async function sendChatMessage(messages) {
  const config = await getApiConfig();
  if (!config.apiKey) {
    throw new Error('请先在“设置”里填写 API Key。');
  }

  const baseUrl = (config.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
  const model = config.model || 'deepseek-chat';

  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`
    },
    body: JSON.stringify({ model, messages, stream: false })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content || '没有收到回复。';
}

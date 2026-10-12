// EasyChat2 Agent SDK（JS/TS 兼容）——差距 #3「程序化接口 / SDK」的客户端。
//
// 依赖为零：只用注入的 fetch（默认 globalThis.fetch）。驱动本机「本地 OpenAI 兼容 server」
// （plugins/localApiServer：`/v1/chat/completions`、`/v1/agent`、`/v1/models`，回环 + Bearer）。
//
// 三个方法：
//   listModels()                         → 已安装模型清单
//   runAgent({ prompt, mode, ... })      → 跑一轮 agent 工具循环，返回 object:'agent.run' 结果
//   streamChat({ messages, model, ... }) → 流式聊天（SSE），逐 token 回调
//
// 纯解析（parseSseText）与客户端分离：前者可 Node 直测；后者注入 fetch 亦可直测。

import { safeJsonParse } from '../utils/safeJson.js';

export const SDK_DEFAULT_BASE_URL = 'http://127.0.0.1:8686';
export const AGENT_RUN_OBJECT = 'agent.run';

// 解析一段 SSE 文本 → { events: [{ event, data }], rest }。rest 是未闭合的尾部（下次拼接）。
// 纯函数：把「chunk 边界可能切在行中间」这件事交给调用方用 rest 处理。
export function parseSseText(text) {
  const raw = String(text == null ? '' : text);
  const blocks = raw.split('\n\n');
  const rest = blocks.pop() || '';
  const events = [];
  for (const block of blocks) {
    let event = 'message';
    const dataLines = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    if (dataLines.length === 0) continue;
    const data = dataLines.join('\n');
    // 解析失败时保留原文（回退即 text 本身）——实现在 utils/safeJson.js。
    events.push({ event, data: data === '[DONE]' ? '[DONE]' : safeJsonParse(data, data) });
  }
  return { events, rest };
}

// 从 OpenAI 风格 chunk 里取增量文本（兼容 chat.completion.chunk 与 responses 事件）。
export function chunkText(chunk) {
  if (!chunk || typeof chunk !== 'object') return '';
  const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : null;
  const delta = choice && choice.delta;
  if (delta && typeof delta.content === 'string') return delta.content;
  if (choice && typeof choice.text === 'string') return choice.text;
  if (typeof chunk.delta === 'string') return chunk.delta;
  return '';
}

export function createAgentClient({ baseUrl = SDK_DEFAULT_BASE_URL, apiKey = '', fetchImpl = null } = {}) {
  const root = String(baseUrl || SDK_DEFAULT_BASE_URL).replace(/\/+$/, '');
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) throw new Error('createAgentClient requires fetch (pass fetchImpl)');

  const headers = extra => ({
    'Content-Type': 'application/json',
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    ...(extra || {}),
  });

  async function listModels() {
    const res = await doFetch(`${root}/v1/models`, { headers: headers() });
    if (!res.ok) throw new Error(`listModels 失败：HTTP ${res.status}`);
    return res.json();
  }

  async function runAgent({ prompt = '', mode = 'read', characterId = 'default', extra = {} } = {}) {
    const res = await doFetch(`${root}/v1/agent`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ prompt, mode, characterId, ...extra }),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`runAgent 失败：HTTP ${res.status}`);
    return json;
  }

  // 流式聊天：逐 token 调 onToken(text)。返回完整文本。
  async function streamChat({ messages = [], model = '', onToken = null, extra = {} } = {}) {
    const res = await doFetch(`${root}/v1/chat/completions`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ model, messages, stream: true, ...extra }),
    });
    if (!res.ok) throw new Error(`streamChat 失败：HTTP ${res.status}`);
    if (!res.body || typeof res.body.getReader !== 'function') {
      const json = await res.json();
      const text = chunkText(json) || (json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) || '';
      if (typeof onToken === 'function' && text) onToken(text);
      return text;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let full = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { events, rest } = parseSseText(buffer);
      buffer = rest;
      for (const item of events) {
        if (item.data === '[DONE]') continue;
        const text = chunkText(item.data);
        if (text) { full += text; if (typeof onToken === 'function') onToken(text); }
      }
    }
    return full;
  }

  return { baseUrl: root, listModels, runAgent, streamChat };
}

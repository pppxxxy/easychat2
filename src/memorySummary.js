import { sendChatMessage } from './api';
import { createWorldEntry } from './cardParser';
import { setSessionSummarizedUpTo } from './storage';

export const MEMORY_SUMMARY_PREFIX = '记忆总结';
export const KEEP_RECENT = 6;
export const DEFAULT_THRESHOLD = 40;
export const FALLBACK_KEYWORDS = ['前情提要'];

const SUMMARY_INSTRUCTION =
  '你是对话摘要助手。请阅读用户给出的对话记录，输出一个 JSON 对象，格式为 '
  + '{"summary": "摘要", "keywords": ["关键词1", "关键词2"]}。'
  + 'summary 用第三人称概括对话中的关键事件、人物关系与设定，控制在 300 字以内；'
  + 'keywords 为 3 到 8 个便于日后检索的词或短语。只输出 JSON，不要添加解释或代码块标记。';

function isConversational(message) {
  return !!message
    && (message.role === 'user' || message.role === 'assistant')
    && !message.pending
    && String(message.text || '').trim().length > 0;
}

export function selectSummarizable(messages, summarizedUpTo, keepRecent = KEEP_RECENT) {
  const list = (Array.isArray(messages) ? messages : []).filter(isConversational);
  if (list.length === 0) return [];
  let start = 0;
  if (summarizedUpTo) {
    const index = list.findIndex(item => item.id === summarizedUpTo);
    start = index >= 0 ? index + 1 : 0;
  }
  const end = list.length - Math.max(0, keepRecent);
  if (end <= start) return [];
  return list.slice(start, end);
}

export function shouldSummarize({ session, messages, settings, force = false } = {}) {
  if (!force && (!settings || settings.enabled !== true)) return false;
  const list = (Array.isArray(messages) ? messages : []).filter(isConversational);
  const threshold = Number(settings && settings.threshold);
  const limit = Number.isFinite(threshold) && threshold > 0 ? threshold : DEFAULT_THRESHOLD;
  if (list.length < limit) return false;
  return selectSummarizable(list, session && session.summarizedUpTo).length > 0;
}

export function buildSummaryPrompt(messages, userName) {
  const speakerForUser = String(userName || '').trim() || '用户';
  const lines = (Array.isArray(messages) ? messages : []).map(item => {
    const speaker = item.role === 'user' ? speakerForUser : '角色';
    return `${speaker}：${String(item.text || '').trim()}`;
  });
  return [
    { role: 'system', content: SUMMARY_INSTRUCTION },
    { role: 'user', content: lines.join('\n') },
  ];
}

function extractJson(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : raw;
  try {
    return JSON.parse(candidate);
  } catch (error) {}
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch (error) {}
  }
  return null;
}

export function parseSummaryResponse(text) {
  const parsed = extractJson(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('记忆总结返回格式无法解析');
  }
  const summary = String(parsed.summary || parsed.text || '').trim();
  if (!summary) throw new Error('记忆总结内容为空');
  const keywords = (Array.isArray(parsed.keywords) ? parsed.keywords : [])
    .map(item => String(item || '').trim())
    .filter(Boolean);
  return {
    summary,
    keywords: keywords.length ? keywords : [...FALLBACK_KEYWORDS],
  };
}

export async function generateSummary({ character, messages, userName }) {
  const prompt = buildSummaryPrompt(messages, userName);
  const text = await sendChatMessage(prompt);
  return parseSummaryResponse(text);
}

function summaryIndex(comment) {
  const match = String(comment || '').match(/(\d+)\s*$/);
  return match ? Number(match[1]) : 0;
}

export function buildMemorySummaryText(character) {
  const entries = (Array.isArray(character && character.worldInfo) ? character.worldInfo : [])
    .filter(entry => entry
      && entry.enabled !== false
      && String(entry.comment || '').trim().startsWith(MEMORY_SUMMARY_PREFIX)
      && String(entry.content || '').trim())
    .sort((a, b) => summaryIndex(a.comment) - summaryIndex(b.comment));
  return entries.map(entry => String(entry.content).trim()).join('\n\n');
}

export async function applySummary({
  session,
  character,
  messages,
  updateCharacter,
  userName,
}) {
  const list = (Array.isArray(messages) ? messages : []).filter(isConversational);
  if (list.length === 0) {
    throw new Error('没有可总结的消息');
  }
  const { summary, keywords } = await generateSummary({ character, messages: list, userName });
  const worldInfo = Array.isArray(character && character.worldInfo) ? character.worldInfo : [];
  const count = worldInfo.filter(entry =>
    String((entry && entry.comment) || '').trim().startsWith(MEMORY_SUMMARY_PREFIX)
  ).length;
  const entry = createWorldEntry({
    id: `memory-summary-${Date.now()}`,
    comment: `${MEMORY_SUMMARY_PREFIX} ${count + 1}`,
    keys: keywords,
    content: summary,
    constant: false,
    enabled: true,
    position: 0,
    order: 100,
  }, count);
  await updateCharacter({ id: character.id, worldInfo: [...worldInfo, entry] });
  const boundary = list[list.length - 1].id;
  await setSessionSummarizedUpTo(session.id, boundary);
  return { entry, boundary, summary, keywords };
}

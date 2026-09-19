import { sendChatMessage } from './api';
import { createWorldEntry } from './cardParser';
import { setSessionSummarizedUpTo } from './storage';

export const MEMORY_SUMMARY_PREFIX = '记忆总结';
export const KEEP_RECENT = 6;
export const DEFAULT_THRESHOLD = 40;
export const FALLBACK_KEYWORDS = ['前情提要'];

const SUMMARY_INSTRUCTION = [
  '从本段对话中提取值得在后续对话中记住的新信息，包括人物的重要事实与偏好、关系变化、关键事件、约定及未完成事项。',
  '',
  '已知记忆：',
  '<memories>',
  '{{memories}}',
  '</memories>',
  '',
  '要求：',
  '- 只记录对话中明确出现的信息，不猜测，不提取思考过程，不把假设或计划写成已发生的事实。',
  '- 跳过已有记忆和无关紧要的细节。明确的纠正或状态变化应作为新记忆记录，说明变化。',
  '- 每条记忆应能独立理解，写清涉及的人物，保留必要的时间、地点和因果。',
  '- 只输出新增记忆，每行一条，以“- ”开头。无新增信息时不输出任何内容。',
].join('\n');

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

export function buildSummaryPrompt(messages, userName, memories = '') {
  const speakerForUser = String(userName || '').trim() || '用户';
  const lines = (Array.isArray(messages) ? messages : []).map(item => {
    const speaker = item.role === 'user' ? speakerForUser : '角色';
    return `${speaker}：${String(item.text || '').trim()}`;
  });
  const memoryText = String(memories || '').trim() || '（暂无已记录的记忆）';
  return [
    { role: 'system', content: SUMMARY_INSTRUCTION.replace('{{memories}}', memoryText) },
    { role: 'user', content: lines.join('\n') },
  ];
}

export function parseMemoryLines(text) {
  return String(text || '')
    .split('\n')
    .map(line => line.trim())
    .map(line => line.replace(/^[-*•]\s*/, '').trim())
    .filter(line => line && !/^（暂无已记录的记忆）$/.test(line));
}

export function parseSummaryResponse(text) {
  const lines = parseMemoryLines(text);
  if (lines.length === 0) throw new Error('记忆总结内容为空');
  const summary = lines.map(line => `- ${line}`).join('\n');
  return {
    summary,
    lines,
    keywords: [...FALLBACK_KEYWORDS],
  };
}

export async function generateSummary({ character, messages, userName, memories }) {
  const prompt = buildSummaryPrompt(messages, userName, memories);
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
  const { summary, keywords } = await generateSummary({
    character,
    messages: list,
    userName,
    memories: buildMemorySummaryText(character),
  });
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

import { sendChatMessage } from './api';
import { createWorldEntry } from './cardParser';
import {
  appendSessionSummary,
  getSessionSummariesStatus,
  getSessionSummaryRevision,
  isSessionSummaryRevisionCurrent,
  setSessionSummarizedUpTo,
} from './storage';

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
  '- 只输出新增记忆，每行一条，以“- ”开头。无新增信息时不要输出记忆行，可在最后保留关键词行。',
  '',
  '关键词：',
  '- 在最后单独输出一行，以“关键词：”开头，后接顿号分隔的关键词。',
  '- 关键词要尽量多、尽量覆盖本段的重要信息与主要事件，包括出现的人物名、称呼、地点、物品、事件、约定、情绪与关系等。',
  '- 关键词用于日后检索这段记忆，请优先选择对话中真实出现、容易被再次提及的词或短语，每条 2 到 6 个字，覆盖尽可能全面。',
  '- 示例：关键词：小明、咖啡店、生日约定、表白、加班、猫、淋雨。',
].join('\n');

function isConversational(message) {
  return !!message
    && (message.role === 'user' || message.role === 'assistant')
    && !message.pending
    && String(message.text || '').trim().length > 0;
}

function getBoundaryStart(list, summarizedUpTo) {
  if (!summarizedUpTo) return 0;
  const index = list.findIndex(item => item.id === summarizedUpTo);
  return index >= 0 ? index + 1 : 0;
}

export function selectSummarizable(messages, summarizedUpTo, keepRecent = KEEP_RECENT) {
  const list = (Array.isArray(messages) ? messages : []).filter(isConversational);
  if (list.length === 0) return [];
  const start = getBoundaryStart(list, summarizedUpTo);
  const end = list.length - Math.max(0, keepRecent);
  if (end <= start) return [];
  return list.slice(start, end);
}

export function selectManualSummarizable(messages, summarizedUpTo) {
  const list = (Array.isArray(messages) ? messages : []).filter(isConversational);
  if (list.length === 0) return [];
  const start = getBoundaryStart(list, summarizedUpTo);
  const remaining = list.slice(start);
  return remaining.length > 0 ? remaining : list;
}

export function shouldSummarize({ session, messages, settings, force = false } = {}) {
  const list = (Array.isArray(messages) ? messages : []).filter(isConversational);
  const candidates = selectSummarizable(list, session && session.summarizedUpTo);
  if (force) return candidates.length > 0;
  if (!settings || settings.enabled !== true) return false;
  const threshold = Number(settings.threshold);
  const limit = Number.isFinite(threshold) && threshold > 0 ? threshold : DEFAULT_THRESHOLD;
  return candidates.length >= limit;
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

const KEYWORDS_LABEL = /^\s*(?:关键词|關鍵詞|keywords?)\s*[:：]\s*/i;

export function parseKeywordsLine(text) {
  const lines = String(text || '').split('\n');
  const hit = lines.find(line => KEYWORDS_LABEL.test(line));
  if (!hit) return [];
  const raw = hit.replace(KEYWORDS_LABEL, '');
  return raw
    .split(/[、,，;；|\/\s]+/)
    .map(item => item.replace(/^[-*•]\s*/, '').trim())
    .filter(Boolean);
}

export function parseMemoryLines(text) {
  return String(text || '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => !KEYWORDS_LABEL.test(line))
    .map(line => line.replace(/^[-*•]\s*/, '').trim())
    .filter(line => line && !/^（暂无已记录的记忆）$/.test(line));
}

export function parseSummaryResponse(text) {
  const lines = parseMemoryLines(text);
  const keywords = parseKeywordsLine(text);
  if (lines.length === 0) {
    return { summary: '', lines: [], keywords: [], skipped: true };
  }
  const summary = lines.map(line => `- ${line}`).join('\n');
  return {
    summary,
    lines,
    keywords: keywords.length ? keywords : [...FALLBACK_KEYWORDS],
    skipped: false,
  };
}

export async function generateSummary({
  character,
  messages,
  userName,
  memories,
  expectedConfigId = '',
  expectedConfigFingerprint = '',
}) {
  const prompt = buildSummaryPrompt(messages, userName, memories);
  const text = await sendChatMessage(prompt, {
    expectedConfigId,
    expectedConfigFingerprint,
  });
  return parseSummaryResponse(text);
}

export const MEMORY_SCOPE_THRESHOLD = 2;

export function countCharacterMemories(sessions, characterId) {
  const id = String(characterId || '');
  if (!id) return 0;
  return (Array.isArray(sessions) ? sessions : []).filter(session => (
    session
    && session.type !== 'group'
    && String(session.characterId || '') === id
    && String(session.preview || '').trim().length > 0
  )).length;
}

export function isSessionScopedMemory(sessions, characterId) {
  return countCharacterMemories(sessions, characterId) >= MEMORY_SCOPE_THRESHOLD;
}

function summaryIndex(comment) {
  const match = String(comment || '').match(/(\d+)\s*$/);
  return match ? Number(match[1]) : 0;
}

export function buildWorldSummaryText(character) {
  const entries = (Array.isArray(character && character.worldInfo) ? character.worldInfo : [])
    .filter(entry => entry
      && entry.enabled !== false
      && String(entry.comment || '').trim().startsWith(MEMORY_SUMMARY_PREFIX)
      && String(entry.content || '').trim())
    .sort((a, b) => summaryIndex(a.comment) - summaryIndex(b.comment));
  return entries.map(entry => String(entry.content).trim()).join('\n\n');
}

export function buildSessionSummaryText(sessionSummaries) {
  return (Array.isArray(sessionSummaries) ? sessionSummaries : [])
    .map(item => String((item && item.summary) || '').trim())
    .filter(Boolean)
    .join('\n\n');
}

export function buildMemorySummaryText(character, sessionSummaries, scoped = false) {
  if (scoped) return buildSessionSummaryText(sessionSummaries);
  return buildWorldSummaryText(character);
}

export async function applySummary({
  session,
  character,
  messages,
  updateCharacter,
   userName,
   scoped = false,
   expectedConfigId = '',
   expectedConfigFingerprint = '',
}) {
  const list = (Array.isArray(messages) ? messages : []).filter(isConversational);
  if (list.length === 0) {
    throw new Error('没有可总结的消息');
  }
  const summaryRevision = getSessionSummaryRevision(session.id);
  const summaryState = scoped
    ? await getSessionSummariesStatus(session.id)
    : { status: 'ok', summaries: [] };
  if (scoped && summaryState.status === 'corrupt') {
    throw new Error('记忆摘要读取失败，请稍后重试');
  }
  const existingSessionSummaries = summaryState.summaries || [];
  const memories = buildMemorySummaryText(character, existingSessionSummaries, scoped);
  const { summary, keywords, skipped } = await generateSummary({
    character,
     messages: list,
     userName,
     memories,
     expectedConfigId,
     expectedConfigFingerprint,
  });
  if (skipped || !summary.trim()) {
    return { entry: null, boundary: null, summary: '', keywords: [], scoped, skipped: true };
  }
  if (!isSessionSummaryRevisionCurrent(session.id, summaryRevision)) {
    throw new Error('会话摘要已重置');
  }
  const boundary = list[list.length - 1].id;

  if (scoped) {
    await appendSessionSummary(session.id, {
      summary,
      keywords,
      boundary,
      createdAt: Date.now(),
    }, summaryRevision);
    return { entry: null, boundary, summary, keywords, scoped: true, skipped: false };
  }

  const worldInfo = Array.isArray(character && character.worldInfo) ? character.worldInfo : [];
  const previousWorldInfo = worldInfo;
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
    order: 10,
  }, count);
  if (!isSessionSummaryRevisionCurrent(session.id, summaryRevision)) {
    throw new Error('会话摘要已重置');
  }
  await updateCharacter({ id: character.id, worldInfo: [...worldInfo, entry] });
  if (!isSessionSummaryRevisionCurrent(session.id, summaryRevision)) {
    await updateCharacter({ id: character.id, worldInfo: previousWorldInfo }).catch(() => {});
    throw new Error('会话摘要已重置');
  }
  try {
    await setSessionSummarizedUpTo(session.id, boundary, summaryRevision);
  } catch (error) {
    if (isSessionSummaryRevisionCurrent(session.id, summaryRevision)) {
      await updateCharacter({ id: character.id, worldInfo: previousWorldInfo }).catch(() => {});
    }
    throw error;
  }
  return { entry, boundary, summary, keywords, scoped: false, skipped: false };
}

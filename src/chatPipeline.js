import { buildWorldInfoText, collectActiveWorldInfo } from './lorebook';
import { applyRegexScripts, REGEX_PLACEMENT } from './regexEngine';

export const DEFAULT_SYSTEM_PROMPT = '你是 EasyChat2 的智能助手，回答简洁清晰。';

function applyForPrompt(text, scripts, placement, depth) {
  return applyRegexScripts(text, scripts, placement, { mode: 'prompt', depth });
}

function buildHistory(historyMessages, scripts) {
  const list = (Array.isArray(historyMessages) ? historyMessages : []).filter(
    item => item && (item.role === 'user' || item.role === 'assistant')
  );
  const total = list.length;
  return list.map((item, index) => {
    const isUser = item.role === 'user';
    const placement = isUser ? REGEX_PLACEMENT.USER_INPUT : REGEX_PLACEMENT.AI_OUTPUT;
    return {
      role: isUser ? 'user' : 'assistant',
      content: applyForPrompt(item.text, scripts, placement, total - index),
    };
  });
}

function insertDepthEntries(assembled, depthEntries) {
  if (!Array.isArray(depthEntries) || depthEntries.length === 0) return;
  const baseLength = assembled.length;
  const groups = new Map();
  for (const entry of depthEntries) {
    const depth = Math.max(1, Math.min(Number(entry.depth) || 0, baseLength - 1));
    const index = baseLength - depth;
    if (!groups.has(index)) groups.set(index, []);
    groups.get(index).push(entry);
  }
  const indexes = Array.from(groups.keys()).sort((a, b) => b - a);
  for (const index of indexes) {
    const items = groups.get(index).map(entry => ({
      role: entry.role || 'system',
      content: String(entry.content || ''),
    }));
    assembled.splice(index, 0, ...items);
  }
}

export function buildRequestMessages({ character, historyMessages, userText }) {
  const scripts = Array.isArray(character?.regexScripts) ? character.regexScripts : [];
  const history = buildHistory(historyMessages, scripts);
  const { before, after, depth } = collectActiveWorldInfo(
    character,
    historyMessages,
    userText
  );

  const base = String(character?.systemPrompt || '').trim() || DEFAULT_SYSTEM_PROMPT;
  const name = String(character?.name || '').trim();
  let systemContent = name ? `你的名字是${name}。${base}` : base;

  const beforeText = buildWorldInfoText(before);
  const afterText = buildWorldInfoText(after);
  if (beforeText) systemContent = `${beforeText}\n\n${systemContent}`;
  if (afterText) systemContent = `${systemContent}\n\n${afterText}`;

  const promptUserText = applyForPrompt(userText, scripts, REGEX_PLACEMENT.USER_INPUT, 0);

  const assembled = [
    { role: 'system', content: systemContent },
    ...history,
    { role: 'user', content: promptUserText },
  ];
  insertDepthEntries(assembled, depth);
  return assembled;
}

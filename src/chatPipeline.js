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

function insertDepthEntries(assembled, depthEntries, scripts, replaceUser) {
  if (!Array.isArray(depthEntries) || depthEntries.length === 0) return;
  const baseLength = assembled.length;
  const groups = new Map();
  for (const entry of depthEntries) {
    const depth = Math.min(Math.max(0, Math.trunc(Number(entry.depth)) || 0), baseLength);
    const index = baseLength - depth;
    if (!groups.has(index)) groups.set(index, []);
    groups.get(index).push(entry);
  }
  const indexes = Array.from(groups.keys()).sort((a, b) => b - a);
  for (const index of indexes) {
    const items = groups.get(index).map(entry => ({
      role: entry.role || 'system',
      content: applyForPrompt(
        replaceUser(String(entry.content || '')),
        scripts,
        REGEX_PLACEMENT.WORLD_INFO,
        0
      ),
    }));
    assembled.splice(index, 0, ...items);
  }
}

export function buildRequestMessages({ character, historyMessages, userText, userProfile, globalPresets }) {
  const scripts = Array.isArray(character?.regexScripts) ? character.regexScripts : [];
  const history = buildHistory(historyMessages, scripts);
  const { before, after, depth } = collectActiveWorldInfo(
    character,
    historyMessages,
    userText
  );

  const userName = String(userProfile?.userName || '').trim();
  const userPersona = String(userProfile?.persona || '').trim();
  const replaceUser = text => {
    if (!userName) return text;
    return text.replace(/\{\{user\}\}/g, userName);
  };

  const base = String(character?.systemPromptComposed || '').trim()
    || String(character?.systemPrompt || '').trim()
    || DEFAULT_SYSTEM_PROMPT;
  const name = String(character?.name || '').trim();
  let systemContent = name ? `你的名字是${name}。${base}` : base;
  systemContent = replaceUser(systemContent);
  if (userPersona) {
    systemContent = `${systemContent}\n\n[用户设定]\n${replaceUser(userPersona)}`;
  }

  const beforeText = applyForPrompt(
    buildWorldInfoText(before),
    scripts,
    REGEX_PLACEMENT.WORLD_INFO,
    0
  );
  const afterText = applyForPrompt(
    buildWorldInfoText(after),
    scripts,
    REGEX_PLACEMENT.WORLD_INFO,
    0
  );
  if (beforeText) systemContent = `${replaceUser(beforeText)}\n\n${systemContent}`;
  if (afterText) systemContent = `${systemContent}\n\n${replaceUser(afterText)}`;

  const presetText = (Array.isArray(globalPresets) ? globalPresets : [])
    .map(item => String(item || '').trim())
    .filter(Boolean)
    .join('\n');
  if (presetText) {
    const presetUserName = userName || '用户';
    systemContent = `${systemContent}\n\n[全局预设]\n${presetText.replace(/\{\{user\}\}/g, presetUserName)}`;
  }

  const promptUserText = applyForPrompt(userText, scripts, REGEX_PLACEMENT.USER_INPUT, 0);

  const assembled = [
    { role: 'system', content: systemContent },
    ...history,
    { role: 'user', content: promptUserText },
  ];
  insertDepthEntries(assembled, depth, scripts, replaceUser);
  return assembled;
}

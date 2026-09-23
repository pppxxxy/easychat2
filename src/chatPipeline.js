import { buildWorldInfoText, collectActiveWorldInfo } from './lorebook.js';
import { applyRegexScripts, REGEX_PLACEMENT } from './regexEngine.js';

export const DEFAULT_SYSTEM_PROMPT = '你是 EasyChat2 的智能助手，回答简洁清晰。';

// 常驻输出格式指令：不限是否开启“全局预设”，每次请求都会附带，
// 避免模型把整段回复挤成一坨连续文本。
export const DEFAULT_OUTPUT_FORMAT_PROMPT = [
  '请使用自然的分段与换行输出，不要把大段内容全挤成一段连续文本：',
  '1. 对白、动作与场景描写尽量各自成段；',
  '2. 一个段落只表达一个焦点，段落之间空一行；',
  '3. 列举、阶段、条目等结构化内容逐行书写，每条独占一行。',
].join('\n');

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

export function buildRequestMessages({ character, historyMessages, userText, userProfile, globalPresets, summaryText, pluginContext, images, quote, groupContext, memorySnippets }) {
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
  const exampleDialogue = String(character?.mesExample || '').trim();
  if (exampleDialogue) {
    systemContent = `${systemContent}\n\n[对话示例]\n${replaceUser(exampleDialogue)}`;
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

  const memoryText = String(memorySnippets || '').trim();
  if (memoryText) {
    systemContent = `${systemContent}\n\n${replaceUser(memoryText)}`;
  }

  const summaryContent = String(summaryText || '').trim();
  if (summaryContent) {
    systemContent = `${systemContent}\n\n[记忆摘要]\n${replaceUser(summaryContent)}`;
  }

  const groupContent = String(groupContext || '').trim();
  if (groupContent) {
    systemContent = `${systemContent}\n\n${replaceUser(groupContent)}`;
  }

  const pluginContent = String(pluginContext || '').trim();
  if (pluginContent) {
    systemContent = `${systemContent}\n\n${replaceUser(pluginContent)}`;
  }

  // 放在最后，作为贴近输出的格式约束
  systemContent = `${systemContent}\n\n[输出格式]\n${DEFAULT_OUTPUT_FORMAT_PROMPT}`;

  const promptUserText = applyForPrompt(userText, scripts, REGEX_PLACEMENT.USER_INPUT, 0);
  const quoteText = quote && String(quote.text || '').trim()
    ? `[引用${String(quote.name || '').trim() || '对方'}的消息] ${String(quote.text).trim()}\n\n${promptUserText}`
    : promptUserText;
  const imageList = Array.isArray(images) ? images.filter(Boolean) : [];
  const userContent = imageList.length > 0
    ? [
        { type: 'text', text: quoteText },
        ...imageList.map(url => ({ type: 'image_url', image_url: { url } })),
      ]
    : quoteText;

  const assembled = [
    { role: 'system', content: systemContent },
    ...history,
    { role: 'user', content: userContent },
  ];
  insertDepthEntries(assembled, depth, scripts, replaceUser);
  return assembled;
}

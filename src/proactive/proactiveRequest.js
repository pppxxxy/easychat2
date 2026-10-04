// 主动消息请求组装：在 JS 侧用与「正常对话」相同的管线生成完整消息数组，
// 保存时间槽时快照进原生配置；后台触发时原生直接发送这份消息，保证主动消息
// 与普通回复用同一套提示词（角色设定 / 用户设定 / 预设 / 世界书 / 记忆摘要 / 历史对话）。
//
// 与普通对话的差异（按用户要求）：
// - 不带正则脚本（只要纯文字）；
// - 追加一段「主动开话题」的特殊提示，说明这是角色主动给用户发消息；
// - 时间感知开启时附上当前时间。

import { buildRequestMessages } from '../prompt/chatPipeline.js';

// 世界书「格式模板」过滤：主动消息只发一句自然的话，不该被「每轮必须输出【时间】/
// 状态栏/课程表」这类输出格式规定带偏——否则模型会把模板示例值原样抄成正文。
// 判定为「格式规定」的条目在主动消息里整条剔除。
const FORMAT_DIRECTIVE_HINTS = [
  '必须输出', '必须附加', '必须包含', '强制输出', '稳定输出',
  '格式严格', '严格按', '格式固定', '末尾必须', '正文末尾',
  '模板', '状态栏', '数值状态', '输出规范', '输出格式',
];

export function isFormatDirectiveEntry(entry) {
  const content = String((entry && entry.content) || '');
  if (!content) return false;
  const hits = FORMAT_DIRECTIVE_HINTS.filter(hint => content.includes(hint));
  // 命中 2 个以上格式类措辞，或出现「【时间】…=…|…」这类模板骨架，判为格式规定。
  if (hits.length >= 2) return true;
  return /【[^】]{1,12}】[^。\n]{0,40}[=＝]/.test(content) && /[|｜]/.test(content);
}

// 返回剔除格式规定后的世界书数组（不改原数组）。
export function stripFormatDirectiveEntries(worldInfo) {
  return (Array.isArray(worldInfo) ? worldInfo : []).filter(entry => !isFormatDirectiveEntry(entry));
}

// 按消息类型生成「本轮任务」提示；问好类型交给「发送时刻」判断时段。
// 注意：requestJson 是保存槽时的快照，触发在数天后的任意时刻——
// 不能在保存时固化「早/中/晚」时段或具体时间戳（曾把保存时段烘进快照，
// 早上触发的问好却说"夜里的问好"）。时段判断改由原生在触发时注入真实时间。
export function buildProactiveTask({ messageType = 'DEFAULT', customPrompt = '' } = {}) {
  const type = String(messageType || 'DEFAULT').toUpperCase();
  if (type === 'CARE') {
    return '主动给一段时间没说话的用户发一条关心其心情与状态的消息：先体贴地询问对方此刻心情如何、累不累，语气温暖真诚。';
  }
  if (type === 'GREETING') {
    return '主动向用户发一条贴合发送时刻的问好消息：按系统提示中的当前时间判断此刻是早上、中午、晚上还是夜里，自然亲切，可以带一点当天的问候。';
  }
  if (type === 'CUSTOM') {
    const prompt = String(customPrompt || '').trim();
    return prompt || '主动给一段时间没说话的用户发一条简短、自然的问候消息。';
  }
  return '主动给一段时间没说话的用户发一条简短、自然的问候消息。';
}

// 特殊提示：明确告诉角色「这是你主动给用户发消息」，并给出本轮任务与字数约束。
export function buildProactiveExtraPrompt(options) {
  const task = buildProactiveTask(options);
  return [
    '现在是你可以主动给用户发消息的时刻。用户此刻并没有开口，这是你主动开启的话题。',
    task,
    '要求：只写这一条主动消息本身，不超过 80 字，自然口语。',
    '忽略任何「每轮必须输出/附加某格式」「状态栏」「时间戳」「课程表」之类的要求——这次不要输出那些结构，只要一句话。',
    '不要输出 JSON、不要解释、不要复述格式模板，直接输出消息正文。',
  ].join('\n');
}

// 历史对话快照上限：只取最近若干条，避免 requestJson 过大（AsyncStorage/SharedPreferences
// 与请求体都有体积压力）。
export const PROACTIVE_HISTORY_LIMIT = 20;

// 时间感知占位符：保存槽时不能写入真实时间（快照会在未来任意时刻触发），
// 原生在发送时把该占位符替换成触发时刻的「[当前时间] …」。
export const PROACTIVE_TIME_TOKEN = '{{proactive_now}}';

// 组装主动消息的完整请求消息数组。
// 传入的 character 会被去掉正则脚本（主动消息只要纯文字）。
export function buildProactiveRequestMessages({
  character,
  historyMessages = [],
  userProfile = null,
  globalPresets = [],
  summaryText = '',
  messageType = 'DEFAULT',
  customPrompt = '',
  timeAware = false,
} = {}) {
  const cleanCharacter = character && typeof character === 'object'
    ? {
      ...character,
      regexScripts: [],
      // 主动消息只发一句自然话：剔除「输出格式/状态栏/时间戳模板」类世界书，
      // 否则模型会把模板示例值当正文抄出来。
      worldInfo: stripFormatDirectiveEntries(character.worldInfo),
    }
    : character;
  // 只保留最近 PROACTIVE_HISTORY_LIMIT 条，且过滤占位/系统错误等非对话消息。
  const trimmedHistory = (Array.isArray(historyMessages) ? historyMessages : [])
    .filter(item => item && !item.pending && (item.role === 'user' || item.role === 'assistant'))
    .slice(-PROACTIVE_HISTORY_LIMIT);
  return buildRequestMessages({
    character: cleanCharacter,
    historyMessages: trimmedHistory,
    userText: '（请现在主动开口）',
    userProfile,
    globalPresets,
    summaryText,
    extraSystemPrompt: buildProactiveExtraPrompt({ messageType, customPrompt }),
    // 保存时不能固化真实时间：占位符由原生在触发时替换成触发时刻。
    currentTimeText: timeAware ? PROACTIVE_TIME_TOKEN : '',
  });
}

// 保存槽时从本地存储读取该角色/该目标会话的上下文，组装成可直接发送的消息数组 JSON。
// 目标会话为空（新建对话）时只用角色设定等静态上下文，不含历史。
// 存储依赖用动态 import 延迟加载：纯函数（上面的 build*）因此可在纯 Node 下独立测试，
// 不被 expo-file-system 等原生模块拖入。
export async function buildProactiveRequestJson({
  character,
  sessionTargetId = '',
  messageType = 'DEFAULT',
  customPrompt = '',
  timeAware = false,
} = {}) {
  const {
    getMessagesBySession,
    getSessionSummaries,
    getEnabledGlobalPresetPrompts,
    getUserProfile,
  } = await import('../storage.js');
  const { buildMemorySummaryText } = await import('../memory/memorySummary.js');

  let historyMessages = [];
  let summaryText = '';
  const targetId = String(sessionTargetId || '');
  if (targetId) {
    try {
      const [messages, summaries] = await Promise.all([
        getMessagesBySession(targetId),
        getSessionSummaries(targetId),
      ]);
      historyMessages = Array.isArray(messages) ? messages : [];
      summaryText = buildMemorySummaryText(character, summaries, false);
    } catch (error) {
      historyMessages = [];
      summaryText = '';
    }
  }
  let globalPresets = [];
  let userProfile = null;
  try {
    globalPresets = await getEnabledGlobalPresetPrompts();
  } catch (error) {
    globalPresets = [];
  }
  try {
    userProfile = await getUserProfile();
  } catch (error) {
    userProfile = null;
  }

  const messages = buildProactiveRequestMessages({
    character,
    historyMessages,
    userProfile,
    globalPresets,
    summaryText,
    messageType,
    customPrompt,
    timeAware,
  });
  try {
    return JSON.stringify(messages);
  } catch (error) {
    return '';
  }
}

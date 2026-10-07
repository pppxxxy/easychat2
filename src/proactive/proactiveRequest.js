// 主动消息请求组装：在 JS 侧用与「正常对话」相同的管线生成完整消息数组，
// 保存时间槽时快照进原生配置；后台触发时原生直接发送这份消息，保证主动消息
// 与普通回复用同一套提示词（角色设定 / 用户设定 / 预设 / 世界书 / 记忆摘要 / 历史对话）。
//
// 与普通对话的差异（按用户要求）：
// - 不带正则脚本（只要纯文字）；
// - 追加一段「主动开话题」的特殊提示，说明这是角色主动给用户发消息；
// - 时间感知开启时附上当前时间。

import { buildRequestMessages } from '../prompt/chatPipeline.js';
import { normalizeProtocol, normalizeProtocolUrl, toAnthropicRequest, toResponsesRequest } from '../apiProtocols.js';

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

// 主动消息的后台生成参数：短回复（≤80 字）且不需要工具/流式。
// anthropic 的 max_tokens 是必填项，三种协议统一由 JS 写进快照请求体。
export const PROACTIVE_MAX_TOKENS = 120;
export const PROACTIVE_TEMPERATURE = 0.9;

// 按协议把消息数组转成**完整请求体**（含 model 与生成参数）。
// 协议大脑在 apiProtocols：转换逻辑与聊天路径共用同一份实现，这里只补主动消息的
// 生成参数与形态差异（anthropic 的 system 提顶层、responses 的 instructions/input）。
export function buildProactiveRequestBody({ protocol, model, messages } = {}) {
  const p = normalizeProtocol(protocol);
  if (p === 'anthropic') {
    const { system, messages: turns } = toAnthropicRequest(messages);
    return {
      model,
      max_tokens: PROACTIVE_MAX_TOKENS,
      temperature: PROACTIVE_TEMPERATURE,
      ...(system ? { system } : {}),
      messages: turns,
    };
  }
  if (p === 'openai-responses') {
    const { instructions, input } = toResponsesRequest(messages);
    return {
      model,
      input,
      store: false,
      max_output_tokens: PROACTIVE_MAX_TOKENS,
      temperature: PROACTIVE_TEMPERATURE,
      ...(instructions ? { instructions } : {}),
    };
  }
  return {
    model,
    messages,
    max_tokens: PROACTIVE_MAX_TOKENS,
    temperature: PROACTIVE_TEMPERATURE,
  };
}

// 按协议计算后台请求端点（normalizeProtocolUrl 的主动消息口径薄包装）。
export function buildProactiveEndpoint(protocol, baseUrl) {
  return normalizeProtocolUrl(protocol, baseUrl);
}

// 按协议与用户配置计算鉴权头/额外头；apiKey 不在此出现（原生经加密存储持有）。
// 默认值与 apiProtocols.buildRequestHeaders 同口径。
export function buildProactiveAuthSettings({ protocol, config } = {}) {
  const p = normalizeProtocol(protocol);
  const source = config && typeof config === 'object' ? config : {};
  const defaultHeader = p === 'anthropic' ? 'x-api-key' : 'Authorization';
  const header = String(source.authHeader || defaultHeader) || defaultHeader;
  const scheme = source.authScheme === undefined || source.authScheme === null
    ? (p === 'anthropic' ? '' : 'Bearer ')
    : String(source.authScheme);
  const extraHeaders = p === 'anthropic'
    ? { 'anthropic-version': String(source.anthropicVersion || '2023-06-01') }
    : {};
  return { protocol: p, authHeader: header, authScheme: scheme, extraHeaders };
}

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
  scheduleText = '',
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
  // 作息规则是静态文本（不含时间戳），可安全快照；模型结合触发时的当前时间判断时段。
  const extraSystemPrompt = [
    buildProactiveExtraPrompt({ messageType, customPrompt }),
    String(scheduleText || '').trim(),
  ].filter(Boolean).join('\n\n');
  return buildRequestMessages({
    character: cleanCharacter,
    historyMessages: trimmedHistory,
    userText: '（请现在主动开口）',
    userProfile,
    globalPresets,
    summaryText,
    extraSystemPrompt,
    // 保存时不能固化真实时间：占位符由原生在触发时替换成触发时刻。
    currentTimeText: timeAware ? PROACTIVE_TIME_TOKEN : '',
  });
}

// 保存槽时从本地存储读取该角色/该目标会话的上下文，组装成**按协议可直接发送的完整请求体 JSON**。
// 目标会话为空（新建对话）时只用角色设定等静态上下文，不含历史。
// 存储依赖用动态 import 延迟加载：纯函数（上面的 build*）因此可在纯 Node 下独立测试，
// 不被 expo-file-system 等原生模块拖入。
export async function buildProactiveRequestJson({
  character,
  sessionTargetId = '',
  messageType = 'DEFAULT',
  customPrompt = '',
  timeAware = false,
  protocol = 'openai',
  model = '',
} = {}) {
  const [
    { getMessagesBySession, getSessionSummaries, getSessions },
    { getEnabledGlobalPresetPrompts },
    { getUserProfile },
  ] = await Promise.all([
    import('../storage/sessions.js'),
    import('../storage/globalPresets.js'),
    import('../storage/personas.js'),
  ]);
  const { buildMemorySummaryText, isBuiltinAssistant, isSessionScopedMemory } = await import('../memory/memorySummary.js');

  let historyMessages = [];
  let summaryText = '';
  const targetId = String(sessionTargetId || '');
  if (targetId) {
    try {
      const [messages, summaries, sessions] = await Promise.all([
        getMessagesBySession(targetId),
        getSessionSummaries(targetId),
        getSessions(),
      ]);
      historyMessages = Array.isArray(messages) ? messages : [];
      // 与聊天读侧同口径：多会话角色只带本会话摘要，单会话角色才兼容世界书记忆；
      // 内置助手按会话级，并把来源会话计入判定。
      const scoped = isBuiltinAssistant(character)
        || isSessionScopedMemory(sessions, character && character.id, undefined, targetId);
      summaryText = buildMemorySummaryText(character, summaries, scoped);
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

  // 角色作息：读取角色作息并生成静态规则文本；启用作息时即使全局 timeAware 关闭，
  // 也写入时间占位符（规则需要当前时间判断时段）。
  let scheduleText = '';
  let scheduleActive = false;
  try {
    const [{ getCharacterSchedule }, { buildSchedulePrompt, isScheduleActive }] = await Promise.all([
      import('../storage/schedule.js'),
      import('../chat/schedule.js'),
    ]);
    const schedule = character && character.id ? await getCharacterSchedule(character.id) : null;
    if (isScheduleActive(schedule)) {
      scheduleText = buildSchedulePrompt(schedule);
      scheduleActive = true;
    }
  } catch (error) {
    scheduleText = '';
    scheduleActive = false;
  }

  const messages = buildProactiveRequestMessages({
    character,
    historyMessages,
    userProfile,
    globalPresets,
    summaryText,
    messageType,
    customPrompt,
    timeAware: timeAware || scheduleActive,
    scheduleText,
  });
  try {
    // 快照升级为按协议组好的完整请求体（含 model/生成参数）；原生直接发送。
    // 时间占位符原样保留在体内，由原生在触发时刻整串替换。
    return JSON.stringify(buildProactiveRequestBody({ protocol, model, messages }));
  } catch (error) {
    return '';
  }
}

// 自动配图的「场景转写」纯函数层：先把一段对话转写成一句画面描述，再交给生图。
//
// 设计约束：
// - 只做纯文本处理，不发请求（模型调用在 ChatScreen），便于单测；
// - 目标是「角色说完这段话之后所处的状态」：地点、姿态、表情、动作，像一张定格画面，
//   而不是复述台词。例如用户送角色上火车、角色在火车上看着用户流泪 → 画面描述应是
//   「角色在火车上望着窗外/望着用户流泪」，而非对白本身。

// 配图位置：开头 / 中段（高潮·正中间）/ 结尾（默认）。
export const INLINE_IMAGE_POSITIONS = ['start', 'middle', 'end'];
export const DEFAULT_INLINE_IMAGE_POSITION = 'end';

const SCENE_PROMPT_MAX = 300;

function clean(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

export function normalizeImagePosition(value) {
  const key = String(value || '').trim();
  return INLINE_IMAGE_POSITIONS.includes(key) ? key : DEFAULT_INLINE_IMAGE_POSITION;
}

// 把回复正文按段落切分（空行优先，其次换行）；切不出多段时整体作为一段。
export function splitReplyParagraphs(text) {
  const source = clean(text);
  if (!source) return [];
  const byBlankLine = source.split(/\n\s*\n+/).map(item => item.trim()).filter(Boolean);
  if (byBlankLine.length > 1) return byBlankLine;
  const byLine = source.split(/\n+/).map(item => item.trim()).filter(Boolean);
  return byLine.length > 0 ? byLine : [source];
}

// 按位置取回复里的对应段落：start=首段、middle=正中段（高潮）、end=末段（默认）。
export function selectReplySegment(text, position = DEFAULT_INLINE_IMAGE_POSITION) {
  const paragraphs = splitReplyParagraphs(text);
  if (paragraphs.length === 0) return '';
  const pos = normalizeImagePosition(position);
  if (pos === 'start') return paragraphs[0];
  if (pos === 'middle') return paragraphs[Math.floor((paragraphs.length - 1) / 2)];
  return paragraphs[paragraphs.length - 1];
}

// 构造场景转写提示词：把「用户这一轮说了什么 + 角色回复的对应段落」交给模型，
// 要求输出一句生图用的画面描述。
export function buildScenePrompt({
  segment = '',
  userText = '',
  charName = '角色',
  userName = '用户',
  maxChars = SCENE_PROMPT_MAX,
} = {}) {
  const name = clean(charName) || '角色';
  const user = clean(userName) || '用户';
  const scene = clean(segment);
  const limit = Number.isFinite(Number(maxChars)) && Number(maxChars) > 0
    ? Math.trunc(Number(maxChars))
    : SCENE_PROMPT_MAX;
  const lines = [
    `你是画面描述助手。下面是一段发生在「${user}」和角色「${name}」之间的对话：`,
  ];
  if (clean(userText)) lines.push(`${user}：${clean(userText)}`);
  lines.push(`${name}：${scene}`);
  lines.push(
    '',
    `请用一句话描述「${name}」说完这段话之后此刻所处的画面状态，用于 AI 绘图。要求：`,
    `- 聚焦${name}所在的地点、姿态、表情与动作，像一张定格的画面。`,
    '- 只描述画面，不要复述台词、不要写对白、不要出现“他说/她说”这类叙述。',
    `- 中文，不超过 ${limit} 字，不要加引号、序号或任何前后缀。`
  );
  return lines.join('\n');
}

// 清洗模型输出：剥掉“画面：”“描述：”等前缀、引号与换行，压缩空白并按上限截断。
export function normalizeScenePrompt(text, maxChars = SCENE_PROMPT_MAX) {
  let value = clean(text);
  if (!value) return '';
  value = value.replace(/^(?:画面|场景|描述|画面描述|绘图提示词|prompt)\s*[:：]\s*/i, '');
  value = value.replace(/^[「『“"']+/, '').replace(/[」』”"']+$/, '');
  value = value.replace(/\s*\n+\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();
  const limit = Number.isFinite(Number(maxChars)) && Number(maxChars) > 0
    ? Math.trunc(Number(maxChars))
    : SCENE_PROMPT_MAX;
  if (value.length > limit) value = `${value.slice(0, Math.max(1, limit - 1)).trim()}…`;
  return value;
}

// ---------------------------------------------------------------------------
// 场景转写编排（从 ChatScreen 抽出，两端复用）
//
// 为什么抽出来：这段逻辑原本是 ChatScreen 里的一个 useCallback，靠页面内的 refs
// 取「角色名 / 用户名 / 消息列表」。桌面要实现自动配图就必须抄一遍——那正是本仓
// 反复避免的「重写判定」。改成参数注入后，两端调同一个函数。
//
// 纯编排：不读存储、不碰 React。模型调用由调用方注入（sendScene 缺省返回空 ⇒ 直接
// 用原文兜底），所以本函数在任何环境都可直接单测。
// 系统提示词走 i18n key 而不是硬编码字符串（仓库规则：模块级导出常量不得硬编码中文）。
// 语义上它不是界面文案，而是发给模型的指令；用同一个 i18n 层只是为了让两端拿到
// **同一句话**，避免手机与桌面各自改一个字导致画面风格漂移。
export const INLINE_SCENE_PROMPT_KEY = 'chat.inlineImage.sceneSystemPrompt';

export function findPreviousUserText(messages, messageId = '') {
  const list = Array.isArray(messages) ? messages : [];
  const target = String(messageId || '');
  const index = list.findIndex(item => String((item && item.id) || '') === target);
  const before = index >= 0 ? list.slice(0, index) : list;
  for (let cursor = before.length - 1; cursor >= 0; cursor -= 1) {
    const item = before[cursor];
    if (item && item.role === 'user' && clean(item.text)) return clean(item.text);
  }
  return '';
}

/**
 * 决定这张配图要画什么。
 *
 * @param {object} input
 * @param {string} input.replyText        角色这一轮的完整回复
 * @param {object} input.settings         inlineImage 设置（imagePosition / enhance / enhanceConfigId）
 * @param {Array}  [input.messages]       用于找「上一条用户消息」作为上下文
 * @param {string} [input.messageId]      本条助手消息 id（定位上下文切片）
 * @param {string} [input.charName]       角色名（提示词里用）
 * @param {string} [input.userName]       用户名
 * @param {Function} [input.sendScene]    async ({systemPrompt, prompt, signal}) => 模型原文
 * @param {object} [input.signal]         AbortSignal
 * @param {string} [input.emptyReplyText] 「空回复」占位文本（命中则退回原文）
 * @returns {Promise<string>} 画面描述；任何失败都退回「回复段落原文」
 */
export async function resolveInlineImageSceneText({
  replyText = '',
  settings = {},
  messages = [],
  messageId = '',
  charName = '',
  userName = '',
  sendScene = null,
  signal = null,
  emptyReplyText = '',
} = {}) {
  const segment = selectReplySegment(replyText, settings.imagePosition);
  // 智能增强关闭：不做模型转写，直接用回复段落原文（保持原样）。
  if (!segment || settings.enhance !== true) return segment;
  if (typeof sendScene !== 'function') return segment;
  try {
    const prompt = buildScenePrompt({
      segment,
      userText: findPreviousUserText(messages, messageId),
      charName: charName || '角色',
      userName: userName || '用户',
    });
    const raw = await sendScene({ prompt, signal });
    if (signal && signal.aborted) return segment;
    // 空响应返回的是占位文本，不是画面：直接用原文兜底。
    if (!raw || clean(raw) === clean(emptyReplyText)) return segment;
    const scene = normalizeScenePrompt(raw);
    return scene || segment;
  } catch (error) {
    // 场景转写是增值步骤：失败就用原文兜底，不打断配图。
    return segment;
  }
}

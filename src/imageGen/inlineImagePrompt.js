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

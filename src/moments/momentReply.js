// 动态评论的“角色回复”：把动态来源的那段记忆拼进提示词，并清洗模型输出。
//
// 设计约束：
// - 动态下的评论交流是一次“不进记忆的对话”：这里只负责构造提示词，绝不写回会话消息或记忆；
// - 模块保持零依赖（不 import storage/api），便于单测与在纯 Node 环境下运行。

export const MOMENT_REPLY_MAX_CHARS = 200;
export const FALLBACK_MESSAGE_COUNT = 8;

function clean(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function limited(value, fallback, max) {
  const number = Math.trunc(Number(value));
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(number, max);
}

// 记忆正文：优先取该会话的记忆摘要；没有摘要时退化成会话最近几条消息。
export function buildMomentMemoryText({
  summaries = [],
  messages = [],
  charName = '角色',
  userName = '用户',
  maxMessages = FALLBACK_MESSAGE_COUNT,
} = {}) {
  const blocks = (Array.isArray(summaries) ? summaries : [])
    .map(item => clean(item && item.summary))
    .filter(Boolean);
  if (blocks.length > 0) return blocks.join('\n\n');

  const list = (Array.isArray(messages) ? messages : [])
    .filter(item => item
      && (item.role === 'user' || item.role === 'assistant')
      && clean(item.text));
  if (list.length === 0) return '';

  const limit = limited(maxMessages, FALLBACK_MESSAGE_COUNT, 40);
  const nameForUser = clean(userName) || '用户';
  const nameForChar = clean(charName) || '角色';
  return list
    .slice(-limit)
    .map(item => `${item.role === 'user' ? nameForUser : nameForChar}：${clean(item.text)}`)
    .join('\n');
}

export function buildMomentThread(comments, { charName = '角色', userName = '用户' } = {}) {
  const nameForUser = clean(userName) || '用户';
  const nameForChar = clean(charName) || '角色';
  return (Array.isArray(comments) ? comments : [])
    .map(item => {
      const text = clean(item && item.text);
      if (!text) return '';
      const speaker = item && item.by === 'user'
        ? nameForUser
        : (clean(item && item.name) || nameForChar);
      return `${speaker}：${text}`;
    })
    .filter(Boolean)
    .join('\n');
}

export function buildMomentReplyPrompt({
  moment,
  comments = [],
  memoryText = '',
  charName = '角色',
  userName = '用户',
} = {}) {
  const speaker = clean(charName) || clean(moment && moment.characterName) || '角色';
  const lines = [
    '你刚刚在自己的社交动态里发了一条动态：',
    `「${clean(moment && moment.text)}」`,
  ];

  const memory = clean(memoryText);
  if (memory) {
    lines.push('', '这条动态与你们之前的一段对话有关，你对那段经历的记忆是：', memory);
  }

  const thread = buildMomentThread(comments, { charName: speaker, userName });
  if (thread) {
    lines.push('', '动态下的评论：', thread);
  }

  lines.push(
    '',
    `请以${speaker}的身份，回复最新那条评论。要求：`,
    '- 只回一条，40 字以内，口语化，就像在动态下面回评论。',
    '- 不要写动作描写、旁白、括号补充或思考过程，也不要加引号或署名。',
    '- 语气符合你与对方的关系；记忆里相关的事可以自然带出来，但不要整段复述。',
    '- 不要提到“记忆”“摘要”“系统”这类词。'
  );
  return lines.join('\n');
}

// 模型偶尔会带上引号、署名或换行，这里统一收干净。
export function normalizeMomentReply(text, maxLength = MOMENT_REPLY_MAX_CHARS) {
  let value = clean(text);
  if (!value) return '';
  value = value.replace(/^(?:回复|评论)\s*[:：]\s*/, '');
  const wrapped = value.match(/^[（(]([^（）()]*)[）)]$/);
  if (wrapped) value = clean(wrapped[1]);
  value = value.replace(/^[「『“"']+/, '').replace(/[」』”"']+$/, '');
  value = value.replace(/\s*\n+\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();
  const limit = limited(maxLength, MOMENT_REPLY_MAX_CHARS, 2000);
  if (value.length > limit) {
    value = `${value.slice(0, Math.max(1, limit - 1)).trim()}…`;
  }
  return value;
}

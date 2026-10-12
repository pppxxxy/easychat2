// 动态评论的“角色回复”：把动态来源的那段记忆拼进提示词，并清洗模型输出。
//
// 设计约束：
// - 动态下的评论交流是一次“不进记忆的对话”：这里只负责构造提示词，绝不写回会话消息或记忆；
// - 模块只依赖纯文本处理工具，便于单测与在纯 Node 环境下运行。

import { messageCopyText } from '../chat/plainText.js';

const MOMENT_REPLY_MAX_CHARS = 200;
const FALLBACK_MESSAGE_COUNT = 8;
// 提示词输入上限：避免几十条记忆/一长串评论把请求撑爆。
const MAX_MEMORY_CHARS = 4000;
const MAX_THREAD_CHARS = 2000;

function clean(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function capped(text, max) {
  const value = String(text || '');
  return value.length > max ? value.slice(0, max) : value;
}

function tailCapped(text, max) {
  const value = String(text || '');
  return value.length > max ? value.slice(value.length - max) : value;
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
  if (blocks.length > 0) return capped(blocks.join('\n\n'), MAX_MEMORY_CHARS);

  const list = (Array.isArray(messages) ? messages : [])
    .filter(item => item
      && (item.role === 'user' || item.role === 'assistant')
      && clean(messageCopyText(item.text)));
  if (list.length === 0) return '';

  const limit = limited(maxMessages, FALLBACK_MESSAGE_COUNT, 40);
  const nameForUser = clean(userName) || '用户';
  const nameForChar = clean(charName) || '角色';
  return capped(
    list
      .slice(-limit)
      .map(item => `${item.role === 'user' ? nameForUser : nameForChar}：${clean(messageCopyText(item.text))}`)
      .join('\n'),
    MAX_MEMORY_CHARS
  );
}

export function buildMomentThread(comments, { charName = '角色', userName = '用户' } = {}) {
  const nameForUser = clean(userName) || '用户';
  const nameForChar = clean(charName) || '角色';
  return tailCapped(
    (Array.isArray(comments) ? comments : [])
      .map(item => {
        const text = clean(item && item.text);
        if (!text) return '';
        const speaker = item && item.by === 'user'
          ? nameForUser
          : (clean(item && item.name) || nameForChar);
        return `${speaker}：${text}`;
      })
      .filter(Boolean)
      .join('\n'),
    MAX_THREAD_CHARS
  );
}

// 用户发的动态下，角色写评论用的提示词。
//
// 与 buildMomentReplyPrompt 的区别：那条是「角色自己的动态 + 有人评论了，去回复」，
// 这条是「用户发了动态，角色来评论」。两者混用会让角色把用户的动态当成自己发的——
// 那是事实错误，不只是措辞问题。分流口径照 z 分支 52f82de 的同名实现；
// 本分支还没有「评论挂靠」（commentThread）能力，所以不带「回复<名字>：」前缀的引导，
// 免得模型写出的前缀被原样存进评论正文。
export function buildMomentCommentPrompt({
  moment,
  comments = [],
  memoryText = '',
  charName = '角色',
  userName = '用户',
} = {}) {
  const speaker = clean(charName) || '角色';
  const poster = clean(userName) || '用户';
  const lines = [
    `你是${speaker}，你正在刷社交动态。`,
    `${poster}发了一条动态：`,
    `「${clean(moment && moment.text)}」`,
  ];

  // 与 buildMomentReplyPrompt 同一口径：调用方给的记忆必须在这里设上限（见文件头注释）。
  const memory = capped(clean(memoryText), MAX_MEMORY_CHARS);
  if (memory) {
    lines.push('', '你和发动态的人之前聊过这些（供参考）：', memory);
  }

  const thread = buildMomentThread(comments, { charName: speaker, userName: poster });
  if (thread) {
    lines.push('', '这条动态下已有的评论：', thread);
  }

  lines.push(
    '',
    `请以${speaker}的身份，在这条动态下写一条评论。要求：`,
    `- 重点是回应用户${poster}发的这条动态：说你自己想说的话（关心、调侃、附和、吐槽都可以）。`,
    '- 上面已有的评论只作参考，可以顺着聊，但不要只复述别人的话。',
    '- 只写一条，40 字以内，口语化，就像在动态下面评论。',
    '- 不要写动作描写、旁白、括号补充或思考过程，也不要加引号或署名。',
    '- 不要提到“记忆”“摘要”“系统”这类词。'
  );
  return lines.join('\n');
}

export function buildMomentReplyPrompt(options = {}) {
  const {
    moment,
    comments = [],
    memoryText = '',
    charName = '角色',
    userName = '用户',
  } = options;
  // 用户发的动态：角色是被叫来评论的人，不是发帖人。谁调用都先在这里分流，
  // 否则提示词会说「你刚刚在自己的社交动态里发了一条动态：<用户正文>」。
  if (clean(moment && moment.authorType) === 'user') {
    return buildMomentCommentPrompt(options);
  }
  const speaker = clean(charName) || clean(moment && moment.characterName) || '角色';
  const lines = [
    '你刚刚在自己的社交动态里发了一条动态：',
    `「${clean(moment && moment.text)}」`,
  ];

  // 上限同 buildMomentMemoryText 的退化路径（:47）：调用方传进来的记忆同样要截断，
  // 否则长期角色的 worldInfo「记忆总结」会全量进提示词（成本/413/淹没指令）。
  // 这里不引 memorySummary.js 的 planMemoryBudget：那会把 network/api.js、storage、
  // i18n 一并拉进这个自述「只依赖纯文本处理工具」的模块，也会拖慢纯 Node 单测。
  const memory = capped(clean(memoryText), MAX_MEMORY_CHARS);
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

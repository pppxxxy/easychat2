// 「从对话生成角色卡」：把用户选中的对话片段转成转写文本，再组装提炼提示词。
//
// 与「从零制卡」的区别在素材来源：那条路走问答（state.js 的 FORGE_QUESTIONS），
// 这条路直接把真实对话当证据，让模型提炼「这个角色在这段对话里展现出的性格、
// 口癖、对用户的态度」。因此提示词的核心约束是**忠实于对话**——对话里没有依据
// 的设定不许编，避免生成一个和刚才聊天完全不是同一个人的角色。
//
// 纯逻辑，零依赖，Node 可直测；发请求在 UI 层（复用 sendChatMessage）。

import { clean } from './shared.js';
import { buildCardOutputRules } from './prompts.js';

// 转写文本总预算：制卡请求还要带字段规则与输出格式，整体必须留出余量，
// 6000 字左右既能覆盖一段有代表性的对话，又不会把 maxTokens 挤到截断。
export const CONVERSATION_TRANSCRIPT_MAX_CHARS = 6000;

// 单条消息上限：一段对话里常有个别超长消息（粘贴的长文、大段独白），
// 不单独设闸的话它一条就能吃光整个预算，把其余对话全挤掉。
export const CONVERSATION_MESSAGE_MAX_CHARS = 600;

function clipText(text, maxChars) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  const limit = Number.isFinite(maxChars) && maxChars > 0
    ? Math.trunc(maxChars)
    : CONVERSATION_MESSAGE_MAX_CHARS;
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

// 把选中的消息转成「说话人：内容」逐行文本。
//
// 超预算时保留**最近**的消息并从最早处丢弃：角色当前的状态最能代表它，而且
// 用户多选时通常更在意后半段。丢弃条数如实返回，由提示词与界面告知用户，
// 不做「静默截断」——那会让人以为整段对话都被参考了。
export function formatConversationTranscript(messages, options = {}) {
  const userName = String(options.userName || '').trim() || '用户';
  const characterName = String(options.characterName || '').trim() || '角色';
  const maxChars = Number.isFinite(options.maxChars) && options.maxChars > 0
    ? Math.trunc(options.maxChars)
    : CONVERSATION_TRANSCRIPT_MAX_CHARS;
  const messageMaxChars = Number.isFinite(options.messageMaxChars) && options.messageMaxChars > 0
    ? Math.trunc(options.messageMaxChars)
    : CONVERSATION_MESSAGE_MAX_CHARS;

  const rows = (Array.isArray(messages) ? messages : [])
    .filter(message => message && (message.role === 'user' || message.role === 'assistant'))
    .map(message => {
      const speaker = message.role === 'user'
        ? userName
        : (String(message.speakerName || '').trim() || characterName);
      const text = clipText(message.text, messageMaxChars);
      return text ? `${speaker}：${text}` : '';
    })
    .filter(Boolean);

  const kept = [];
  let total = 0;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    const extra = kept.length === 0 ? row.length : row.length + 1;
    if (total + extra > maxChars) break;
    kept.unshift(row);
    total += extra;
  }

  return {
    text: kept.join('\n'),
    kept: kept.length,
    dropped: rows.length - kept.length,
    total: rows.length,
  };
}

// 提炼提示词。中文是发给模型的指令，不进 i18n 词条表（同 forge/prompts.js 的约定）。
export function buildConversationCardPrompt({
  transcript = '',
  characterName = '',
  userName = '',
  hint = '',
  dropped = 0,
} = {}) {
  const name = String(characterName || '').trim() || '角色';
  const user = String(userName || '').trim() || '用户';
  const body = String(transcript || '').trim();
  return [
    `你是角色卡（SillyTavern 风格）撰写助手。下面是一段真实发生过的对话记录，请从中提炼出「${name}」这个角色，写出一张完整的角色卡。`,
    '',
    `对话记录（${user} 与 ${name}）：`,
    body || '（没有可用的对话内容）',
    '',
    dropped > 0
      ? `注意：因长度限制，最早的 ${dropped} 条消息已被省略，请以下面保留的部分为准。`
      : '',
    hint ? `用户的补充要求：${clean(hint, 400)}` : '',
    '',
    '提炼要求：',
    `- 角色卡必须忠实于对话中真实展现的东西，不要凭空添加对话里没有依据的设定。`,
    `- personality 重点写：这段对话里展现出的性格、说话方式与口癖（常用语气词、称呼用户的方式、句式习惯、标点习惯）。`,
    `- scenario 写角色与用户当前的关系与处境（从对话里读出来的，例如关系亲疏、共同经历、正在做的事）。`,
    `- description 写外貌与身份背景：对话里没写到的部分可以合理补全，但不得与对话内容矛盾。`,
    `- firstMes 要延续这段对话里角色的语气与说话习惯，第一人称，1-3 句，不要替 ${user} 说话。`,
    `- mesExample 写 1-2 组示例，格式为「{{user}}：…」与「${name}：…」逐行交替。`,
    `- 如果对话里角色的名字不明确，可以自行起一个贴合它说话风格的名字，并在 creatorNotes 里说明这是从对话提炼的。`,
    `- creatorNotes 注明这张卡是从对话记录提炼而来，便于用户日后辨认。`,
    ...buildCardOutputRules(),
    '- 全部使用中文。',
  ].filter(Boolean).join('\n');
}

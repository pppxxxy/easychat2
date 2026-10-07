import { buildRequestMessages } from '../../prompt/chatPipeline.js';
import { getMessagePromptText } from '../chatMedia.js';
import { MEMBER_RECENT_LINES, GROUP_RECENT_LINES } from './constants.js';
import { staticProfileOf } from './profile.js';
import { speakerLabel, buildGroupMediaPrompt } from './mediaPrompt.js';

export function buildGroupHistory(messages) {
  return (Array.isArray(messages) ? messages : []).map(item => {
    if (item && item.role === 'assistant' && item.speakerName) {
      return { ...item, text: `${item.speakerName}：${getMessagePromptText(item)}` };
    }
    if (item && item.image) return { ...item, text: getMessagePromptText(item) };
    return item;
  });
}

function recentLinesFor(character, historyMessages, limit) {
  const list = Array.isArray(historyMessages) ? historyMessages : [];
  const lines = [];
  for (let index = list.length - 1; index >= 0 && lines.length < limit; index -= 1) {
    const item = list[index];
    if (!item || item.role !== 'assistant') continue;
    if (item.speakerId !== character.id && item.speakerName !== character.name) continue;
    const text = String(item.text || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (text) lines.push(text);
  }
  return lines.reverse();
}

export function buildGroupContext({ speaker, characters, historyMessages, profiles }) {
  const list = (Array.isArray(characters) ? characters : []).filter(Boolean);
  if (list.length === 0) return '';
  const cache = profiles && typeof profiles === 'object' ? profiles : {};
  const selfId = String(speaker?.id || '');
  const memberLines = list.map(character => {
    const id = String(character.id || '');
    const name = String(character.name || '').trim() || '角色';
    const profile = String(cache[id] || '').trim() || staticProfileOf(character)
      || `群聊成员之一，称为「${name}」。`;
    const lines = [`- ${name}${id === selfId ? '（你自己）' : ''}：${profile}`];
    const recent = recentLinesFor(character, historyMessages, MEMBER_RECENT_LINES);
    if (recent.length > 0) {
      lines.push(`  最近发言：${recent.join(' / ')}`);
    }
    return lines.join('\n');
  });

  const otherNames = list
    .filter(character => String(character.id || '') !== selfId)
    .map(character => String(character.name || '').trim())
    .filter(Boolean);

  const header = [
    '这是一个多人群聊，你正在与其他角色一起与用户对话。',
    '在场成员：',
    memberLines.join('\n'),
    otherNames.length > 0
      ? `除你（${String(speaker?.name || '').trim() || '你'}）以外的 ${otherNames.join('、')} 也会发言，你只代表你自己，只需回应属于你的部分。`
      : '你是本群唯一的角色，只代表你自己。',
  ].join('\n');

  const recent = (Array.isArray(historyMessages) ? historyMessages : [])
    .filter(item => item && (item.role === 'user' || item.role === 'assistant'))
    .slice(-GROUP_RECENT_LINES)
    .map(item => {
      const label = speakerLabel(list, item);
       const text = buildGroupMediaPrompt(item, list).replace(/\s+/g, ' ').trim().slice(0, 120);
      return text ? `${label}：${text}` : '';
    })
    .filter(Boolean);

  const sections = [`[群聊情境]\n${header}`];
  if (recent.length > 0) {
    sections.push(`最近对话：\n${recent.join('\n')}`);
  }
  return sections.join('\n\n');
}

export function buildGroupRequest({
  speaker,
  characters,
  historyMessages,
  userText,
  userProfile,
  globalPresets,
  quote,
  summaryText,
  pluginContext,
  profiles,
  imageMessages,
}) {
  const groupContext = buildGroupContext({
    speaker,
    characters,
    historyMessages,
    profiles,
  });
  return buildRequestMessages({
    character: speaker,
    historyMessages: buildGroupHistory(historyMessages),
    userText,
    userProfile,
    globalPresets,
    quote,
    summaryText,
    pluginContext,
    groupContext,
    imageMessages,
  });
}

import { isCanceledError, isConfigChangedError, sendChatMessage } from '../../network/api.js';
import { MAX_SPEAKERS } from './constants.js';
import { nameOf, extractJson } from './textUtils.js';

function fallbackSpeaker({ characters, history, userText, mentions }) {
  const list = Array.isArray(characters) ? characters : [];
  if (list.length === 0) return [];
  if (mentions.length > 0) return [mentions[0]];
  const mentioned = list.find(character =>
    String(userText || '').includes(String(character.name || ''))
  );
  if (mentioned) return [mentioned.id];
  const recent = [...(history || [])].reverse().find(item => item && item.speakerId);
  if (recent) {
    const index = list.findIndex(character => character.id === recent.speakerId);
    if (index >= 0) return [list[(index + 1) % list.length].id];
  }
  return [list[0].id];
}

function buildSchedulerPrompt(characters, history, userText, mentions) {
  const roster = characters
    .map(character => `- ${character.name}: ${String(character.description || character.personality || '').slice(0, 80)}`)
    .join('\n');
  const recent = (Array.isArray(history) ? history : [])
    .slice(-8)
    .map(item => {
      const speaker = item.role === 'user'
        ? '用户'
        : (item.speakerName || nameOf(characters, item.speakerId) || '角色');
      return `${speaker}：${String(item.text || '').slice(0, 120)}`;
    })
    .join('\n');
  const mentionNames = mentions
    .map(id => nameOf(characters, id))
    .filter(Boolean)
    .join('、');
  return [
    {
      role: 'system',
      content: '你是群聊调度器。根据成员设定、最近对话与用户的新消息，选择 1 到 3 个最适合回应的角色。'
        + '只输出 JSON，格式为 {"speakers": ["角色名1", "角色名2"]}，不要解释。',
    },
    {
      role: 'user',
      content: [
        `成员：\n${roster}`,
        mentionNames ? `用户点名：${mentionNames}` : '',
        recent ? `最近对话：\n${recent}` : '',
        `用户新消息：${String(userText || '')}`,
      ].filter(Boolean).join('\n\n'),
    },
  ];
}

export function parseSpeakerResponse(text, characters) {
  const parsed = extractJson(text);
  if (!parsed || typeof parsed !== 'object') return [];
  const names = Array.isArray(parsed.speakers) ? parsed.speakers : [];
  const list = Array.isArray(characters) ? characters : [];
  const ids = [];
  names.forEach(raw => {
    const name = String(raw || '').trim();
    if (!name) return;
    const found = list.find(character =>
      String(character.name || '').trim() === name
      || String(character.name || '').trim().includes(name)
    );
    if (found && !ids.includes(found.id)) ids.push(found.id);
  });
  return ids;
}

export async function selectSpeakers({ characters, history, userText, mentions = [], everyone = false, expectedConfigId = '', expectedConfigFingerprint = '', signal = null }) {
  const list = Array.isArray(characters) ? characters : [];
  if (list.length === 0) return [];
  if (everyone) return list.map(character => character.id).filter(Boolean);
  if (mentions.length >= MAX_SPEAKERS) return mentions.slice(0, MAX_SPEAKERS);
  let picked = [];
  try {
     const prompt = buildSchedulerPrompt(list, history, userText, mentions);
     const text = await sendChatMessage(prompt, {
       expectedConfigId,
       expectedConfigFingerprint,
       signal,
     });
    picked = parseSpeakerResponse(text, list);
  } catch (error) {
    if (isConfigChangedError(error) || isCanceledError(error)) throw error;
    picked = [];
  }
  if (picked.length === 0) {
    picked = fallbackSpeaker({ characters: list, history, userText, mentions });
  }
  const merged = [];
  [...mentions, ...picked].forEach(id => {
    if (id && !merged.includes(id) && list.some(character => character.id === id)) {
      merged.push(id);
    }
  });
  return merged.slice(0, MAX_SPEAKERS);
}

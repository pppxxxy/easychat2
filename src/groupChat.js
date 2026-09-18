import { sendChatMessage } from './api';
import { buildRequestMessages } from './chatPipeline';

export const MAX_SPEAKERS = 3;

export function parseMentions(text, characters) {
  const source = String(text || '');
  const list = Array.isArray(characters) ? characters : [];
  const ids = [];
  list.forEach(character => {
    const name = String(character.name || '').trim();
    if (!name) return;
    if (source.includes(`@${name}`) && !ids.includes(character.id)) {
      ids.push(character.id);
    }
  });
  return ids;
}

function nameOf(characters, id) {
  const found = (Array.isArray(characters) ? characters : []).find(item => item.id === id);
  return found ? String(found.name || '') : '';
}

function extractJson(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : raw;
  try {
    return JSON.parse(candidate);
  } catch (error) {}
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch (error) {}
  }
  return null;
}

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

export async function selectSpeakers({ characters, history, userText, mentions = [] }) {
  const list = Array.isArray(characters) ? characters : [];
  if (list.length === 0) return [];
  if (mentions.length >= MAX_SPEAKERS) return mentions.slice(0, MAX_SPEAKERS);
  let picked = [];
  try {
    const prompt = buildSchedulerPrompt(list, history, userText, mentions);
    const text = await sendChatMessage(prompt);
    picked = parseSpeakerResponse(text, list);
  } catch (error) {
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

export async function generateOpening({ characters, userProfile, globalPresets }) {
  const list = Array.isArray(characters) ? characters : [];
  if (list.length === 0) return null;
  const roster = list
    .map(character => `- ${character.name}: ${String(character.description || character.personality || '').slice(0, 100)}`)
    .join('\n');
  const prompt = [
    {
      role: 'system',
      content: '你是群聊导演。根据成员设定写一段简短的群聊开场，交代场景与在场角色（2-3 句）。'
        + '只输出 JSON，格式为 {"opening": "开场白", "speaker": "首先发言的角色名"}，不要解释。',
    },
    { role: 'user', content: `成员：\n${roster}` },
  ];
  let parsed = null;
  try {
    const text = await sendChatMessage(prompt);
    parsed = extractJson(text);
  } catch (error) {
    parsed = null;
  }
  if (!parsed) {
    const first = list[0];
    return {
      opening: `${list.map(character => character.name).join('、')} 已经就位，对话开始了。`,
      speakerId: first.id,
      speakerName: String(first.name || ''),
    };
  }
  const speakerName = String(parsed.speaker || '').trim();
  const speaker = list.find(character =>
    String(character.name || '').trim() === speakerName
  ) || list[0];
  return {
    opening: String(parsed.opening || '').trim()
      || `${list.map(character => character.name).join('、')} 已经就位。`,
    speakerId: speaker.id,
    speakerName: String(speaker.name || ''),
  };
}

export function buildGroupHistory(messages) {
  return (Array.isArray(messages) ? messages : []).map(item => {
    if (item && item.role === 'assistant' && item.speakerName) {
      return { ...item, text: `${item.speakerName}：${item.text}` };
    }
    return item;
  });
}

export function buildGroupRequest({
  speaker,
  characters,
  historyMessages,
  userText,
  userProfile,
  globalPresets,
}) {
  return buildRequestMessages({
    character: speaker,
    historyMessages: buildGroupHistory(historyMessages),
    userText,
    userProfile,
    globalPresets,
  });
}

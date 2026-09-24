import { isCanceledError, isConfigChangedError, sendChatMessage } from './api';
import { buildRequestMessages } from './chatPipeline';
import { getMessagePromptText } from './chatMedia.js';
import { applyRegexScripts, REGEX_PLACEMENT } from './regexEngine.js';

export const MAX_SPEAKERS = 3;
export const PROFILE_MIN_CHARS = 30;
export const MEMBER_RECENT_LINES = 3;
export const GROUP_RECENT_LINES = 8;

function staticProfileOf(character) {
  const description = String(character?.description || '').trim();
  const personality = String(character?.personality || '').trim();
  return [description, personality].filter(Boolean).join(' ').trim();
}

export function needsProfile(character) {
  return staticProfileOf(character).length < PROFILE_MIN_CHARS;
}

function buildProfilePrompt(character) {
  const fields = [
    ['名称', character?.name],
    ['简介', character?.description],
    ['性格', character?.personality],
    ['场景', character?.scenario],
    ['对话示例', character?.mesExample],
    ['开场白', Array.isArray(character?.alternateGreetings)
      ? character.alternateGreetings.join(' / ')
      : ''],
  ]
    .map(([label, value]) => {
      const text = String(value || '').trim();
      return text ? `${label}：${text}` : '';
    })
    .filter(Boolean)
    .join('\n');
  return [
    {
      role: 'system',
      content: '你根据角色卡信息，用一到两句第三人称中文简介概括这个角色的人设，'
        + '供群聊中其他角色了解它。只输出简介正文，不要引号、不要解释、不要分段。',
    },
    { role: 'user', content: fields || `名称：${String(character?.name || '角色')}` },
  ];
}

export async function generateMemberProfile(character, expectedConfigId = '', signal = null) {
  if (!character) return null;
  try {
    const text = await sendChatMessage(buildProfilePrompt(character), { expectedConfigId, signal });
    const profile = String(text || '').replace(/\s+/g, ' ').trim();
    return profile || null;
  } catch (error) {
    if (isConfigChangedError(error) || isCanceledError(error)) throw error;
    return null;
  }
}

export async function ensureMemberProfiles({ characters, profiles, expectedConfigId = '', signal = null }) {
  const list = Array.isArray(characters) ? characters : [];
  const current = profiles && typeof profiles === 'object' ? profiles : {};
  const next = { ...current };
  for (const character of list) {
    if (signal && signal.aborted) {
      const error = new Error('已停止生成。');
      error.name = 'AbortError';
      error.canceled = true;
      throw error;
    }
    if (!character || !character.id) continue;
    if (next[character.id]) continue;
    if (!needsProfile(character)) continue;
    const profile = await generateMemberProfile(character, expectedConfigId, signal);
    if (profile) next[character.id] = profile;
  }
  return next;
}

export const EVERYONE_MENTION = '全体';
export const MENTION_PREFIX = '@';

export function hasEveryoneMention(text) {
  return String(text || '').includes(`${MENTION_PREFIX}${EVERYONE_MENTION}`);
}

export function parseMentions(text, characters) {
  const source = String(text || '');
  const list = Array.isArray(characters) ? characters : [];
  if (hasEveryoneMention(source)) {
    return list.map(character => character.id).filter(Boolean);
  }
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

export async function selectSpeakers({ characters, history, userText, mentions = [], everyone = false, expectedConfigId = '', signal = null }) {
  const list = Array.isArray(characters) ? characters : [];
  if (list.length === 0) return [];
  if (everyone) return list.map(character => character.id).filter(Boolean);
  if (mentions.length >= MAX_SPEAKERS) return mentions.slice(0, MAX_SPEAKERS);
  let picked = [];
  try {
    const prompt = buildSchedulerPrompt(list, history, userText, mentions);
    const text = await sendChatMessage(prompt, { expectedConfigId, signal });
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

export async function generateOpening({ characters, userProfile, globalPresets, expectedConfigId = '', signal = null }) {
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
    const text = await sendChatMessage(prompt, { expectedConfigId, signal });
    parsed = extractJson(text);
  } catch (error) {
    if (isConfigChangedError(error) || isCanceledError(error)) throw error;
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
      return { ...item, text: `${item.speakerName}：${getMessagePromptText(item)}` };
    }
    if (item && item.image) return { ...item, text: getMessagePromptText(item) };
    return item;
  });
}

function speakerLabel(characters, item) {
  if (item?.role === 'user') return '用户';
  const name = String(item?.speakerName || nameOf(characters, item?.speakerId) || '').trim();
  return name || '角色';
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

export const ENSEMBLE_MODE = 'ensemble';

const ENSEMBLE_INSTRUCTION = [
  '你是一场多人群聊的编剧与全体角色的扮演者。',
  '请阅读在场成员的设定与最近的群聊记录，然后写出这一轮群聊中各个角色的发言。',
  '',
  '输出格式（必须严格遵守）：',
  '- 每个角色的发言单独成段，以「角色名：」开头，冒号使用中文全角「：」。',
  '- 段与段之间用一个空行分隔，不要编号，不要写旁白、心理描写或「（……）」之外的说明文字。',
  '- 只让真正需要回应的角色发言，通常 1 到 3 个；其余角色保持沉默，不要强行让所有人说话。',
  '- 每个角色的篇幅由你根据情境判断：重要回应可以多写，附和或简短反应可以一句话。',
  '',
  '扮演要求：',
  '- 严格遵循每个角色各自的性格、语气、称呼与说话习惯，不要让不同角色的说话方式互相混淆。',
  '- 角色之间可以互相呼应、附和、反驳或调侃，但不要替用户发言或行动。',
  '- 不要复述用户已经说过的内容，直接推进对话。',
].join('\n');

function ensembleRoster(characters, profiles) {
  const cache = profiles && typeof profiles === 'object' ? profiles : {};
  return (Array.isArray(characters) ? characters : [])
    .filter(Boolean)
    .map(character => {
      const id = String(character.id || '');
      const name = String(character.name || '').trim() || '角色';
      const profile = String(cache[id] || '').trim() || staticProfileOf(character)
        || `群聊成员之一，称为「${name}」。`;
      return `- ${name}：${profile}`;
    })
    .join('\n');
}

function buildGroupMediaPrompt(item, characters) {
  const scripts = (Array.isArray(characters) ? characters : [])
    .flatMap(character => Array.isArray(character && character.regexScripts)
      ? character.regexScripts
      : []);
  return applyRegexScripts(
    getMessagePromptText(item),
    scripts,
    REGEX_PLACEMENT.USER_INPUT,
    { mode: 'prompt', depth: 0 }
  );
}

export function buildEnsemblePrompt({
  characters,
  historyMessages,
  userText,
  userProfile,
  globalPresets,
  profiles,
  mentions = [],
  everyone = false,
  imageMessages = [],
}) {
  const list = (Array.isArray(characters) ? characters : []).filter(Boolean);
  if (list.length === 0) return [];
  const roster = ensembleRoster(list, profiles);
  const mentionNames = (Array.isArray(mentions) ? mentions : [])
    .map(id => nameOf(list, id))
    .filter(Boolean)
    .join('、');
  const systemLines = [
    ENSEMBLE_INSTRUCTION,
    '',
    '在场成员：',
    roster,
  ];
  if (everyone) {
    systemLines.push('', '用户在本轮点名了全体成员，请确保每个角色都发言。');
  } else if (mentionNames) {
    systemLines.push('', `用户在本轮点名了：${mentionNames}。请确保被点名的角色一定发言。`);
  }
  const recent = (Array.isArray(historyMessages) ? historyMessages : [])
    .filter(item => item && (item.role === 'user' || item.role === 'assistant'))
    .slice(-GROUP_RECENT_LINES)
    .map(item => {
      const label = speakerLabel(list, item);
       const text = buildGroupMediaPrompt(item, list).replace(/\s+/g, ' ').trim().slice(0, 200);
      return text ? `${label}：${text}` : '';
    })
    .filter(Boolean);
  if (recent.length > 0) {
    systemLines.push('', '最近对话：', recent.join('\n'));
  }
  const prompt = [
    { role: 'system', content: systemLines.join('\n') },
  ];
  const mediaMessages = (Array.isArray(imageMessages) ? imageMessages : [])
    .filter(item => item && (item.dataUri || item.image))
    .map(item => {
      const text = buildGroupMediaPrompt(item, list);
      const dataUri = item.includeImage === false ? '' : String(item.dataUri || '');
      return {
        role: 'user',
        content: dataUri
          ? [
              { type: 'text', text },
              { type: 'image_url', image_url: { url: dataUri } },
            ]
          : text,
      };
    });
  prompt.push(...mediaMessages);
  const userContent = String(userText || '').trim();
  if (userContent) {
    prompt.push({ role: 'user', content: userContent });
  } else if (mediaMessages.length === 0) {
    prompt.push({
      role: 'system',
      content: '（以上是当前场景的旁白，请让需要回应的角色自然发言。）',
    });
  }
  return prompt;
}

function matchSpeaker(name, characters) {
  const target = String(name || '').trim();
  if (!target) return null;
  const list = (Array.isArray(characters) ? characters : []).filter(Boolean);
  const exact = list.find(character => String(character.name || '').trim() === target);
  if (exact) return exact;
  const contained = list.find(character => {
    const candidate = String(character.name || '').trim();
    return candidate && (target.includes(candidate) || candidate.includes(target));
  });
  return contained || null;
}

export function parseEnsembleReply(text, characters) {
  const source = String(text || '').replace(/\r\n/g, '\n');
  const lines = source.split('\n');
  const segments = [];
  let current = null;
  const flush = () => {
    if (!current) return;
    const body = current.lines.join('\n').trim();
    if (body) {
      segments.push({ speakerName: current.name, text: body });
    }
    current = null;
  };
  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const match = line.match(/^\s*\**([^：:\n]{1,24})\**\s*[：:]\s*(.*)$/);
    if (match && match[1] && !/^https?$/.test(match[1])) {
      flush();
      current = { name: match[1].trim(), lines: [] };
      if (match[2]) current.lines.push(match[2]);
      continue;
    }
    if (current) current.lines.push(rawLine);
  }
  flush();
  if (segments.length === 0) return [];
  return segments.map(segment => {
    const character = matchSpeaker(segment.speakerName, characters);
    return {
      speakerId: character ? character.id : '',
      speakerName: character ? String(character.name || segment.speakerName) : segment.speakerName,
      text: segment.text,
    };
  });
}

export function mergeAdjacentSegments(segments) {
  const list = Array.isArray(segments) ? segments : [];
  const merged = [];
  list.forEach(segment => {
    if (!segment || !String(segment.text || '').trim()) return;
    const last = merged[merged.length - 1];
    if (last && last.speakerId === segment.speakerId && last.speakerName === segment.speakerName) {
      last.text = `${last.text}\n\n${segment.text}`;
      return;
    }
    merged.push({ ...segment });
  });
  return merged;
}

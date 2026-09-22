export function makeSessionId(now = Date.now()) {
  return `session-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function uniqueSessionId(base, list) {
  const sessions = Array.isArray(list) ? list : [];
  let id = String(base || '').trim() || makeSessionId();
  if (!sessions.some(session => session.id === id)) return id;
  let suffix = 2;
  while (sessions.some(session => session.id === `${id}-${suffix}`)) {
    suffix += 1;
  }
  return `${id}-${suffix}`;
}

function normalizeMemberProfiles(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const result = {};
  for (const [key, value] of Object.entries(source)) {
    const id = String(key || '').trim();
    const text = String(value || '').trim();
    if (id && text) result[id] = text;
  }
  return result;
}

export function normalizeSession(raw, index = 0) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const createdAt = Number(source.createdAt);
  const updatedAt = Number(source.updatedAt);
  const type = source.type === 'group' ? 'group' : 'single';
  return {
    id: String(source.id || `session-${index}`),
    type,
    characterId: String(source.characterId || ''),
    members: type === 'group' && Array.isArray(source.members)
      ? source.members.map(String).filter(Boolean)
      : [],
    memberProfiles: type === 'group' ? normalizeMemberProfiles(source.memberProfiles) : {},
    groupMode: type === 'group' ? (source.groupMode === 'turn' ? 'turn' : 'ensemble') : '',
    avatarUri: type === 'group' ? String(source.avatarUri || '') : '',
    bgUri: type === 'group' ? String(source.bgUri || '') : '',
    name: String(source.name || ''),
    preview: String(source.preview || ''),
    pinned: source.pinned === true,
    createdAt: Number.isFinite(createdAt) ? createdAt : 0,
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
    clonedFrom: String(source.clonedFrom || ''),
    summarizedUpTo: source.summarizedUpTo ? String(source.summarizedUpTo) : '',
  };
}

export function sortSessions(list) {
  return [...(Array.isArray(list) ? list : [])].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    const diff = (b.updatedAt || 0) - (a.updatedAt || 0);
    if (diff !== 0) return diff;
    return String(a.id).localeCompare(String(b.id));
  });
}

export function buildPreview(messages, maxLength = 60) {
  const list = Array.isArray(messages) ? messages : [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const item = list[index];
    if (!item || item.pending) continue;
    if (item.role !== 'user' && item.role !== 'assistant') continue;
    const text = String(item.text || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
  }
  return '';
}

export function regenerateMessageIds(messages, now = Date.now()) {
  return (Array.isArray(messages) ? messages : []).map((item, index) => ({
    ...item,
    id: `${now}-clone-${index}`,
  }));
}

export function resolveActiveSessionId(sessions, activeId) {
  const list = Array.isArray(sessions) ? sessions : [];
  if (activeId && list.some(session => session.id === activeId)) return activeId;
  return list.length ? list[0].id : '';
}

export function createEmptySession(characterId, sessions, now = Date.now()) {
  const list = Array.isArray(sessions) ? sessions : [];
  return {
    id: uniqueSessionId(makeSessionId(now), list),
    type: 'single',
    characterId: String(characterId || ''),
    members: [],
    memberProfiles: {},
    groupMode: '',
    avatarUri: '',
    bgUri: '',
    name: '',
    preview: '',
    pinned: false,
    createdAt: now,
    updatedAt: now,
    clonedFrom: '',
    summarizedUpTo: '',
  };
}

export function createGroupSession(members, name, sessions, now = Date.now(), extras = {}) {
  const list = Array.isArray(sessions) ? sessions : [];
  const ids = (Array.isArray(members) ? members : []).map(String).filter(Boolean);
  return {
    id: uniqueSessionId(makeSessionId(now), list),
    type: 'group',
    characterId: '',
    members: ids,
    memberProfiles: {},
    groupMode: 'ensemble',
    avatarUri: String(extras.avatarUri || ''),
    bgUri: String(extras.bgUri || ''),
    name: String(name || ''),
    preview: '',
    pinned: false,
    createdAt: now,
    updatedAt: now,
    clonedFrom: '',
    summarizedUpTo: '',
  };
}

export function buildClonedSession(sessions, source, messages, now = Date.now()) {
  return {
    ...source,
    id: uniqueSessionId(makeSessionId(now), sessions),
    pinned: false,
    createdAt: now,
    updatedAt: now,
    clonedFrom: String((source && source.id) || ''),
    summarizedUpTo: '',
    preview: buildPreview(messages),
  };
}

// 群聊里每条 assistant 消息都带 speakerId/speakerName；单聊消息不带。
// 因此收集到的发言人数量可用来判断一段消息是不是群聊。
export const GROUP_MIN_SPEAKERS = 2;

export function collectMessageSpeakers(messages) {
  const map = new Map();
  (Array.isArray(messages) ? messages : []).forEach(item => {
    if (!item || item.role !== 'assistant') return;
    const id = String(item.speakerId || '').trim();
    if (!id) return;
    if (!map.has(id)) map.set(id, String(item.speakerName || '').trim());
  });
  return [...map.entries()].map(([id, name]) => ({ id, name }));
}

export function isMessageGroup(messages) {
  return collectMessageSpeakers(messages).length >= GROUP_MIN_SPEAKERS;
}

// 恢复"消息体还在、会话记录丢了"的对话：id 必须沿用原值，消息才对得上。
// 时间取消息时间戳，保证恢复后在列表里的位置接近原样。
// 消息里出现多个发言人时按群聊还原（保留成员），否则按单聊归属到 characterId。
export function buildRestoredSession({ sessionId, characterId, messages, now = Date.now() } = {}) {
  const list = (Array.isArray(messages) ? messages : []).filter(item => item && !item.pending);
  const timestamps = list
    .map(item => Number(item && item.timestamp))
    .filter(value => Number.isFinite(value));
  const speakers = collectMessageSpeakers(list);
  const createdAt = timestamps.length ? Math.min(...timestamps) : now;
  const updatedAt = timestamps.length ? Math.max(...timestamps) : now;

  if (speakers.length >= GROUP_MIN_SPEAKERS) {
    const memberProfiles = {};
    speakers.forEach(speaker => {
      if (speaker.name) memberProfiles[speaker.id] = speaker.name;
    });
    return {
      id: String(sessionId || ''),
      type: 'group',
      characterId: '',
      members: speakers.map(speaker => speaker.id),
      memberProfiles,
      groupMode: 'ensemble',
      avatarUri: '',
      bgUri: '',
      name: '',
      preview: buildPreview(list),
      pinned: false,
      createdAt,
      updatedAt,
      clonedFrom: '',
      summarizedUpTo: '',
    };
  }

  return {
    id: String(sessionId || ''),
    type: 'single',
    characterId: String(characterId || ''),
    members: [],
    memberProfiles: {},
    groupMode: '',
    avatarUri: '',
    bgUri: '',
    name: '',
    preview: buildPreview(list),
    pinned: false,
    createdAt,
    updatedAt,
    clonedFrom: '',
    summarizedUpTo: '',
  };
}

// 用开场白反推一段孤儿对话属于哪个角色：单聊的第一条助手消息通常就是该角色的 firstMes。
// 先精确比对（含 {{user}} 替换），再退化为前 20 字前缀比对；判不出来返回空串。
export function guessCharacterIdForMessages(messages, characters, { userName = '' } = {}) {
  const user = String(userName || '').trim();
  const normalize = text => {
    let value = String(text || '');
    if (user) value = value.replace(/\{\{user\}\}/g, user);
    return value.replace(/\s+/g, ' ').trim();
  };
  const pool = (Array.isArray(characters) ? characters : [])
    .map(item => ({ id: String((item && item.id) || ''), firstMes: normalize(item && item.firstMes) }))
    .filter(item => item.id && item.firstMes);
  if (pool.length === 0) return '';

  const replies = (Array.isArray(messages) ? messages : [])
    .filter(item => item && item.role === 'assistant')
    .map(item => normalize(item.text))
    .filter(Boolean);
  if (replies.length === 0) return '';

  const exact = pool.find(item => replies.some(reply => item.firstMes === reply));
  if (exact) return exact.id;

  // 开场白后面被追加了内容时，用该角色的开场白前 12 字与回复比对（太短的不猜，避免误判）
  const first = replies[0];
  const prefix = pool.find(item => {
    const probe = item.firstMes.slice(0, 12);
    return probe.length >= 6 && first.startsWith(probe);
  });
  return prefix ? prefix.id : '';
}

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

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

export function normalizeSession(raw, index = 0) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const createdAt = Number(source.createdAt);
  const updatedAt = Number(source.updatedAt);
  return {
    id: String(source.id || `session-${index}`),
    characterId: String(source.characterId || ''),
    preview: String(source.preview || ''),
    pinned: source.pinned === true,
    createdAt: Number.isFinite(createdAt) ? createdAt : 0,
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
    clonedFrom: String(source.clonedFrom || ''),
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
    characterId: String(characterId || ''),
    preview: '',
    pinned: false,
    createdAt: now,
    updatedAt: now,
    clonedFrom: '',
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
    preview: buildPreview(messages),
  };
}

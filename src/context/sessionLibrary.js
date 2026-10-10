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
    greetingSelected: source.greetingSelected === true,
    // J3：会话级 agent 模式记忆——'' = 没设过（跟随全局设置）；只收 read/write
    //（ask 是默认态，不必存）。老数据无此字段 → ''，零迁移。
    agentMode: source.agentMode === 'read' || source.agentMode === 'write' ? source.agentMode : '',
    createdAt: Number.isFinite(createdAt) ? createdAt : 0,
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
    clonedFrom: String(source.clonedFrom || ''),
    summarizedUpTo: source.summarizedUpTo ? String(source.summarizedUpTo) : '',
  };
}

export function selectSessionsForCharacters(list, characterIds) {
  const ids = new Set(
    (Array.isArray(characterIds) ? characterIds : [])
      .map(id => String(id || ''))
      .filter(Boolean)
  );
  return (Array.isArray(list) ? list : []).filter(session => {
    if (!session) return false;
    if (ids.has(String(session.characterId || ''))) return true;
    return session.type === 'group'
      && Array.isArray(session.members)
      && session.members.some(member => ids.has(String(member || '')));
  });
}

export function sortSessions(list) {
  return [...(Array.isArray(list) ? list : [])].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    const diff = (b.updatedAt || 0) - (a.updatedAt || 0);
    if (diff !== 0) return diff;
    return String(a.id).localeCompare(String(b.id));
  });
}

// 会话模型标识（记忆页「本地」badge 的数据源）：modelKind 'local' | 'api' + modelName。
// 本地模型与云端 API 的对话此前在列表里完全无法区分（2026-10-06 指令书 Phase 3）。
// 旧数据无字段：读取侧把缺失视为 'api'，不迁移、不回填。
// 无变化返回 null，调用方据此跳过写盘。
export function applySessionModelMark(session, mark) {
  if (!session || typeof session !== 'object') return null;
  const source = mark && typeof mark === 'object' ? mark : {};
  const modelKind = source.modelKind === 'local' ? 'local' : 'api';
  const modelName = String(source.modelName || '').trim().slice(0, 120);
  if (session.modelKind === modelKind && String(session.modelName || '') === modelName) {
    return null;
  }
  return { ...session, modelKind, modelName };
}

export function buildPreview(messages, maxLength = 60) {
  const list = Array.isArray(messages) ? messages : [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const item = list[index];
    if (!item || item.pending) continue;
    if (item.role !== 'user' && item.role !== 'assistant') continue;
    const text = String(
      item.text
      || (item.image && (item.image.stickerName || item.image.name))
      || ''
    ).replace(/\s+/g, ' ').trim();
    if (!text) continue;
    return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
  }
  return '';
}

export function regenerateMessageIds(messages, now = Date.now()) {
  const list = Array.isArray(messages) ? messages : [];
  const idMap = new Map();
  list.forEach((item, index) => {
    if (!item || item.id === null || item.id === undefined) return;
    const oldId = String(item.id);
    if (!idMap.has(oldId)) idMap.set(oldId, `${now}-clone-${index}`);
  });
  return list.map((item, index) => {
    const next = { ...item, id: `${now}-clone-${index}` };
    if (next.quoted && typeof next.quoted === 'object') {
      const oldQuotedId = next.quoted.id;
      const mapped = oldQuotedId === null || oldQuotedId === undefined
        ? ''
        : idMap.get(String(oldQuotedId));
      if (mapped) next.quoted = { ...next.quoted, id: mapped };
    }
    return next;
  });
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
    greetingSelected: false,
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
    greetingSelected: true,
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
const GROUP_MIN_SPEAKERS = 2;

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
      greetingSelected: true,
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
    greetingSelected: list.length > 0,
    createdAt,
    updatedAt,
    clonedFrom: '',
    summarizedUpTo: '',
  };
}

// 用开场白反推一段孤儿对话属于哪个角色：单聊的第一条助手消息通常就是该角色的 firstMes。
// 只做开场白**全文**精确比对（含 {{user}} 替换）；前缀猜测已移除（会把孤儿对话
// 错误推荐到兜底卡），判不出来返回空串，由恢复弹窗让用户手选。
export function guessCharacterIdForMessages(messages, characters, { userName = '' } = {}) {
  const user = String(userName || '').trim();
  const normalize = text => {
    let value = String(text || '');
    if (user) value = value.replace(/\{\{user\}\}/g, () => user);
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

  // 精确命中也可能有多个（模板卡开场白雷同）：只有唯一命中才敢猜。
  const exactMatches = pool.filter(item => replies.some(reply => item.firstMes === reply));
  if (exactMatches.length === 1) return exactMatches[0].id;
  if (exactMatches.length > 1) return '';


  // 前缀猜测已移除（2026-10-05 审核报告）：12 字前缀会把孤儿对话错误推荐到
  // 兜底卡——助手的开场白也在候选池里，「恢复会话挂到初始卡」那条污染链就是
  // 从这里起步的。只保留开场白**全文精确命中**这一个强证据；判不出来返回空串，
  // 由恢复弹窗让用户手选。
  return '';

}

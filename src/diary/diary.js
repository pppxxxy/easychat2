// 角色日记：纯函数层。日期口径、候选筛选、提示词与规范化都在这里，
// 与 UI / 存储解耦，便于单测。真实写日记的请求在 Runner 里。

export const MAX_DIARIES_PER_CHARACTER = 365;
export const DIARY_TEXT_MAX = 4000;
export const DIARY_SOURCE_MESSAGE_LIMIT = 200;

const DAY_MS = 24 * 60 * 60 * 1000;

function clean(value, max = 0) {
  const text = String(value == null ? '' : value).trim();
  if (!max || text.length <= max) return text;
  return text.slice(0, max);
}

// 本地日期键 YYYY-MM-DD：日记按“自然日”归档，必须用本地时区而不是 UTC，
// 否则晚上写的日记会被算到第二天。
export function localDateKey(timestamp = Date.now()) {
  const value = Number(timestamp);
  const date = new Date(Number.isFinite(value) ? value : Date.now());
  const pad = number => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// “过了一天的第一次启动”判定：当前本地日期晚于上次运行日期即算跨天。
export function isNewDay(lastRunDate, now = Date.now()) {
  const last = clean(lastRunDate, 10);
  if (!last) return true;
  return last !== localDateKey(now);
}

// 昨天的 [00:00, 24:00) 时间窗：日记内容是“一整天”的对话。
export function yesterdayRange(now = Date.now()) {
  const value = Number(now);
  const base = new Date(Number.isFinite(value) ? value : Date.now());
  const start = new Date(base.getFullYear(), base.getMonth(), base.getDate()).getTime() - DAY_MS;
  return { start, end: start + DAY_MS };
}

export function normalizeDiarySettings(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const rolesSource = source.roles && typeof source.roles === 'object' && !Array.isArray(source.roles)
    ? source.roles
    : {};
  const roles = {};
  Object.entries(rolesSource).forEach(([id, value]) => {
    const entry = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const characterId = clean(id, 80);
    if (!characterId) return;
    roles[characterId] = {
      enabled: entry.enabled === true,
      roleName: clean(entry.roleName, 80),
      lastDiaryDate: clean(entry.lastDiaryDate, 10),
    };
  });
  // 迁移旧版可能的全局 enabled 字段：老数据没有 roles 时，视为未开启。
  return {
    roles,
    apiConfigId: clean(source.apiConfigId, 80),
    model: clean(source.model, 120),
    // 上次执行写日记的本地日期：用于把「过了一天的第一次启动」做成闸门，
    // 同一天内再次启动不再重复扫描。
    lastRunDate: clean(source.lastRunDate, 10),
  };
}

export function setDiaryLastRunDate(settings, dateKey) {
  const normalized = normalizeDiarySettings(settings);
  const key = clean(dateKey, 10);
  return { ...normalized, lastRunDate: key || normalized.lastRunDate };
}

export function getRoleDiarySetting(settings, characterId) {
  const normalized = normalizeDiarySettings(settings);
  const id = clean(characterId, 80);
  return normalized.roles[id] || { enabled: false, roleName: '', lastDiaryDate: '' };
}

export function setRoleDiaryEnabled(settings, characterId, enabled, roleName = '') {
  const normalized = normalizeDiarySettings(settings);
  const id = clean(characterId, 80);
  if (!id) return normalized;
  const current = normalized.roles[id] || { enabled: false, roleName: '', lastDiaryDate: '' };
  return {
    ...normalized,
    roles: {
      ...normalized.roles,
      [id]: {
        ...current,
        enabled: enabled === true,
        roleName: clean(roleName, 80) || current.roleName,
      },
    },
  };
}

export function markRoleDiaryDate(settings, characterId, dateKey) {
  const normalized = normalizeDiarySettings(settings);
  const id = clean(characterId, 80);
  const key = clean(dateKey, 10);
  if (!id || !key || !normalized.roles[id]) return normalized;
  return {
    ...normalized,
    roles: {
      ...normalized.roles,
      [id]: { ...normalized.roles[id], lastDiaryDate: key },
    },
  };
}

// 角色被删除时清掉它的日记开关，避免设置里残留孤儿条目。
export function removeRolesFromDiarySettings(settings, characterIds) {
  const normalized = normalizeDiarySettings(settings);
  const ids = new Set((Array.isArray(characterIds) ? characterIds : []).map(id => clean(id, 80)).filter(Boolean));
  if (ids.size === 0) return normalized;
  const roles = {};
  Object.entries(normalized.roles).forEach(([id, value]) => {
    if (!ids.has(id)) roles[id] = value;
  });
  return { ...normalized, roles };
}

export function normalizeDiaryEntry(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const createdAt = Number(source.createdAt);
  return {
    id: clean(source.id, 120),
    characterId: clean(source.characterId, 80),
    characterName: clean(source.characterName, 80),
    date: clean(source.date, 10),
    text: clean(source.text, DIARY_TEXT_MAX),
    createdAt: Number.isFinite(createdAt) && createdAt > 0 ? createdAt : 0,
  };
}

// 同一角色同一天只保留一篇：后写的覆盖先写的（重跑/重试都是幂等的）。
// 同时把每个角色的日记数量限制在 MAX_DIARIES_PER_CHARACTER 内，超出丢弃最旧的。
export function appendDiary(list, entry) {
  const normalized = normalizeDiaryEntry(entry);
  if (!normalized.id || !normalized.characterId || !normalized.date) {
    return Array.isArray(list) ? list : [];
  }
  const rest = (Array.isArray(list) ? list : []).filter(
    item => !(item && item.characterId === normalized.characterId && item.date === normalized.date)
  );
  const next = [...rest, normalized].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  const forCharacter = next.filter(item => item.characterId === normalized.characterId);
  if (forCharacter.length <= MAX_DIARIES_PER_CHARACTER) return next;
  const drop = new Set(
    forCharacter.slice(0, forCharacter.length - MAX_DIARIES_PER_CHARACTER).map(item => item.id)
  );
  return next.filter(item => !drop.has(item.id));
}

export function selectDiariesForCharacter(list, characterId) {
  const id = clean(characterId, 80);
  if (!id) return [];
  return (Array.isArray(list) ? list : [])
    .filter(item => item && item.characterId === id)
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

export function removeDiariesForCharacter(list, characterIds) {
  const ids = new Set((Array.isArray(characterIds) ? characterIds : []).map(id => clean(id, 80)).filter(Boolean));
  if (ids.size === 0) return Array.isArray(list) ? list : [];
  return (Array.isArray(list) ? list : []).filter(item => !item || !ids.has(item.characterId));
}

// 只挑「开启日记 + 昨天还没写过日记」的角色，并带上它的单聊会话 id。
// 不在这里读消息：调用方按需读取这些会话，避免启动时把全部会话都加载一遍。
export function selectDiaryRoles({
  characters = [],
  settings = {},
  sessions = [],
  now = Date.now(),
} = {}) {
  const normalized = normalizeDiarySettings(settings);
  const { start } = yesterdayRange(now);
  const dateKey = localDateKey(start);
  const result = [];
  (Array.isArray(characters) ? characters : []).forEach(character => {
    if (!character || !character.id) return;
    const role = normalized.roles[character.id];
    if (!role || role.enabled !== true) return;
    if (role.lastDiaryDate === dateKey) return;
    const sessionIds = (Array.isArray(sessions) ? sessions : [])
      .filter(session => session && session.type !== 'group' && session.characterId === character.id)
      .map(session => session.id)
      .filter(Boolean);
    result.push({ character, date: dateKey, sessionIds });
  });
  return result;
}

function isConversationTurn(message) {
  return !!message && (message.role === 'user' || message.role === 'assistant') && !message.pending;
}

function messageTimestamp(message) {
  const value = Number(message && message.timestamp);
  return Number.isFinite(value) ? value : 0;
}

// 无时间戳的旧消息按窗口内处理：宁可多带进上下文，也不要漏掉昨天真正的对话。
function inWindow(message, start, end) {
  const timestamp = messageTimestamp(message);
  if (timestamp <= 0) return true;
  return timestamp >= start && timestamp < end;
}

export function collectWindowMessages(messagesBySession, sessionIds, now = Date.now()) {
  const { start, end } = yesterdayRange(now);
  const result = [];
  (Array.isArray(sessionIds) ? sessionIds : []).forEach(sessionId => {
    const messages = Array.isArray(messagesBySession[sessionId]) ? messagesBySession[sessionId] : [];
    messages.forEach(item => {
      if (!isConversationTurn(item)) return;
      if (!inWindow(item, start, end)) return;
      result.push(item);
    });
  });
  return result
    .sort((a, b) => messageTimestamp(a) - messageTimestamp(b))
    .slice(-DIARY_SOURCE_MESSAGE_LIMIT);
}

export function buildDiaryTranscript(messages, { charName = '角色', userName = '用户' } = {}) {
  const speaker = clean(charName, 80) || '角色';
  const user = clean(userName, 80) || '用户';
  return (Array.isArray(messages) ? messages : [])
    .map(item => {
      const text = clean(item && item.text, 4000);
      if (!text) return '';
      const name = item.role === 'user'
        ? user
        : (clean(item.speakerName, 80) || speaker);
      return `${name}：${text}`;
    })
    .filter(Boolean)
    .join('\n');
}

export function buildDiaryPrompt({ charName = '角色', userName = '用户', transcript = '', date = '' } = {}) {
  const speaker = clean(charName, 80) || '角色';
  const user = clean(userName, 80) || '用户';
  const day = clean(date, 10);
  const lines = [
    `你是${speaker}。现在是${day || '今天'}的深夜，${user}不在身边。`,
    '请以你自己的口吻写一篇日记，记录这一天你和对方之间发生的事与你的心情。',
  ];
  const body = clean(transcript, 60000);
  if (body) {
    lines.push('', '这是你们这一天的对话：', body);
  } else {
    lines.push('', '你们今天没有聊太多，就写写你此刻的心境。');
  }
  lines.push(
    '',
    '要求：',
    '- 用第一人称，像真的在写私密日记，可以有场景、动作与内心活动。',
    '- 只写这一篇，不要写成对话，不要重复逐句复述聊天内容。',
    '- 不要出现“记忆”“摘要”“提示词”“系统”这类词，也不要署名或加引号。',
    '- 长度 150-400 字。'
  );
  return lines.join('\n');
}

export function normalizeDiaryText(raw, maxLength = DIARY_TEXT_MAX) {
  let text = String(raw == null ? '' : raw).trim();
  if (!text) return '';
  text = text.replace(/^```[a-zA-Z]*\s*\n?/, '').replace(/\n?```$/, '').trim();
  text = text.replace(/^["“]/, '').replace(/["”]$/, '').trim();
  if (text.length > maxLength) text = text.slice(0, maxLength);
  return text;
}

export function formatDiaryDate(dateKey) {
  const value = clean(dateKey, 10);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return value;
  return `${Number(match[2])}月${Number(match[3])}日`;
}

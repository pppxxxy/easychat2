// 角色日记：纯函数层。日期口径、候选筛选、提示词与规范化都在这里，
// 与 UI / 存储解耦，便于单测。真实写日记的请求在 Runner 里。

export const MAX_DIARIES_PER_CHARACTER = 365;
export const DIARY_TEXT_MAX = 4000;
export const DIARY_SOURCE_MESSAGE_LIMIT = 200;

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

// 昨天的 [00:00, 24:00) 时间窗。用本地日历日构造两端，而不是 start + 24h：
// 夏令时切换当天可能只有 23 或 25 小时，固定加一天会把窗口算偏。
export function yesterdayRange(now = Date.now()) {
  const value = Number(now);
  const base = new Date(Number.isFinite(value) ? value : Date.now());
  const start = new Date(base.getFullYear(), base.getMonth(), base.getDate() - 1).getTime();
  const end = new Date(base.getFullYear(), base.getMonth(), base.getDate()).getTime();
  return { start, end };
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
      // 每角色可单独指定写日记用的 API；留空则回退到全局/当前激活配置。
      apiConfigId: clean(entry.apiConfigId, 80),
    };
  });
  // 上次运行的摘要（2026-10-07）：面板据此显示「上次运行：日期｜写入/跳过/失败」，
  // 让用户能区分「没触发」与「写了没写」。非敏感信息，与设置同键存储。
  const lastRunSource = source.lastRun && typeof source.lastRun === 'object' && !Array.isArray(source.lastRun)
    ? source.lastRun
    : {};
  const lastRunCount = value => {
    const num = Number(value);
    return Number.isFinite(num) && num > 0 ? Math.floor(num) : 0;
  };
  // 迁移旧版可能的全局 enabled 字段：老数据没有 roles 时，视为未开启。
  return {
    roles,
    lastRun: {
      date: clean(lastRunSource.date, 10),
      written: lastRunCount(lastRunSource.written),
      skipped: lastRunCount(lastRunSource.skipped),
      failed: lastRunCount(lastRunSource.failed),
    },
    apiConfigId: clean(source.apiConfigId, 80),
    model: clean(source.model, 120),
    // 上次执行写日记的本地日期：用于把「过了一天的第一次启动」做成闸门，
    // 同一天内再次启动不再重复扫描。
    lastRunDate: clean(source.lastRunDate, 10),
  };
}

// 「上次运行日期」闸门推进规则（2026-10-07）：
//   有候选角色（roleCount > 0）时不推进——无论写没写成功、是否因昨天无对话跳过，
//   都保留当天再次触发的补写机会。此前「纯跳过」也会推进闸门：早上启动时若昨天
//   该角色没聊过（或消息尚未落盘），闸门被推到今天，用户当天稍后聊天也不再补写。
//   仅当「确实无需写」（没有任何候选角色，含全部角色都已完成昨天）时才推进，
//   让下一天能进入新的窗口。规则做成纯函数便于单测钉住。
export function shouldAdvanceDiaryRunDate({ roleCount = 0 } = {}) {
  return !(Number(roleCount) > 0);
}

// 把本次运行摘要写进设置（面板展示用）。摘要缺失/非法一律安全归零。
export function setDiaryLastRunSummary(settings, summary = {}) {
  const normalized = normalizeDiarySettings(settings);
  const source = summary && typeof summary === 'object' && !Array.isArray(summary) ? summary : {};
  return {
    ...normalized,
    lastRun: normalizeDiarySettings({ lastRun: source }).lastRun,
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
  return normalized.roles[id] || { enabled: false, roleName: '', lastDiaryDate: '', apiConfigId: '' };
}

// 每个角色单独设置：开关、角色名、写日记用的 API。
export function setRoleDiarySetting(settings, characterId, patch = {}) {
  const normalized = normalizeDiarySettings(settings);
  const id = clean(characterId, 80);
  if (!id) return normalized;
  const current = normalized.roles[id] || { enabled: false, roleName: '', lastDiaryDate: '', apiConfigId: '' };
  const next = { ...current };
  if (patch.enabled !== undefined) next.enabled = patch.enabled === true;
  if (patch.roleName !== undefined) next.roleName = clean(patch.roleName, 80) || current.roleName;
  if (patch.apiConfigId !== undefined) next.apiConfigId = clean(patch.apiConfigId, 80);
  return { ...normalized, roles: { ...normalized.roles, [id]: next } };
}

export function setRoleDiaryEnabled(settings, characterId, enabled, roleName = '') {
  return setRoleDiarySetting(settings, characterId, { enabled, roleName });
}

// 解析某角色实际使用的写日记 API：角色自带 → 全局 → 回退（由调用方给激活配置）。
export function resolveRoleDiaryConfigId(settings, characterId) {
  const role = getRoleDiarySetting(settings, characterId);
  if (role.apiConfigId) return role.apiConfigId;
  return normalizeDiarySettings(settings).apiConfigId || '';
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
  return Number.isFinite(value) && value > 0 ? value : 0;
}

// 只纳入能确认落在昨天窗口内的消息。无时间戳的旧消息不纳入：无法判断它是不是
// 昨天的对话，强行带上会把历史内容当「前一天的对话」发给模型，与界面说明不符。
function inWindow(message, start, end) {
  const timestamp = messageTimestamp(message);
  if (timestamp <= 0) return false;
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
    '- 只输出日记正文本身，不要标题、日期行、署名、引号或任何前后缀。',
    '- 用第一人称，像真的在写私密日记，可以有场景、动作与内心活动。',
    '- 写清楚今天发生了什么、你当时的感受、以及你最想记下来的那件事或那句话。',
    '- 不要写成对话，不要逐句复述聊天记录，也不要出现“记忆”“摘要”“提示词”“系统”这类词。',
    '- 长度 150-400 字的连续段落，可分 1-3 段。'
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

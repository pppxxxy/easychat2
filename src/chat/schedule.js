// 角色作息纯逻辑：解析 / 归一 / 旧模型迁移 / 时间段与概率事件判定 / 提示词生成。
//
// 提示词必须是**按天稳定**的文本：
//  · 主动消息的请求快照在保存时生成、数天后才触发，所以 `buildSchedulePrompt` 在
//    **不传 date** 时产出与具体日期无关的规则（快照路径用，见 proactiveRequest.js）；
//    只有普通对话 / 定时任务（每次请求现算）才传入当天日期。
//  · 同一天内多次构建必须**逐字节一致**——概率事件是否触发用确定性种子
//    （characterId + 事件 id + 日期）判定，绝不用 Math.random()。否则系统提示的
//    缓存前缀每轮都会变（见 prompt/systemSections.js 的缓存契约）。
// 不依赖 RN / 存储 / i18n（提示词不进 i18n），可在 Node 直测。

// 数据模型版本号。旧模型（四个固定时刻）没有该字段，读到即迁移（见 migrateSchedule）。
export const SCHEDULE_SCHEMA_VERSION = 2;

// 概率事件默认概率（百分数，0–100）。UI 新增一行时不填就是这个值。
export const DEFAULT_EVENT_PROBABILITY = 50;

// 容量上限：作息文本进系统提示，必须有界（防手滑粘贴把上下文撑爆）。
export const MAX_SEGMENTS_PER_DAY = 12;
export const MAX_EVENTS_PER_DAY = 20;
export const MAX_SEGMENT_NAME = 24;
export const MAX_EVENT_NAME = 24;
export const MAX_EVENT_DESCRIPTION = 120;

const TIME_PATTERN = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

// 旧模型（v1）的字段与默认值：迁移与默认作息共用同一份来源，避免两处漂移。
const LEGACY_TIME_KEYS = ['wake', 'workStart', 'workEnd', 'sleep'];
const LEGACY_DEFAULTS = { wake: '07:00', workStart: '09:00', workEnd: '18:00', sleep: '23:00' };

// 迁移出来的内置时间段的显示名（仅用于**发给模型的提示词**，不进 i18n；
// 界面上 `name` 为空时由 UI 用词条 schedule.builtin.* 解析）。
const BUILTIN_LABELS = { sleep: '睡眠', work: '工作' };

// "HH:MM" → 当天分钟数；非法返回 null。允许 "7:05" 这种单位数小时。
export function parseTime(text) {
  const match = TIME_PATTERN.exec(String(text || '').trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

// 分钟数 → "HH:MM"；非法返回 ''。
export function formatTime(minutes) {
  const value = Math.trunc(Number(minutes));
  if (!Number.isFinite(value) || value < 0 || value >= 24 * 60) return '';
  const h = Math.floor(value / 60);
  const m = value % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function normalizeTime(value, fallback) {
  const minutes = parseTime(value);
  return minutes === null ? fallback : formatTime(minutes);
}

// "YYYY-MM-DD" → 合法则原样返回，否则 ''。用本地日期回环校验（拒绝 2026-02-30）。
export function parseDateKey(text) {
  const match = DATE_PATTERN.exec(String(text == null ? '' : text).trim());
  if (!match) return '';
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(year, month - 1, day);
  if (probe.getFullYear() !== year || probe.getMonth() !== month - 1 || probe.getDate() !== day) return '';
  return `${match[1]}-${match[2]}-${match[3]}`;
}

// Date → 本地日期键 "YYYY-MM-DD"；非法返回 ''。用**本地**时区，与 resolveScheduleSegment
// 取小时数同口径（写成 UTC 会让东八区的凌晨算到前一天）。
export function dateKeyOf(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// 把 Date / "YYYY-MM-DD" 统一成本地 Date；非法返回 null。
// 注意不能对日期键直接用 new Date('2026-10-07')：那按 UTC 解析，负时区会退到前一天。
function toLocalDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const key = parseDateKey(value);
  if (!key) {
    if (value === null || value === undefined || value === '') return null;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  const [year, month, day] = key.split('-').map(Number);
  return new Date(year, month - 1, day);
}

// 日期/时间键 → "YYYY-MM-DD"；非法返回 ''。
export function resolveDateKey(value) {
  if (value instanceof Date) return dateKeyOf(value);
  const key = parseDateKey(value);
  if (key) return key;
  return value === null || value === undefined || value === '' ? '' : dateKeyOf(value);
}

// FNV-1a 32 位散列：概率事件的确定性种子。同输入必同输出（跨进程/跨平台稳定）。
export function hash32(text) {
  let hash = 0x811c9dc5;
  const source = String(text == null ? '' : text);
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

// 名称/描述：去换行（会破坏提示词分行）、压缩空白、截断。
function cleanText(value, maxLength) {
  return String(value == null ? '' : value)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function normalizeBuiltin(value) {
  return value === 'sleep' || value === 'work' ? value : '';
}

function normalizeProbability(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_EVENT_PROBABILITY;
  return Math.min(100, Math.max(0, Math.round(number)));
}

// 时间段：起止都要合法且不相等；start > end 表示跨零点（复用 inWindow）。
// 名称为空时用 builtin 词条解析显示名（迁移出来的内置段）。
function normalizeSegment(raw) {
  const source = plainObject(raw);
  if (!source) return null;
  const start = parseTime(source.start);
  const end = parseTime(source.end);
  // start === end 的零长度段永远不可能命中，留着只会在提示词里骗模型，直接丢弃。
  if (start === null || end === null || start === end) return null;
  const name = cleanText(source.name, MAX_SEGMENT_NAME);
  const builtin = normalizeBuiltin(source.builtin);
  const id = cleanText(source.id, 40) || `seg-${hash32(`${formatTime(start)}|${formatTime(end)}|${name}`)}`;
  return { id, name, builtin, start: formatTime(start), end: formatTime(end) };
}

// 概率事件：kind='point' 用 at，kind='range' 用 start/end（可跨零点）。
// 描述是「要做什么」，为空的事件没有意义，丢弃。
function normalizeEvent(raw) {
  const source = plainObject(raw);
  if (!source) return null;
  const description = cleanText(source.description, MAX_EVENT_DESCRIPTION);
  if (!description) return null;
  const kind = source.kind === 'range' ? 'range' : 'point';
  let at = '';
  let start = '';
  let end = '';
  if (kind === 'point') {
    const point = parseTime(source.at);
    if (point === null) return null;
    at = formatTime(point);
  } else {
    const from = parseTime(source.start);
    const to = parseTime(source.end);
    if (from === null || to === null || from === to) return null;
    start = formatTime(from);
    end = formatTime(to);
  }
  const name = cleanText(source.name, MAX_EVENT_NAME);
  const id = cleanText(source.id, 40)
    || `ev-${hash32(`${kind}|${at}|${start}|${end}|${description}`)}`;
  return { id, name, kind, at, start, end, probability: normalizeProbability(source.probability), description };
}

function normalizeDay(raw) {
  const source = plainObject(raw) || {};
  const segments = (Array.isArray(source.segments) ? source.segments : [])
    .map(normalizeSegment)
    .filter(Boolean)
    .slice(0, MAX_SEGMENTS_PER_DAY);
  const events = (Array.isArray(source.events) ? source.events : [])
    .map(normalizeEvent)
    .filter(Boolean)
    .slice(0, MAX_EVENTS_PER_DAY);
  return { segments, events };
}

// 假日列表：只收合法的 YYYY-MM-DD，去重并按日期升序（顺序稳定 = 提示词稳定）。
export function normalizeHolidays(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const keys = new Set();
  list.forEach(item => {
    const key = parseDateKey(item);
    if (key) keys.add(key);
  });
  return [...keys].sort();
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.keys(value).forEach(key => deepFreeze(value[key]));
  }
  return value;
}

// 新模型默认作息：等价于旧模型的四个默认时刻（睡眠 23:00–07:00、工作 09:00–18:00），
// 其余时间为空闲——见 migrateSchedule 的等价性说明。
export function createDefaultSchedule() {
  return {
    schema: SCHEDULE_SCHEMA_VERSION,
    enabled: false,
    splitWeekday: false,
    workday: {
      segments: [
        { id: 'sleep', name: '', builtin: 'sleep', start: LEGACY_DEFAULTS.sleep, end: LEGACY_DEFAULTS.wake },
        { id: 'work', name: '', builtin: 'work', start: LEGACY_DEFAULTS.workStart, end: LEGACY_DEFAULTS.workEnd },
      ],
      events: [],
    },
    restday: { segments: [], events: [] },
    holidays: [],
  };
}

export const DEFAULT_SCHEDULE = deepFreeze(createDefaultSchedule());

// 新模型的判定标记：出现任一即认为是 v2（即使 schema 字段被写坏）。
// 这样「用户把所有时间段都删光」不会被当成旧模型又迁移回默认作息。
const V2_MARKER_KEYS = ['workday', 'restday', 'holidays', 'splitWeekday'];

function looksV2(source) {
  const version = Number(source.schema);
  if (Number.isFinite(version) && version >= SCHEDULE_SCHEMA_VERSION) return true;
  return V2_MARKER_KEYS.some(key => source[key] !== undefined);
}

// 旧模型 → 新模型。行为等价性（与 v1 的 resolveSchedulePeriod 逐点对齐）：
//  · v1「睡眠」= [sleep, wake) 跨零点优先命中，v1「工作」= [workStart, workEnd)，
//    其余为空闲；
//  · 新模型命中规则是「按列表顺序取第一个命中」，故把「睡眠」排在「工作」**之前**，
//    重叠时仍是睡眠优先（昼夜颠倒的极端配置下不误判）；不在任何段内 = 空闲。
//  · v1 的四个时刻分别落到这两段：sleep→睡眠.start、wake→睡眠.end、
//    workStart→工作.start、workEnd→工作.end。空档（如 07:00–09:00、18:00–23:00）
//    在新模型里是「不在任何时间段内」，语义与 v1 的 free 一致。
export function migrateSchedule(raw) {
  const source = plainObject(raw);
  if (!source) return null;
  if (looksV2(source)) return source;
  // 没有任何旧字段（例如空对象 {}）视为「没有作息」，交给 normalizeSchedule 走默认值。
  const isLegacy = source.enabled !== undefined || LEGACY_TIME_KEYS.some(key => source[key] !== undefined);
  if (!isLegacy) return null;
  const sleep = normalizeTime(source.sleep, LEGACY_DEFAULTS.sleep);
  const wake = normalizeTime(source.wake, LEGACY_DEFAULTS.wake);
  const workStart = normalizeTime(source.workStart, LEGACY_DEFAULTS.workStart);
  const workEnd = normalizeTime(source.workEnd, LEGACY_DEFAULTS.workEnd);
  return {
    schema: SCHEDULE_SCHEMA_VERSION,
    enabled: source.enabled === true,
    splitWeekday: false,
    workday: {
      segments: [
        { id: 'sleep', name: '', builtin: 'sleep', start: sleep, end: wake },
        { id: 'work', name: '', builtin: 'work', start: workStart, end: workEnd },
      ],
      events: [],
    },
    restday: { segments: [], events: [] },
    holidays: [],
  };
}

// 归一化（内含迁移，幂等：v2 输入原样归一，输出仍是 v2）。
// 无作息（null/undefined/{}）返回默认作息；用户把段删光的 v2 对象保持为空。
export function normalizeSchedule(raw) {
  const migrated = migrateSchedule(raw);
  if (!migrated) return createDefaultSchedule();
  return {
    schema: SCHEDULE_SCHEMA_VERSION,
    enabled: migrated.enabled === true,
    splitWeekday: migrated.splitWeekday === true,
    workday: normalizeDay(migrated.workday),
    restday: normalizeDay(migrated.restday),
    holidays: normalizeHolidays(migrated.holidays),
  };
}

// 作息是否生效：启用，且至少有一个可用时间段或概率事件。
// （v1 的口径是「四个时刻都合法」；新模型里非法时间在归一阶段已被丢弃或回退，
//   所以「有内容」即等价于旧口径下的「配置可用」。）
export function isScheduleActive(schedule) {
  if (!schedule || schedule.enabled !== true) return false;
  const s = normalizeSchedule(schedule);
  return s.workday.segments.length > 0 || s.workday.events.length > 0
    || s.restday.segments.length > 0 || s.restday.events.length > 0;
}

// 是否休息日：周末（周六/周日）自动算，用户假日列表里的日期也算（节假日 → 休息日）。
// 假日列表只做「工作日 → 休息日」的加法，不表达调休（调休需要额外的补班日期表）。
export function isRestDay(schedule, date) {
  const d = toLocalDate(date);
  if (!d) return false;
  const weekday = d.getDay();
  if (weekday === 0 || weekday === 6) return true;
  const key = dateKeyOf(d);
  const holidays = normalizeHolidays(schedule && schedule.holidays);
  return holidays.includes(key);
}

// 当天用哪一套：'workday' | 'restday'。未开启「区分工作日/休息日」时恒为 workday。
export function activeDayKind(schedule, date) {
  const s = normalizeSchedule(schedule);
  if (!s.splitWeekday) return 'workday';
  return isRestDay(s, date) ? 'restday' : 'workday';
}

// 当天生效的时间段列表（列表顺序 = 命中优先级）。
export function segmentsForDay(schedule, date) {
  const s = normalizeSchedule(schedule);
  return s.splitWeekday && isRestDay(s, date) ? s.restday.segments : s.workday.segments;
}

// 当天生效的概率事件列表。
export function eventsForDay(schedule, date) {
  const s = normalizeSchedule(schedule);
  return s.splitWeekday && isRestDay(s, date) ? s.restday.events : s.workday.events;
}

// [start, end) 窗口；start > end 时视为跨零点。时间段与概率事件共用这一份判定。
function inWindow(now, start, end) {
  if (start === end) return false;
  if (start < end) return now >= start && now < end;
  return now >= start || now < end;
}

// 命中判定规则（选定并写进测试）：**按列表顺序取第一个命中的时间段**。
// 理由：① 规则唯一且可测，不依赖「最晚开始」这类隐式排序；② 优先级由用户在面板里
// 用 ↑↓ 显式控制（列表顺序即优先级）；③ 迁移出来的「睡眠在前、工作在后」正好复刻
// v1 的「睡眠优先于工作」。都不命中（含空档）→ 返回 null，调用方按「空闲」处理。
export function resolveScheduleSegment(schedule, date = new Date()) {
  const d = toLocalDate(date);
  if (!d) return null;
  const now = d.getHours() * 60 + d.getMinutes();
  const segments = segmentsForDay(schedule, d);
  for (const segment of segments) {
    if (inWindow(now, parseTime(segment.start), parseTime(segment.end))) return segment;
  }
  return null;
}

// 概率事件当天是否发生：确定性种子 (characterId, 事件 id, 日期) 散列后与概率比大小。
// 同一天内恒定（提示词逐字节一致、缓存前缀不失效），跨天才重新决定。
export function eventTriggeredOn(schedule, event, date, characterId = '') {
  const normalized = normalizeEvent(event);
  const key = resolveDateKey(date);
  if (!normalized || !key) return false;
  if (normalized.probability <= 0) return false;
  if (normalized.probability >= 100) return true;
  const seed = `${String(characterId == null ? '' : characterId)}|${normalized.id}|${key}`;
  return hash32(seed) % 100 < normalized.probability;
}

// 当天真正会发生的概率事件（供提示词与测试使用）。
export function resolveDayEvents(schedule, date, characterId = '') {
  const key = resolveDateKey(date);
  if (!key) return [];
  return eventsForDay(schedule, key).filter(event => eventTriggeredOn(schedule, event, key, characterId));
}

// 时间段显示名：用户填的名称优先，否则回退内置词条（迁移出来的睡眠/工作）。
export function segmentLabel(segment) {
  if (!segment) return '';
  return segment.name || BUILTIN_LABELS[segment.builtin] || '时段';
}

function describeSegments(segments) {
  if (!segments.length) return '无固定安排';
  return segments.map(segment => `${segmentLabel(segment)} ${segment.start}–${segment.end}`).join('、');
}

function describeEventWhen(event) {
  return event.kind === 'range' ? `${event.start}–${event.end}` : event.at;
}

// 供提示词使用的作息摘要（中文，**不进 i18n**：它是发给模型的规则文本）。
export function describeSchedule(schedule) {
  const s = normalizeSchedule(schedule);
  const parts = [`工作日：${describeSegments(s.workday.segments)}`];
  if (s.splitWeekday) parts.push(`休息日：${describeSegments(s.restday.segments)}`);
  return parts.join('；');
}

// 静态作息规则文本（中文，不进 i18n）。
//  · 传 options.date（Date 或 'YYYY-MM-DD'）→ 追加「今天是工作日/休息日」与
//    「今天会发生哪些概率事件」，**按天**稳定（同一天内逐字节一致）。
//  · 不传 date → 与具体日期无关的版本：列出两套作息与概率事件定义，
//    不声称今天会发生什么。主动消息快照走这条（快照保存后数天才触发）。
export function buildSchedulePrompt(schedule, options = {}) {
  if (!isScheduleActive(schedule)) return '';
  const s = normalizeSchedule(schedule);
  const characterId = String((options && options.characterId) || '');
  const dateKey = resolveDateKey(options && options.date);
  const lines = [`[角色作息] ${describeSchedule(s)}。`];

  if (dateKey && s.splitWeekday) {
    lines.push(isRestDay(s, dateKey)
      ? '[今天] 今天是休息日（周末或你设定的节假日），按上面的「休息日」安排。'
      : '[今天] 今天是工作日，按上面的「工作日」安排。');
  }

  if (dateKey) {
    const triggered = resolveDayEvents(s, dateKey, characterId);
    const events = eventsForDay(s, dateKey);
    if (events.length > 0) {
      lines.push(triggered.length > 0
        ? `[今天的概率事件] 今天会发生：${triggered.map(event => `${describeEventWhen(event)} ${event.description}`).join('；')}。到点或进入该时段后自然地把这件事做掉，也可以提到刚做过。`
        : '[今天的概率事件] 今天这些事都不会发生，按上面的作息正常生活即可。');
    }
  } else {
    // 不带日期（主动消息快照）：只列定义、不声称今天发生什么，且两套都要列
    // ——快照保存时无法预知触发日是工作日还是休息日。
    const declared = s.splitWeekday ? [...s.workday.events, ...s.restday.events] : s.workday.events;
    if (declared.length > 0) {
      lines.push(`[概率事件] 每天按概率决定是否发生：${declared.map(event => `${describeEventWhen(event)} ${event.description}（约 ${event.probability}%）`).join('；')}。若当前时间已过该时段且你决定今天做这件事，可以自然地提及。`);
    }
  }

  lines.push(
    '请结合系统提示中的「当前时间」判断你此刻处于哪个时间段，并据此调整语气与篇幅：',
    '- 睡眠/休息类时间段（名称像「睡觉」「午休」，含跨零点）：你还没睡或刚醒，语气慵懒、简短；若此刻是你主动给用户发消息，更像「我也还没睡」，而不是刚起床的问候。',
    '- 工作/学习类时间段（名称像「上班」「上学」）：你在忙，回复要简短、像抽空回一句（例如「在忙，晚点细聊」），不要长篇大论。',
    '- 其它时间段（名称由用户自定，如「喝咖啡」）：按名称判断你在做什么，忙碌或专注时回复更短，放松时可以多聊两句。',
    '- 不在任何时间段内：正常自然地聊天。'
  );
  return lines.join('\n');
}

// 作息面板的草稿操作：全部是纯函数（草稿进 → 新草稿出，不改原对象），
// 让「增删时间段 / 改名称与时间 / 调优先级 / 增删概率事件 / 增删节假日」这些
// 面板逻辑可以在 Node 直测，不必渲染 RN 组件。
//
// 草稿形状 = src/chat/schedule.js 的 v2 作息（normalizeSchedule 的输出）。

import { formatTime, parseDateKey, parseTime } from '../../chat/schedule.js';

export const DAY_KINDS = ['workday', 'restday'];

// 新增行的默认值（冻结：面板只读它们再展开成新对象）。
export const NEW_SEGMENT = Object.freeze({ start: '09:00', end: '10:00' });
export const NEW_EVENT = Object.freeze({ kind: 'point', at: '15:00', probability: 50 });

function dayKeyOf(kind) {
  return kind === 'restday' ? 'restday' : 'workday';
}

function dayOf(draft, kind) {
  // 严格认 workday/restday：未知 kind 一律当无效（避免静默改到工作日那套）。
  if (kind !== 'workday' && kind !== 'restday') return null;
  const day = draft && draft[kind];
  return day && typeof day === 'object' ? day : null;
}

function withDay(draft, kind, patch) {
  const key = dayKeyOf(kind);
  return { ...draft, [key]: { ...draft[key], ...patch } };
}

// 生成不与现有行冲突的行 id（稳定、可测；不用随机数，避免同一行每次保存换身份
// ——概率事件的判定种子含 id）。
export function nextRowId(prefix, rows) {
  const used = new Set((Array.isArray(rows) ? rows : []).map(row => String((row && row.id) || '')));
  let index = 1;
  let id = `${prefix}${index}`;
  while (used.has(id)) {
    index += 1;
    id = `${prefix}${index}`;
  }
  return id;
}

export function setEnabled(draft, value) {
  return { ...draft, enabled: value === true };
}

// 开启「区分工作日/休息日」时，若休息日还是空的，先把工作日那套复制过来当起点：
// 否则周末会突然「全天空闲 + 没有概率事件」，用户会以为数据丢了。
// 复制出来的行换新 id（两套各自独立演化，概率种子也各自独立）。
export function setSplitWeekday(draft, value) {
  const next = { ...draft, splitWeekday: value === true };
  const rest = dayOf(next, 'restday');
  const work = dayOf(next, 'workday');
  if (value === true && rest && work && rest.segments.length === 0 && rest.events.length === 0
    && (work.segments.length > 0 || work.events.length > 0)) {
    next.restday = {
      segments: work.segments.map((segment, index) => ({ ...segment, id: `rest-seg${index + 1}` })),
      events: work.events.map((event, index) => ({ ...event, id: `rest-ev${index + 1}` })),
    };
  }
  return next;
}

export function addSegment(draft, kind) {
  const day = dayOf(draft, kind);
  if (!day) return draft;
  const segment = { id: nextRowId('seg', day.segments), name: '', builtin: '', ...NEW_SEGMENT };
  return withDay(draft, kind, { segments: [...day.segments, segment] });
}

export function updateSegment(draft, kind, index, patch) {
  const day = dayOf(draft, kind);
  if (!day || index < 0 || index >= day.segments.length) return draft;
  const segments = day.segments.map((segment, i) => (i === index ? { ...segment, ...patch } : segment));
  return withDay(draft, kind, { segments });
}

export function removeSegment(draft, kind, index) {
  const day = dayOf(draft, kind);
  if (!day || index < 0 || index >= day.segments.length) return draft;
  return withDay(draft, kind, { segments: day.segments.filter((_, i) => i !== index) });
}

// 列表顺序 = 命中优先级（重叠时取第一个命中，见 chat/schedule.js 的判定规则）。
export function moveSegment(draft, kind, index, delta) {
  const day = dayOf(draft, kind);
  if (!day || index < 0 || index >= day.segments.length) return draft;
  const target = index + delta;
  if (target < 0 || target >= day.segments.length) return draft;
  const segments = [...day.segments];
  const [moved] = segments.splice(index, 1);
  segments.splice(target, 0, moved);
  return withDay(draft, kind, { segments });
}

function addOneHour(time) {
  const minutes = parseTime(time);
  if (minutes === null) return '16:00';
  return formatTime((minutes + 60) % (24 * 60));
}

export function addEvent(draft, kind) {
  const day = dayOf(draft, kind);
  if (!day) return draft;
  const event = {
    id: nextRowId('ev', day.events),
    name: '',
    description: '',
    start: '',
    end: '',
    ...NEW_EVENT,
  };
  return withDay(draft, kind, { events: [...day.events, event] });
}

export function updateEvent(draft, kind, index, patch) {
  const day = dayOf(draft, kind);
  if (!day || index < 0 || index >= day.events.length) return draft;
  const events = day.events.map((event, i) => {
    if (i !== index) return event;
    const next = { ...event, ...patch };
    // 切换「时间点 ↔ 时间段」时把另一边的时间搬过来，避免切换后时间字段是空的。
    if (patch.kind === 'range' && event.kind !== 'range') {
      next.start = event.at || NEW_EVENT.at;
      next.end = addOneHour(next.start);
      next.at = '';
    } else if (patch.kind === 'point' && event.kind !== 'point') {
      next.at = event.start || NEW_EVENT.at;
      next.start = '';
      next.end = '';
    }
    return next;
  });
  return withDay(draft, kind, { events });
}

export function removeEvent(draft, kind, index) {
  const day = dayOf(draft, kind);
  if (!day || index < 0 || index >= day.events.length) return draft;
  return withDay(draft, kind, { events: day.events.filter((_, i) => i !== index) });
}

// 加节假日日期（"YYYY-MM-DD"）：非法格式不写入，返回 ok=false 供面板提示。
export function addHoliday(draft, text) {
  const key = parseDateKey(text);
  if (!key) return { ok: false, draft };
  const holidays = Array.isArray(draft.holidays) ? draft.holidays : [];
  if (holidays.includes(key)) return { ok: true, draft };
  return { ok: true, draft: { ...draft, holidays: [...holidays, key].sort() } };
}

export function removeHoliday(draft, key) {
  const holidays = Array.isArray(draft.holidays) ? draft.holidays : [];
  if (!holidays.includes(key)) return draft;
  return { ...draft, holidays: holidays.filter(item => item !== key) };
}

// 角色作息纯逻辑：解析 / 归一 / 时段判断 / 提示词生成。
// 提示词必须是**与具体时间无关的静态文本**——主动消息的请求快照在保存时生成、
// 数天后才触发，若把「此刻是深夜」烘进快照，触发时会说错话。时段判断交给模型
// 结合系统提示里的「当前时间」自行完成。
// 不依赖 RN / 存储，可在 Node 直测。

export const DEFAULT_SCHEDULE = {
  enabled: false,
  wake: '07:00',
  workStart: '09:00',
  workEnd: '18:00',
  sleep: '23:00',
};

const TIME_PATTERN = /^([01]?\d|2[0-3]):([0-5]\d)$/;

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

function normalizeTime(value, fallback) {
  const minutes = parseTime(value);
  return minutes === null ? fallback : formatTime(minutes);
}

export function normalizeSchedule(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    enabled: source.enabled === true,
    wake: normalizeTime(source.wake, DEFAULT_SCHEDULE.wake),
    workStart: normalizeTime(source.workStart, DEFAULT_SCHEDULE.workStart),
    workEnd: normalizeTime(source.workEnd, DEFAULT_SCHEDULE.workEnd),
    sleep: normalizeTime(source.sleep, DEFAULT_SCHEDULE.sleep),
  };
}

// 作息是否可生效：启用且四个时刻都合法。
export function isScheduleActive(schedule) {
  if (!schedule || schedule.enabled !== true) return false;
  return ['wake', 'workStart', 'workEnd', 'sleep'].every(key => parseTime(schedule[key]) !== null);
}

// 判断某时刻处于睡眠 / 工作 / 空闲。睡眠优先于工作（昼夜颠倒的极端配置下不误判）。
export function resolveSchedulePeriod(schedule, date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return 'free';
  const now = d.getHours() * 60 + d.getMinutes();
  const wake = parseTime(schedule && schedule.wake);
  const sleep = parseTime(schedule && schedule.sleep);
  const workStart = parseTime(schedule && schedule.workStart);
  const workEnd = parseTime(schedule && schedule.workEnd);
  if (wake !== null && sleep !== null && inWindow(now, sleep, wake)) return 'sleep';
  if (workStart !== null && workEnd !== null && inWindow(now, workStart, workEnd)) return 'work';
  return 'free';
}

// [start, end) 窗口；start > end 时视为跨零点。
function inWindow(now, start, end) {
  if (start === end) return false;
  if (start < end) return now >= start && now < end;
  return now >= start || now < end;
}

// 供 UI 预览与提示词使用的作息摘要。
export function describeSchedule(schedule) {
  const s = normalizeSchedule(schedule);
  return `起床 ${s.wake} · 上班 ${s.workStart} · 下班 ${s.workEnd} · 睡觉 ${s.sleep}`;
}

// 静态作息规则文本：含四个时刻 + 「按当前时间判断状态」的说明。不含具体时间戳，
// 可安全写入主动消息快照；模型结合系统提示的「当前时间」自行判断时段。
export function buildSchedulePrompt(schedule) {
  if (!isScheduleActive(schedule)) return '';
  return [
    `[角色作息] ${describeSchedule(schedule)}。`,
    '请结合系统提示中的「当前时间」判断你此刻处于什么状态，并据此调整语气与篇幅：',
    '- 睡眠时段（从「睡觉」到次日「起床」，含深夜与凌晨）：你还没睡或刚醒，语气慵懒、简短；若此刻是你主动给用户发消息，更像「我也还没睡」，而不是刚起床的问候。',
    '- 工作时段（「上班」到「下班」之间）：你在忙，回复要简短、像抽空回一句（例如「在忙，晚点细聊」），不要长篇大论。',
    '- 其余清醒时段：正常自然地聊天。',
  ].join('\n');
}

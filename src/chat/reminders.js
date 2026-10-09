// I3：会话提醒（诚实版）——纯函数层。
//
// 语义：给一个会话设「单次 / 每日 HH:MM」的提醒；到点**由应用在前台**弹提示
//（App 不在前台时，下次打开补弹「错过的提醒」——单次过期也会 due 一次）。
// **不做后台自动执行 agent 任务**（裁决 3：Doze/ROM 杀后台下不可靠，不承诺
// 做不到的事）。通知投递分层：本模块只产出「到点了没有」的事实；投递由宿主
// 的 notifier 完成（当前是应用内 Alert；接入 expo-notifications 时只换投递层）。
//
// 防重复：每条提醒带 lastFiredAt——「目标时刻 ≤ now 且本次窗口未弹过」才算 due；
// 每日条目弹后宿主把更新过 lastFiredAt 的清单写回，同一分钟内不会被轮询重复弹。
//
// 时间解析独立实现（不复用 schedule.js 的 parseTime——那是角色作息内部实现，
// 输出形态不同；两者保持独立演进）。

export const REMINDERS_MAX = 10;

// 纯函数：'HH:MM' → { hour, minute }；坏输入（含越界）→ null。
export function parseReminderTime(text) {
  const match = String(text || '').trim().match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!match) return null;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

// 纯函数：提醒描述 → { hour, minute, daily }。
// 形态：'HH:MM'（单次）| '每日 HH:MM' / 'daily HH:MM'（每日）。坏输入 → null。
export function parseReminderSpec(spec) {
  const value = String(spec || '').trim();
  if (!value) return null;
  const dailyMatch = value.match(/^(?:每日|daily)\s+(.+)$/i);
  if (dailyMatch) {
    const time = parseReminderTime(dailyMatch[1]);
    return time ? { ...time, daily: true } : null;
  }
  const time = parseReminderTime(value);
  return time ? { ...time, daily: false } : null;
}

// 纯函数：该提醒「今天」的目标时刻（毫秒）；坏输入 → null。
// 不推明天——due 判定用（daily 到点后今天内一直算已到期，由 lastFiredAt 防重）。
export function reminderTargetAt(reminder, now) {
  const source = reminder && typeof reminder === 'object' ? reminder : null;
  if (!source) return null;
  const hour = Math.floor(Number(source.hour));
  const minute = Math.floor(Number(source.minute));
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }
  const target = new Date(Number(now) || Date.now());
  target.setHours(hour, minute, 0, 0);
  return target.getTime();
}

// 纯函数：到期收集 + 消费。
// 返回 { due, remain }：
//   due   —— 本次要弹的条目（daily 条目带更新后的 lastFiredAt: now）
//   remain —— 弹后应写回的完整清单（单次消费掉；daily 带新 lastFiredAt 留下）
// 判定：target ≤ now 且 lastFiredAt < target（本次窗口未弹过）→ due。
export function collectDueReminders(reminders, now) {
  const list = Array.isArray(reminders) ? reminders : [];
  const at = Number(now) || Date.now();
  const due = [];
  const remain = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const target = reminderTargetAt(item, at);
    if (target === null) continue; // 坏数据：丢弃
    const lastFired = Math.max(0, Math.floor(Number(item.lastFiredAt)) || 0);
    const single = item.daily !== true;
    if (target > at) {
      remain.push(item); // 未到
      continue;
    }
    if (lastFired >= target) {
      // 本窗口已弹过：每日留下（明天同一时刻再响）；单次 = 已消费（不再存）。
      if (!single) remain.push(item);
      continue;
    }
    const fired = { ...item, lastFiredAt: at }; // 到期未弹 → 弹
    due.push(fired);
    if (!single) remain.push(fired);
  }
  return { due, remain };
}

// 纯函数：下一次触发时刻（宿主显示「下次提醒：…」用）。
// daily 永远给未来值（今天已过 → 明天）；单次已过 → null（消费语义）。
export function nextOccurrenceAt(reminder, now) {
  const target = reminderTargetAt(reminder, now);
  if (target === null) return null;
  if (target > (Number(now) || Date.now())) return target;
  if (reminder && reminder.daily === true) return target + 24 * 60 * 60 * 1000;
  return null;
}

// 纯函数：序列化守卫（上限 + 字段收敛）——存取层的唯一入口，坏数据进不来。
export function normalizeReminders(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const chatId = String(item.chatId || '').trim();
    const time = parseReminderTime(
      `${String(item.hour == null ? '' : item.hour).padStart(2, '0')}:${String(item.minute == null ? '' : item.minute).padStart(2, '0')}`
    );
    if (!chatId || !time) continue;
    out.push({
      chatId,
      characterId: String(item.characterId || '').trim(),
      hour: time.hour,
      minute: time.minute,
      daily: item.daily === true,
      note: String(item.note || '').slice(0, 200),
      createdAt: Math.max(0, Math.floor(Number(item.createdAt)) || 0),
      lastFiredAt: Math.max(0, Math.floor(Number(item.lastFiredAt)) || 0),
    });
    if (out.length >= REMINDERS_MAX) break;
  }
  return out;
}

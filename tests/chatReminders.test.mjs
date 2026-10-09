// I3 会话提醒（前台诚实版）纯函数测试：时间解析 / 到期收集（daily 消费与防重复）/ 序列化守卫。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  collectDueReminders,
  nextOccurrenceAt,
  normalizeReminders,
  parseReminderSpec,
  parseReminderTime,
  reminderTargetAt,
  REMINDERS_MAX,
} from '../src/chat/reminders.js';

test('I3 时间解析：HH:MM 严格校验（越界与坏格式拒绝）', () => {
  assert.deepEqual(parseReminderTime('09:30'), { hour: 9, minute: 30 });
  assert.deepEqual(parseReminderTime('23:59'), { hour: 23, minute: 59 });
  assert.deepEqual(parseReminderTime('9:05'), { hour: 9, minute: 5 });
  assert.equal(parseReminderTime('24:00'), null, '小时越界');
  assert.equal(parseReminderTime('09:60'), null, '分钟越界');
  assert.equal(parseReminderTime('9点半'), null);
  assert.equal(parseReminderTime(''), null);
  assert.equal(parseReminderTime(null), null);
});

test('I3 parseReminderSpec：单次 / 每日两种形态', () => {
  assert.deepEqual(parseReminderSpec('09:30'), { hour: 9, minute: 30, daily: false });
  assert.deepEqual(parseReminderSpec('每日 21:00'), { hour: 21, minute: 0, daily: true });
  assert.deepEqual(parseReminderSpec('daily 8:00'), { hour: 8, minute: 0, daily: true });
  assert.deepEqual(parseReminderSpec('每日 25:00'), null, '时间部分仍要过严格校验');
  assert.equal(parseReminderSpec('每日'), null);
  assert.equal(parseReminderSpec(''), null);
});

test('I3 到期收集：单次到期消费 / 未到保留 / 每日弹后留下 / lastFiredAt 防重复', () => {
  // now = 2026-10-10 10:00:00（本地时区）
  const now = new Date(2026, 9, 10, 10, 0, 0).getTime();

  // 单次 09:00 已过 → due 且消费（补弹「错过的提醒」）；11:00 未到 → 保留
  const one = collectDueReminders([
    { chatId: 'c1', hour: 9, minute: 0, daily: false },
    { chatId: 'c2', hour: 11, minute: 0, daily: false },
  ], now);
  assert.deepEqual(one.due.map(item => item.chatId), ['c1'], '单次到期弹（错过也补弹）');
  assert.deepEqual(one.remain.map(item => item.chatId), ['c2'], '未到的保留');

  // 每日 10:00 恰好到点 → due 且留下（lastFiredAt 更新给宿主写回）
  const daily = collectDueReminders([{ chatId: 'c3', hour: 10, minute: 0, daily: true }], now);
  assert.equal(daily.due.length, 1);
  assert.equal(daily.due[0].lastFiredAt, now, '弹后记 firedAt');
  assert.deepEqual(daily.remain.map(item => item.chatId), ['c3'], '每日弹后留下');

  // 防重复：带 lastFiredAt = now 的每日条目，同窗再收集不重复弹
  const again = collectDueReminders(
    [{ chatId: 'c3', hour: 10, minute: 0, daily: true, lastFiredAt: now }],
    now + 10_000
  );
  assert.equal(again.due.length, 0, '本窗口已弹过 → 不重复');
  assert.equal(again.remain.length, 1, '仍保留（明天同一时刻再响）');
  // 跨天到同一时刻 → 又到期
  const tomorrow = collectDueReminders(
    [{ chatId: 'c3', hour: 10, minute: 0, daily: true, lastFiredAt: now }],
    new Date(2026, 9, 11, 10, 0, 30).getTime()
  );
  assert.equal(tomorrow.due.length, 1, '跨天后再次到期');

  // 单次已弹过（lastFiredAt ≥ target）→ 已消费：不再 due 也不保留
  const consumed = collectDueReminders(
    [{ chatId: 'c4', hour: 9, minute: 0, daily: false, lastFiredAt: new Date(2026, 9, 10, 9, 0).getTime() }],
    now
  );
  assert.equal(consumed.due.length, 0);
  assert.equal(consumed.remain.length, 0);

  // 坏数据丢弃
  const bad = collectDueReminders([{ chatId: 'c5', hour: 99 }, null, 'oops'], now);
  assert.deepEqual(bad.due, []);
  assert.deepEqual(bad.remain, []);
});

test('I3 reminderTargetAt / nextOccurrenceAt：时刻与前瞻', () => {
  const now = new Date(2026, 9, 10, 10, 0, 0).getTime();
  assert.equal(reminderTargetAt({ hour: 9, minute: 30 }, now), new Date(2026, 9, 10, 9, 30).getTime(), '今天目标时刻');
  assert.equal(reminderTargetAt({ hour: 25 }, now), null);
  const nextDaily = nextOccurrenceAt({ hour: 9, minute: 0, daily: true }, now);
  assert.equal(nextDaily, new Date(2026, 9, 11, 9, 0).getTime(), '每日给明天');
  assert.equal(nextOccurrenceAt({ hour: 9, minute: 0, daily: false }, now), null, '单次已过 → null（消费）');
  assert.equal(nextOccurrenceAt({ hour: 11, minute: 0 }, now), new Date(2026, 9, 10, 11, 0).getTime(), '单次未到 → 今天');
});

test('I3 normalizeReminders：上限 / 字段收敛 / 坏条目丢弃', () => {
  // 输入是分字段（hour/minute）；序列化把它们收敛成整数（越界条目丢弃）
  const items = Array.from({ length: REMINDERS_MAX + 3 }, (_, i) => ({
    chatId: `c${i}`,
    characterId: 'ch1',
    hour: i,
    minute: 15,
    daily: i % 2 === 0,
    note: `note-${i}`,
    createdAt: 1000 + i,
  }));
  const normalized = normalizeReminders(items);
  assert.equal(normalized.length, REMINDERS_MAX, '超出上限截断');
  assert.deepEqual(normalized[0], {
    chatId: 'c0',
    characterId: 'ch1',
    hour: 0,
    minute: 15,
    daily: true,
    note: 'note-0',
    createdAt: 1000,
    lastFiredAt: 0,
  }, '字段收敛齐全');
  // 越界时间 / 缺 chatId 丢弃
  assert.equal(
    normalizeReminders([{ chatId: 'x', hour: 25, minute: 0 }, { hour: 1, minute: 1 }]).length,
    0
  );
  assert.deepEqual(normalizeReminders(null), []);
  assert.deepEqual(normalizeReminders('oops'), []);
});

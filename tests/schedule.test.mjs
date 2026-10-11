// 角色作息纯逻辑测试（P1 → 2026-10-12 扩展为「可命名时间段 + 概率事件 + 工作日/休息日」）。
// 行为测试：import 真实现直接跑，不做源码字符串断言。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_EVENT_PROBABILITY,
  DEFAULT_SCHEDULE,
  MAX_EVENTS_PER_DAY,
  MAX_SEGMENTS_PER_DAY,
  SCHEDULE_SCHEMA_VERSION,
  activeDayKind,
  buildSchedulePrompt,
  createDefaultSchedule,
  dateKeyOf,
  describeSchedule,
  eventTriggeredOn,
  eventsForDay,
  formatTime,
  hash32,
  isRestDay,
  isScheduleActive,
  migrateSchedule,
  normalizeHolidays,
  normalizeSchedule,
  parseDateKey,
  parseTime,
  resolveDateKey,
  resolveDayEvents,
  resolveScheduleSegment,
  segmentLabel,
  segmentsForDay,
} from '../src/chat/schedule.js';

const at = (h, m) => new Date(2026, 9, 7, h, m, 0); // 2026-10-07 是周三（工作日）

const seg = (start, end, over = {}) => ({ id: `${start}-${end}`, name: '', builtin: '', start, end, ...over });
const ev = (over = {}) => ({ id: 'e1', name: '', kind: 'point', at: '15:00', start: '', end: '', probability: 50, description: '去楼下买咖啡', ...over });

// 一份 v2 作息：工作日 睡眠 23:00–07:00 / 工作 09:00–18:00，休息日只有「睡懒觉」。
const v2 = (over = {}) => normalizeSchedule({
  schema: 2,
  enabled: true,
  splitWeekday: false,
  workday: { segments: [seg('23:00', '07:00', { builtin: 'sleep' }), seg('09:00', '18:00', { builtin: 'work' })], events: [] },
  restday: { segments: [], events: [] },
  holidays: [],
  ...over,
});

// v1（旧模型）的参考实现：作为迁移等价性的对照物，直接抄自 d1011d4 的 src/chat/schedule.js。
function legacyPeriod(legacy, date) {
  const now = date.getHours() * 60 + date.getMinutes();
  const inWindow = (n, start, end) => {
    if (start === end) return false;
    if (start < end) return n >= start && n < end;
    return n >= start || n < end;
  };
  const wake = parseTime(legacy.wake);
  const sleep = parseTime(legacy.sleep);
  const workStart = parseTime(legacy.workStart);
  const workEnd = parseTime(legacy.workEnd);
  if (wake !== null && sleep !== null && inWindow(now, sleep, wake)) return 'sleep';
  if (workStart !== null && workEnd !== null && inWindow(now, workStart, workEnd)) return 'work';
  return 'free';
}

test('parseTime / formatTime：合法解析与格式化，非法返回空', () => {
  assert.equal(parseTime('07:05'), 425);
  assert.equal(parseTime('7:05'), 425);
  assert.equal(parseTime('23:59'), 1439);
  assert.equal(parseTime('24:00'), null);
  assert.equal(parseTime('12:60'), null);
  assert.equal(parseTime('abc'), null);
  assert.equal(formatTime(425), '07:05');
  assert.equal(formatTime(1439), '23:59');
  assert.equal(formatTime(-1), '');
  assert.equal(formatTime(1440), '');
});

test('parseDateKey / dateKeyOf / resolveDateKey：日期键本地时区解析与校验', () => {
  assert.equal(parseDateKey('2026-10-07'), '2026-10-07');
  assert.equal(parseDateKey(' 2026-10-07 '), '2026-10-07');
  assert.equal(parseDateKey('2026-02-30'), '', '不存在的日期被拒');
  assert.equal(parseDateKey('2026-13-01'), '');
  assert.equal(parseDateKey('26-10-07'), '');
  assert.equal(parseDateKey(''), '');
  assert.equal(parseDateKey(null), '');
  assert.equal(dateKeyOf(new Date(2026, 9, 7, 0, 5)), '2026-10-07', '用本地日期，不受时区偏移影响');
  assert.equal(dateKeyOf(new Date('nope')), '');
  assert.equal(resolveDateKey('2026-10-07'), '2026-10-07');
  assert.equal(resolveDateKey(new Date(2026, 9, 7, 23, 59)), '2026-10-07');
  assert.equal(resolveDateKey(undefined), '');
});

test('hash32：确定性且对输入敏感（概率种子的基础）', () => {
  assert.equal(hash32('abc'), hash32('abc'));
  assert.notEqual(hash32('abc'), hash32('abd'));
  assert.ok(hash32('') >= 0 && hash32('') < 2 ** 32);
});

test('migrateSchedule：旧四时刻 → 新模型，字段落位正确且带 schema 版本号', () => {
  const migrated = migrateSchedule({ enabled: true, wake: '06:30', workStart: '09:00', workEnd: '18:00', sleep: '23:30' });
  assert.equal(migrated.schema, SCHEDULE_SCHEMA_VERSION);
  assert.equal(migrated.enabled, true);
  assert.equal(migrated.splitWeekday, false);
  assert.deepEqual(
    migrated.workday.segments.map(s => [s.builtin, s.start, s.end]),
    [['sleep', '23:30', '06:30'], ['work', '09:00', '18:00']]
  );
  assert.deepEqual(migrated.workday.events, []);
  assert.deepEqual(migrated.holidays, []);
});

test('migrateSchedule：幂等——迁移结果再迁移不变（schema 版本号拦住二次迁移）', () => {
  const once = migrateSchedule({ enabled: true, wake: '06:30', workStart: '09:00', workEnd: '18:00', sleep: '23:30' });
  const twice = migrateSchedule(once);
  assert.deepEqual(twice, once);
  // 归一化也幂等
  assert.deepEqual(normalizeSchedule(normalizeSchedule(once)), normalizeSchedule(once));
});

test('迁移等价性：旧模型每一分钟的状态与新模型逐点一致（含跨零点与睡眠优先）', () => {
  const cases = [
    { enabled: true, wake: '07:00', workStart: '09:00', workEnd: '18:00', sleep: '23:00' },
    { enabled: true, wake: '07:00', workStart: '09:00', workEnd: '18:00', sleep: '01:00' }, // 睡眠早于起床
    { enabled: true, wake: '12:00', workStart: '06:00', workEnd: '14:00', sleep: '23:00' }, // 睡眠与工作重叠
    { enabled: true, wake: '00:00', workStart: '00:00', workEnd: '23:59', sleep: '23:59' },
    { enabled: false, wake: '05:00', workStart: '08:00', workEnd: '20:00', sleep: '22:00' },
  ];
  for (const legacy of cases) {
    const migrated = normalizeSchedule(legacy);
    for (let minutes = 0; minutes < 24 * 60; minutes += 1) {
      const date = new Date(2026, 9, 7, Math.floor(minutes / 60), minutes % 60);
      const expected = legacyPeriod(legacy, date);
      const segment = resolveScheduleSegment(migrated, date);
      const actual = segment ? segment.builtin : 'free';
      assert.equal(actual, expected, `${JSON.stringify(legacy)} 在 ${formatTime(minutes)} 应为 ${expected}`);
    }
  }
});

test('迁移等价性：睡眠段必须排在「工作」之前，否则重叠时优先级翻转（回归钉）', () => {
  // 睡眠 23:00–07:00 与工作 06:00–14:00 在 06:00–07:00 重叠：
  // v1 里睡眠优先，故迁移结果也必须睡眠优先。把两段对调就会红。
  const legacy = { enabled: true, wake: '07:00', workStart: '06:00', workEnd: '14:00', sleep: '23:00' };
  const migrated = normalizeSchedule(legacy);
  assert.equal(resolveScheduleSegment(migrated, at(6, 30)).builtin, 'sleep');
  const swapped = normalizeSchedule({ ...migrated, workday: { segments: [...migrated.workday.segments].reverse() } });
  assert.equal(resolveScheduleSegment(swapped, at(6, 30)).builtin, 'work', '顺序确实决定重叠命中');
});

test('normalizeSchedule：无作息返回默认（等价旧默认四时刻），显式空作息保持为空', () => {
  const fallback = normalizeSchedule(null);
  assert.equal(fallback.schema, SCHEDULE_SCHEMA_VERSION);
  assert.deepEqual(fallback.workday.segments.map(s => [s.start, s.end]), [['23:00', '07:00'], ['09:00', '18:00']]);
  assert.deepEqual(normalizeSchedule(undefined), fallback);
  assert.deepEqual(normalizeSchedule({}), fallback, '空对象视为没有作息');
  // 用户把段删光的 v2 对象不能被当成旧模型又填回默认段
  const emptied = normalizeSchedule({ schema: 2, enabled: true, workday: { segments: [], events: [] } });
  assert.deepEqual(emptied.workday.segments, []);
});

test('normalizeSchedule：非法/零长度时间段被丢弃，合法段保留原名与跨零点', () => {
  const s = normalizeSchedule({
    schema: 2,
    workday: {
      segments: [
        { name: '上学', start: '08:00', end: '12:00' },
        { name: '喝咖啡', start: '15:00', end: '15:30' },
        { name: '坏的', start: '25:00', end: '12:00' },
        { name: '零长度', start: '10:00', end: '10:00' },
        { name: '夜班', start: '23:00', end: '07:00' },
      ],
    },
  });
  assert.deepEqual(s.workday.segments.map(x => x.name), ['上学', '喝咖啡', '夜班']);
  assert.equal(s.workday.segments[2].start, '23:00');
  assert.equal(s.workday.segments[2].end, '07:00');
  assert.ok(s.workday.segments.every(x => x.id), '每段都有稳定 id（概率种子/React key 用）');
});

test('normalizeSchedule：名称去换行并截断，容量有上限', () => {
  const long = 'x'.repeat(200);
  const s = normalizeSchedule({
    schema: 2,
    workday: {
      segments: [{ name: `上\n学  ${long}`, start: '08:00', end: '12:00' }],
      events: Array.from({ length: MAX_EVENTS_PER_DAY + 5 }, (_, i) => ({ at: '10:00', description: `事${i}` })),
    },
  });
  assert.equal(s.workday.segments[0].name.includes('\n'), false, '换行会破坏提示词分行');
  assert.ok(s.workday.segments[0].name.length <= 24);
  assert.equal(s.workday.events.length, MAX_EVENTS_PER_DAY);
  const many = normalizeSchedule({
    schema: 2,
    workday: { segments: Array.from({ length: MAX_SEGMENTS_PER_DAY + 3 }, (_, i) => ({ start: '01:00', end: '02:00', name: `s${i}` })) },
  });
  assert.equal(many.workday.segments.length, MAX_SEGMENTS_PER_DAY);
});

test('normalizeSchedule：概率事件只收有描述且时间合法的行，概率夹到 0–100', () => {
  const s = normalizeSchedule({
    schema: 2,
    workday: {
      events: [
        { kind: 'point', at: '15:00', description: '去楼下买咖啡', probability: 30 },
        { kind: 'range', start: '20:00', end: '23:00', description: '看书', probability: 120 },
        { kind: 'point', at: '09:00', description: '' }, // 没有「要做什么」→ 丢弃
        { kind: 'point', at: '99:00', description: '无效时间' },
        { kind: 'point', at: '12:00', description: '缺概率' },
      ],
    },
  });
  assert.deepEqual(s.workday.events.map(e => e.description), ['去楼下买咖啡', '看书', '缺概率']);
  assert.equal(s.workday.events[0].probability, 30);
  assert.equal(s.workday.events[1].probability, 100, '超上限夹到 100');
  assert.equal(s.workday.events[2].probability, DEFAULT_EVENT_PROBABILITY, '缺省给默认概率');
  // 面板的概率输入框被清空时传的是空串：Number('') === 0，不特判会让事件静默永不发生
  assert.equal(normalizeSchedule({ schema: 2, workday: { events: [{ at: '12:00', description: 'x', probability: '' }] } }).workday.events[0].probability, DEFAULT_EVENT_PROBABILITY);
  assert.equal(normalizeSchedule({ schema: 2, workday: { events: [{ at: '12:00', description: 'x', probability: -5 }] } }).workday.events[0].probability, 0);
});

test('normalizeHolidays：只留合法日期键，去重升序（顺序稳定 = 提示词稳定）', () => {
  assert.deepEqual(
    normalizeHolidays(['2026-10-02', '2026-01-01', '2026-10-02', 'bad', '', null, '2026-02-30']),
    ['2026-01-01', '2026-10-02']
  );
  assert.deepEqual(normalizeHolidays('2026-01-01'), []);
});

test('isScheduleActive：启用且有可用内容；未启用或空作息不生效', () => {
  assert.equal(isScheduleActive(v2()), true);
  assert.equal(isScheduleActive({ ...v2(), enabled: false }), false);
  assert.equal(isScheduleActive(null), false);
  assert.equal(isScheduleActive({ schema: 2, enabled: true, workday: { segments: [], events: [] } }), false, '空作息不生效');
  // 只有概率事件、没有时间段时依然生效（会附带当前时间让模型判断）
  assert.equal(isScheduleActive({ schema: 2, enabled: true, workday: { segments: [], events: [ev()] } }), true);
});

test('resolveScheduleSegment：工作 / 空闲 / 睡眠（含跨零点）', () => {
  const s = v2();
  assert.equal(resolveScheduleSegment(s, at(10, 0)).builtin, 'work');
  assert.equal(resolveScheduleSegment(s, at(20, 0)), null, '空档 = 空闲');
  assert.equal(resolveScheduleSegment(s, at(23, 30)).builtin, 'sleep');
  assert.equal(resolveScheduleSegment(s, at(3, 0)).builtin, 'sleep');
  assert.equal(resolveScheduleSegment(s, at(7, 0)), null, '起床即离开睡眠');
  assert.equal(resolveScheduleSegment(s, at(18, 0)), null, '下班即离开工作');
  assert.equal(resolveScheduleSegment(s, new Date('nope')), null);
});

test('resolveScheduleSegment：重叠按列表顺序取第一个命中（可测的显式规则）', () => {
  const s = normalizeSchedule({
    schema: 2,
    enabled: true,
    workday: {
      segments: [
        { name: '喝咖啡', start: '15:00', end: '15:30' },
        { name: '上班', start: '09:00', end: '18:00' },
      ],
    },
  });
  assert.equal(resolveScheduleSegment(s, at(15, 10)).name, '喝咖啡', '先列出的段优先');
  const reversed = normalizeSchedule({
    schema: 2,
    enabled: true,
    workday: { segments: [...s.workday.segments].reverse() },
  });
  assert.equal(resolveScheduleSegment(reversed, at(15, 10)).name, '上班', '顺序确实决定重叠命中');
});

test('resolveScheduleSegment：任意自定义名称与跨零点区间都能命中', () => {
  const s = normalizeSchedule({
    schema: 2,
    enabled: true,
    workday: {
      segments: [
        { name: '上学', start: '08:00', end: '12:00' },
        { name: '喝咖啡', start: '15:00', end: '15:30' },
        { name: '夜班', start: '23:00', end: '07:00' },
      ],
    },
  });
  assert.equal(resolveScheduleSegment(s, at(9, 0)).name, '上学');
  assert.equal(resolveScheduleSegment(s, at(15, 29)).name, '喝咖啡');
  assert.equal(resolveScheduleSegment(s, at(15, 30)), null, '区间右端开区间');
  assert.equal(resolveScheduleSegment(s, at(0, 30)).name, '夜班');
  assert.equal(resolveScheduleSegment(s, at(23, 0)).name, '夜班');
  assert.equal(resolveScheduleSegment(s, at(7, 0)), null);
});

test('工作日 / 休息日：周末与用户假日都算休息日，未开启分套时恒用工作日那套', () => {
  const weekday = new Date(2026, 9, 7); // 周三
  const saturday = new Date(2026, 9, 10);
  const sunday = new Date(2026, 9, 11);
  const holiday = new Date(2026, 9, 8); // 周四，但被设为节假日
  const s = normalizeSchedule({
    schema: 2,
    enabled: true,
    splitWeekday: true,
    workday: { segments: [seg('09:00', '18:00', { name: '上班' })] },
    restday: { segments: [seg('10:00', '12:00', { name: '睡懒觉' })] },
    holidays: ['2026-10-08'],
  });
  assert.equal(isRestDay(s, weekday), false);
  assert.equal(isRestDay(s, saturday), true);
  assert.equal(isRestDay(s, sunday), true);
  assert.equal(isRestDay(s, holiday), true, '用户假日列表里的日期算休息日');
  assert.equal(activeDayKind(s, weekday), 'workday');
  assert.equal(activeDayKind(s, saturday), 'restday');
  assert.equal(activeDayKind(s, holiday), 'restday');
  assert.equal(resolveScheduleSegment(s, new Date(2026, 9, 7, 10, 0)).name, '上班');
  assert.equal(resolveScheduleSegment(s, new Date(2026, 9, 10, 10, 30)).name, '睡懒觉');
  assert.equal(resolveScheduleSegment(s, new Date(2026, 9, 8, 10, 30)).name, '睡懒觉', '节假日走休息日那套');
  // 未开启分套：周末也走工作日那套
  const flat = normalizeSchedule({ ...s, splitWeekday: false });
  assert.equal(activeDayKind(flat, saturday), 'workday');
  assert.equal(resolveScheduleSegment(flat, new Date(2026, 9, 10, 10, 30)).name, '上班');
  assert.deepEqual(segmentsForDay(flat, saturday), flat.workday.segments);
});

test('isRestDay：非法日期不算休息日；假日列表按角色独立', () => {
  const s = normalizeSchedule({ schema: 2, enabled: true, holidays: ['2026-10-08'] });
  assert.equal(isRestDay(s, new Date('nope')), false);
  assert.equal(isRestDay(s, '2026-10-08'), true, '日期键直接可用');
  assert.equal(isRestDay(s, '2026-10-09'), false);
  assert.equal(isRestDay(null, new Date(2026, 9, 7)), false);
});

test('事件判定确定性：同一天恒定、跨天变化、与角色绑定', () => {
  const s = normalizeSchedule({ schema: 2, enabled: true, workday: { segments: [], events: [ev({ probability: 50 })] } });
  const event = s.workday.events[0];
  const first = eventTriggeredOn(s, event, '2026-10-07', 'c1');
  for (let i = 0; i < 5; i += 1) {
    assert.equal(eventTriggeredOn(s, event, '2026-10-07', 'c1'), first, '同一天内必须恒定');
  }
  assert.equal(eventTriggeredOn(s, event, new Date(2026, 9, 7, 23, 59), 'c1'), first, '同一天的不同时刻结果一致');
  // 跨天必须真的会变（否则概率事件形同虚设）
  const days = Array.from({ length: 60 }, (_, i) => eventTriggeredOn(s, event, dateKeyOf(new Date(2026, 0, 1 + i)), 'c1'));
  assert.ok(days.some(Boolean) && days.some(v => !v), '60 天里既有发生也有不发生');
  // 不同角色同一天可以不同
  const other = Array.from({ length: 40 }, (_, i) => eventTriggeredOn(s, event, dateKeyOf(new Date(2026, 0, 1 + i)), 'c2'));
  assert.notDeepEqual(other, days.slice(0, 40), '种子含角色 id');
});

test('事件判定边界：概率 0 永不发生、100 必然发生', () => {
  const base = { schema: 2, enabled: true, workday: { segments: [], events: [] } };
  const never = normalizeSchedule({ ...base, workday: { segments: [], events: [ev({ probability: 0 })] } }).workday.events[0];
  const always = normalizeSchedule({ ...base, workday: { segments: [], events: [ev({ probability: 100 })] } }).workday.events[0];
  for (let i = 0; i < 40; i += 1) {
    const key = dateKeyOf(new Date(2026, 0, 1 + i));
    assert.equal(eventTriggeredOn(base, never, key, 'c1'), false);
    assert.equal(eventTriggeredOn(base, always, key, 'c1'), true);
  }
});

test('事件判定分布：约等于设定概率（种子没有偏到一边）', () => {
  const s = normalizeSchedule({ schema: 2, enabled: true, workday: { segments: [], events: [ev({ probability: 30 })] } });
  const event = s.workday.events[0];
  let hits = 0;
  const total = 2000;
  for (let i = 0; i < total; i += 1) {
    if (eventTriggeredOn(s, event, dateKeyOf(new Date(2020, 0, 1 + i)), 'char-1')) hits += 1;
  }
  const rate = hits / total;
  assert.ok(Math.abs(rate - 0.3) < 0.04, `实测 ${rate}，应接近 0.30`);
});

test('resolveDayEvents：只返回当天会发生的那些事件，休息日走另一套', () => {
  const s = normalizeSchedule({
    schema: 2,
    enabled: true,
    splitWeekday: true,
    workday: { segments: [], events: [ev({ id: 'a', at: '15:00', description: '买咖啡', probability: 100 }), ev({ id: 'b', at: '16:00', description: '散步', probability: 0 })] },
    restday: { segments: [], events: [ev({ id: 'c', at: '11:00', description: '爬山', probability: 100 })] },
  });
  const weekday = resolveDayEvents(s, '2026-10-07', 'c1');
  assert.deepEqual(weekday.map(e => e.description), ['买咖啡']);
  const weekend = resolveDayEvents(s, '2026-10-10', 'c1');
  assert.deepEqual(weekend.map(e => e.description), ['爬山']);
  assert.deepEqual(eventsForDay(s, '2026-10-10').map(e => e.description), ['爬山']);
});

test('eventTriggeredOn：非法事件/日期返回 false（不抛）', () => {
  const s = v2();
  assert.equal(eventTriggeredOn(s, null, '2026-10-07', 'c1'), false);
  assert.equal(eventTriggeredOn(s, ev(), 'nope', 'c1'), false);
  assert.equal(eventTriggeredOn(s, ev({ description: '' }), '2026-10-07', 'c1'), false);
});

test('segmentLabel / describeSchedule：自定义名称优先，内置段回退中文词条', () => {
  assert.equal(segmentLabel({ name: '上学', builtin: '' }), '上学');
  assert.equal(segmentLabel({ name: '', builtin: 'sleep' }), '睡眠');
  assert.equal(segmentLabel({ name: '', builtin: '' }), '时段');
  const text = describeSchedule(v2());
  assert.ok(text.includes('睡眠 23:00–07:00'));
  assert.ok(text.includes('工作 09:00–18:00'));
  assert.equal(text.includes('休息日'), false, '未开启分套时不提休息日');
  const split = describeSchedule(v2({ splitWeekday: true, restday: { segments: [seg('10:00', '12:00', { name: '睡懒觉' })], events: [] } }));
  assert.ok(split.includes('工作日：') && split.includes('休息日：睡懒觉 10:00–12:00'));
  assert.ok(describeSchedule({ schema: 2, enabled: true, workday: { segments: [], events: [] } }).includes('无固定安排'));
});

test('buildSchedulePrompt：未启用为空', () => {
  assert.equal(buildSchedulePrompt({ ...v2(), enabled: false }), '');
  assert.equal(buildSchedulePrompt(null), '');
  assert.equal(buildSchedulePrompt({ schema: 2, enabled: true, workday: { segments: [], events: [] } }), '');
});

test('buildSchedulePrompt：静态规则含自定义名称与通用判定说明，不含日期', () => {
  const s = normalizeSchedule({
    schema: 2,
    enabled: true,
    workday: { segments: [seg('08:00', '12:00', { name: '上学' }), seg('15:00', '15:30', { name: '喝咖啡' })], events: [] },
  });
  const text = buildSchedulePrompt(s);
  assert.ok(text.includes('上学 08:00–12:00'));
  assert.ok(text.includes('喝咖啡 15:00–15:30'));
  assert.ok(text.includes('睡眠/休息类时间段'));
  assert.ok(text.includes('工作/学习类时间段'));
  assert.ok(text.includes('我也还没睡'));
  assert.ok(text.includes('在忙'));
  assert.equal(/20\d\d-\d\d-\d\d/.test(text), false, '不传日期时不含任何日期');
});

test('buildSchedulePrompt：不传日期时逐字节稳定（主动消息快照契约）', () => {
  const s = normalizeSchedule({
    schema: 2,
    enabled: true,
    splitWeekday: true,
    workday: { segments: [seg('09:00', '18:00', { name: '上班' })], events: [ev({ probability: 50 })] },
    restday: { segments: [seg('10:00', '12:00', { name: '睡懒觉' })], events: [ev({ id: 'r1', at: '11:00', description: '爬山', probability: 50 })] },
  });
  const first = buildSchedulePrompt(s);
  assert.equal(buildSchedulePrompt(s), first);
  assert.equal(buildSchedulePrompt(s, {}), first);
  assert.equal(buildSchedulePrompt(s, { characterId: 'c1' }), first, '不带日期时角色 id 不影响结果');
  assert.equal(/20\d\d-\d\d-\d\d/.test(first), false);
  // 快照里必须带上两套作息与事件定义（不声称今天发生什么）
  assert.ok(first.includes('工作日：上班 09:00–18:00'));
  assert.ok(first.includes('休息日：睡懒觉 10:00–12:00'));
  assert.ok(first.includes('概率事件'));
  assert.ok(first.includes('去楼下买咖啡（约 50%）'));
  assert.equal(first.includes('今天会发生'), false);
});

test('buildSchedulePrompt：传日期时同一天内逐字节一致，跨天才变', () => {
  const s = normalizeSchedule({
    schema: 2,
    enabled: true,
    splitWeekday: true,
    workday: { segments: [seg('09:00', '18:00', { name: '上班' })], events: [ev({ probability: 50 })] },
    restday: { segments: [], events: [] },
  });
  const morning = buildSchedulePrompt(s, { date: new Date(2026, 9, 7, 8, 0), characterId: 'c1' });
  const night = buildSchedulePrompt(s, { date: new Date(2026, 9, 7, 23, 30), characterId: 'c1' });
  assert.equal(morning, night, '同一天内多次构建必须逐字节一致（缓存前缀不能每轮变）');
  assert.equal(buildSchedulePrompt(s, { date: '2026-10-07', characterId: 'c1' }), morning);
  assert.ok(morning.includes('[今天] 今天是工作日'));
  const weekend = buildSchedulePrompt(s, { date: '2026-10-10', characterId: 'c1' });
  assert.ok(weekend.includes('[今天] 今天是休息日'));
  assert.notEqual(weekend, morning);
  // 概率事件按天解析：换一天结果可能不同，但同一天恒定
  const sameDay = buildSchedulePrompt(s, { date: '2026-10-07', characterId: 'c1' });
  assert.equal(sameDay, morning);
});

test('buildSchedulePrompt：假日走休息日；未开启分套时不出现「今天」行', () => {
  const split = normalizeSchedule({
    schema: 2,
    enabled: true,
    splitWeekday: true,
    workday: { segments: [seg('09:00', '18:00', { name: '上班' })], events: [] },
    restday: { segments: [seg('10:00', '12:00', { name: '睡懒觉' })], events: [] },
    holidays: ['2026-10-08'],
  });
  assert.ok(buildSchedulePrompt(split, { date: '2026-10-08' }).includes('今天是休息日'));
  const flat = normalizeSchedule({ ...split, splitWeekday: false });
  assert.equal(buildSchedulePrompt(flat, { date: '2026-10-10' }).includes('[今天]'), false);
});

test('buildSchedulePrompt：概率事件当天的「会发生 / 都不发生」两态都能出现', () => {
  const s = normalizeSchedule({
    schema: 2,
    enabled: true,
    workday: { segments: [], events: [ev({ probability: 50 })] },
  });
  const texts = Array.from({ length: 40 }, (_, i) => buildSchedulePrompt(s, { date: dateKeyOf(new Date(2026, 0, 1 + i)), characterId: 'c1' }));
  assert.ok(texts.some(t => t.includes('今天会发生')), '存在「今天会发生」的日子');
  assert.ok(texts.some(t => t.includes('今天这些事都不会发生')), '存在「都不发生」的日子');
  texts.forEach(text => assert.equal(/20\d\d-\d\d-\d\d/.test(text), false, '规则文本不含具体日期'));
});

test('DEFAULT_SCHEDULE 是深冻结的默认值，createDefaultSchedule 每次返回新对象', () => {
  assert.equal(Object.isFrozen(DEFAULT_SCHEDULE), true);
  assert.equal(Object.isFrozen(DEFAULT_SCHEDULE.workday.segments), true);
  const a = createDefaultSchedule();
  const b = createDefaultSchedule();
  assert.notEqual(a, b);
  assert.notEqual(a.workday.segments, b.workday.segments);
  a.workday.segments.push(seg('01:00', '02:00'));
  assert.equal(b.workday.segments.length, 2, '两次默认值互不影响');
});

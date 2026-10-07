// 角色作息纯逻辑测试（P1）。行为测试：import 真实现直接跑。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSchedulePrompt,
  DEFAULT_SCHEDULE,
  describeSchedule,
  formatTime,
  isScheduleActive,
  normalizeSchedule,
  parseTime,
  resolveSchedulePeriod,
} from '../src/chat/schedule.js';

const at = (h, m) => new Date(2026, 9, 7, h, m, 0);
const schedule = (over = {}) => normalizeSchedule({
  enabled: true,
  wake: '07:00',
  workStart: '09:00',
  workEnd: '18:00',
  sleep: '23:00',
  ...over,
});

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

test('normalizeSchedule：非法字段回退默认，enabled 取布尔', () => {
  const s = normalizeSchedule({ enabled: 'yes', wake: '25:00', workStart: '9:5', sleep: '' });
  assert.equal(s.enabled, false, 'enabled 非 true 即 false');
  assert.equal(s.wake, DEFAULT_SCHEDULE.wake);
  assert.equal(s.workStart, DEFAULT_SCHEDULE.workStart, '单位数小时不允许（9:5）');
  assert.equal(s.sleep, DEFAULT_SCHEDULE.sleep);
  assert.equal(normalizeSchedule(null).wake, '07:00');
});

test('isScheduleActive：启用且四时刻合法', () => {
  assert.equal(isScheduleActive(schedule()), true);
  assert.equal(isScheduleActive({ ...schedule(), enabled: false }), false);
  assert.equal(isScheduleActive(null), false);
  assert.equal(isScheduleActive({ enabled: true, wake: 'x' }), false);
});

test('resolveSchedulePeriod：工作 / 空闲 / 睡眠（含跨零点）', () => {
  const s = schedule();
  assert.equal(resolveSchedulePeriod(s, at(10, 0)), 'work');
  assert.equal(resolveSchedulePeriod(s, at(20, 0)), 'free');
  assert.equal(resolveSchedulePeriod(s, at(23, 30)), 'sleep');
  assert.equal(resolveSchedulePeriod(s, at(3, 0)), 'sleep');
  assert.equal(resolveSchedulePeriod(s, at(7, 0)), 'free', '起床即离开睡眠');
  assert.equal(resolveSchedulePeriod(s, at(18, 0)), 'free', '下班即离开工作');
});

test('resolveSchedulePeriod：睡觉早于起床时不误判', () => {
  const s = schedule({ sleep: '01:00', wake: '07:00' });
  assert.equal(resolveSchedulePeriod(s, at(2, 0)), 'sleep');
  assert.equal(resolveSchedulePeriod(s, at(10, 0)), 'work');
  assert.equal(resolveSchedulePeriod(s, at(23, 0)), 'free');
});

test('describeSchedule：含四个时刻', () => {
  const text = describeSchedule(schedule());
  assert.ok(text.includes('07:00') && text.includes('09:00') && text.includes('18:00') && text.includes('23:00'));
});

test('buildSchedulePrompt：启用时含作息与时段规则，未启用为空', () => {
  const text = buildSchedulePrompt(schedule());
  assert.ok(text.includes('起床 07:00'));
  assert.ok(text.includes('睡眠时段'));
  assert.ok(text.includes('工作时段'));
  assert.ok(text.includes('我也还没睡'));
  assert.ok(text.includes('在忙'));
  // 静态文本：不含具体日期/时间戳（避免主动消息快照过期）
  assert.equal(/20\d\d-\d\d-\d\d/.test(text), false);
  assert.equal(buildSchedulePrompt({ ...schedule(), enabled: false }), '');
  assert.equal(buildSchedulePrompt(null), '');
});

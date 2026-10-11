// 作息面板的草稿操作与预览文本测试（纯函数，Node 直测）。
// 面板本身是 RN 组件（本仓无渲染器），所以把「增删改 / 调优先级 / 节假日增删 /
// 预览文案」这些逻辑抽到 src/extension/schedule/ 下的纯模块，在这里钉行为。
// t 用真实现的 translate（zh-CN），不用假对象。
import test from 'node:test';
import assert from 'node:assert/strict';

import { translate } from '../src/i18n/index.js';
import { createDefaultSchedule, normalizeSchedule } from '../src/chat/schedule.js';
import {
  addEvent,
  addHoliday,
  addSegment,
  moveSegment,
  nextRowId,
  removeEvent,
  removeHoliday,
  removeSegment,
  setEnabled,
  setSplitWeekday,
  updateEvent,
  updateSegment,
} from '../src/extension/schedule/draftOps.js';
import { currentPeriodText, schedulePreviewLines, segmentLabelText } from '../src/extension/schedule/preview.js';

const t = (key, params) => translate('zh-CN', key, params);

const draft = () => normalizeSchedule({
  schema: 2,
  enabled: true,
  workday: { segments: [{ id: 'sleep', builtin: 'sleep', start: '23:00', end: '07:00' }], events: [] },
  restday: { segments: [], events: [] },
  holidays: [],
});

test('nextRowId：避开已有 id，结果可复现（同一行不会每次保存换身份）', () => {
  assert.equal(nextRowId('seg', []), 'seg1');
  assert.equal(nextRowId('seg', [{ id: 'seg1' }, { id: 'seg2' }]), 'seg3');
  assert.equal(nextRowId('seg', [{ id: 'seg1' }, { id: 'seg3' }]), 'seg2');
  assert.equal(nextRowId('seg', [{ id: 'seg1' }]), nextRowId('seg', [{ id: 'seg1' }]));
});

test('setEnabled：只改开关，返回新对象', () => {
  const before = draft();
  const after = setEnabled(before, true);
  assert.equal(after.enabled, true);
  assert.equal(setEnabled(before, 'yes').enabled, false, '非 true 即 false');
  assert.notEqual(after, before);
  assert.equal(before.enabled, true, '原草稿不被改');
});

test('setSplitWeekday：首次开启时把工作日那套复制成休息日起点（避免周末突然全空）', () => {
  const before = draft();
  const on = setSplitWeekday(before, true);
  assert.equal(on.splitWeekday, true);
  assert.deepEqual(on.restday.segments.map(s => [s.start, s.end]), [['23:00', '07:00']]);
  assert.notEqual(on.restday.segments[0].id, 'sleep', '复制出来的行换新 id');
  assert.equal(before.restday.segments.length, 0, '原草稿不被改');
  // 已有休息日内容时不再覆盖
  const customized = { ...on, restday: { segments: [{ id: 'x', name: '睡懒觉', start: '10:00', end: '12:00' }], events: [] } };
  assert.equal(setSplitWeekday(customized, true).restday.segments[0].name, '睡懒觉');
  // 关掉开关不丢休息日数据（再开回来还在）
  const off = setSplitWeekday(customized, false);
  assert.equal(off.splitWeekday, false);
  assert.equal(off.restday.segments.length, 1);
});

test('时间段增删改：不可变、越界安全、名称与跨零点时间可改', () => {
  const before = draft();
  const added = addSegment(before, 'workday');
  assert.equal(added.workday.segments.length, 2);
  assert.equal(before.workday.segments.length, 1, '原草稿不被改');
  const newIndex = 1;
  const named = updateSegment(added, 'workday', newIndex, { name: '喝咖啡', start: '15:00', end: '15:30' });
  assert.deepEqual(
    [named.workday.segments[newIndex].name, named.workday.segments[newIndex].start, named.workday.segments[newIndex].end],
    ['喝咖啡', '15:00', '15:30']
  );
  const cross = updateSegment(named, 'workday', newIndex, { start: '23:00', end: '07:00' });
  assert.equal(normalizeSchedule(cross).workday.segments[newIndex].start, '23:00');
  assert.equal(removeSegment(cross, 'workday', newIndex).workday.segments.length, 1);
  // 越界与非法 kind 一律原样返回（不抛）
  assert.equal(updateSegment(before, 'workday', 9, { name: 'x' }), before);
  assert.equal(removeSegment(before, 'workday', -1), before);
  assert.equal(addSegment(before, 'nope').workday.segments.length, 1);
});

test('moveSegment：调整命中优先级（重叠时取第一个命中）', () => {
  const base = normalizeSchedule({
    schema: 2,
    enabled: true,
    workday: {
      segments: [
        { id: 'a', name: 'A', start: '09:00', end: '18:00' },
        { id: 'b', name: 'B', start: '15:00', end: '16:00' },
      ],
    },
  });
  const moved = moveSegment(base, 'workday', 1, -1);
  assert.deepEqual(moved.workday.segments.map(s => s.name), ['B', 'A']);
  assert.deepEqual(base.workday.segments.map(s => s.name), ['A', 'B'], '原草稿不被改');
  assert.equal(moveSegment(base, 'workday', 0, -1), base, '到顶不再移动');
  assert.equal(moveSegment(base, 'workday', 1, 1), base, '到底不再移动');
  assert.equal(moveSegment(base, 'workday', 5, -1), base);
});

test('概率事件增删改：切换时间点/时间段时时间字段跟着搬，概率可改', () => {
  const before = draft();
  const added = addEvent(before, 'workday');
  assert.equal(added.workday.events.length, 1);
  assert.deepEqual(
    [added.workday.events[0].kind, added.workday.events[0].at, added.workday.events[0].probability],
    ['point', '15:00', 50]
  );
  const described = updateEvent(added, 'workday', 0, { description: '去楼下买咖啡', probability: 30 });
  assert.equal(described.workday.events[0].probability, 30);
  const ranged = updateEvent(described, 'workday', 0, { kind: 'range' });
  assert.deepEqual([ranged.workday.events[0].start, ranged.workday.events[0].end], ['15:00', '16:00']);
  assert.equal(ranged.workday.events[0].at, '', '切到时间段后清掉时间点，避免两个字段打架');
  const back = updateEvent(ranged, 'workday', 0, { kind: 'point' });
  assert.equal(back.workday.events[0].at, '15:00');
  assert.equal(back.workday.events[0].start, '');
  assert.equal(removeEvent(back, 'workday', 0).workday.events.length, 0);
  assert.equal(updateEvent(before, 'workday', 3, { description: 'x' }), before);
});

test('节假日：非法格式拒绝并回传 ok=false，重复不叠加，列表保持升序', () => {
  const before = draft();
  assert.equal(addHoliday(before, '2026-13-01').ok, false);
  assert.equal(addHoliday(before, '2026-13-01').draft, before);
  assert.equal(addHoliday(before, '').ok, false);
  const first = addHoliday(before, '2026-10-08');
  assert.equal(first.ok, true);
  const second = addHoliday(first.draft, '2026-01-01');
  assert.deepEqual(second.draft.holidays, ['2026-01-01', '2026-10-08']);
  const again = addHoliday(second.draft, '2026-01-01');
  assert.deepEqual(again.draft.holidays, ['2026-01-01', '2026-10-08'], '重复日期不叠加');
  assert.deepEqual(removeHoliday(second.draft, '2026-01-01').holidays, ['2026-10-08']);
  assert.equal(removeHoliday(second.draft, 'nope'), second.draft);
});

test('预览：未开启分套时只有一套，开启后两套与节假日都列出', () => {
  const flat = normalizeSchedule({
    schema: 2,
    enabled: true,
    workday: {
      segments: [{ id: 'sleep', builtin: 'sleep', start: '23:00', end: '07:00' }, { name: '上学', start: '08:00', end: '12:00' }],
      events: [{ id: 'e1', at: '15:00', description: '去楼下买咖啡', probability: 30 }],
    },
  });
  const lines = schedulePreviewLines(flat, t);
  assert.equal(lines.length, 2);
  assert.ok(lines[0].startsWith('工作日：'));
  assert.ok(lines[0].includes('睡眠 23:00–07:00'), '内置段回退词条名');
  assert.ok(lines[0].includes('上学 08:00–12:00'));
  assert.ok(lines[1].includes('概率事件：15:00 去楼下买咖啡（30%）'));
  assert.equal(lines.join('\n').includes('休息日'), false);

  const split = setSplitWeekday(normalizeSchedule({ ...flat, holidays: ['2026-10-08'] }), true);
  const splitLines = schedulePreviewLines(split, t);
  assert.ok(splitLines.some(line => line.startsWith('休息日：')));
  assert.ok(splitLines.some(line => line.includes('概率事件（工作日）')));
  assert.ok(splitLines.some(line => line.includes('自定义节假日：1 天')));
  // 没有内容的日子明确显示「无固定安排」
  const empty = normalizeSchedule({ schema: 2, enabled: true, splitWeekday: true, workday: { segments: [], events: [] }, restday: { segments: [], events: [] } });
  assert.ok(schedulePreviewLines(empty, t)[0].includes('无固定安排'));
});

test('预览：时间段的名称与「当前时段」文案', () => {
  const s = normalizeSchedule({
    schema: 2,
    enabled: true,
    workday: { segments: [{ name: '喝咖啡', start: '15:00', end: '15:30' }] },
  });
  assert.equal(segmentLabelText(s.workday.segments[0], t), '喝咖啡');
  assert.equal(segmentLabelText({ name: '', builtin: 'work' }, t), '工作');
  assert.equal(segmentLabelText({ name: '', builtin: '' }, t), '时段');
  assert.equal(currentPeriodText(s, t, new Date(2026, 9, 7, 15, 10)), '喝咖啡');
  assert.equal(currentPeriodText(s, t, new Date(2026, 9, 7, 10, 0)), '空闲时段');
});

test('预览与草稿操作配合：新增一行后立刻出现在预览里（面板所见即所存）', () => {
  const before = createDefaultSchedule();
  const withSegment = updateSegment(addSegment(before, 'workday'), 'workday', 2, { name: '喝咖啡', start: '15:00', end: '15:30' });
  const normalized = normalizeSchedule(withSegment);
  assert.ok(schedulePreviewLines(normalized, t)[0].includes('喝咖啡 15:00–15:30'));
  assert.equal(normalized.workday.segments.length, 3);
});

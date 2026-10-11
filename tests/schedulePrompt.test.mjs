// 作息提示词 → 系统提示的接线与**缓存契约**测试。
//
// 作息文本进的是系统提示的稳定前缀（见 prompt/systemSections.js 的 planSystemCache）：
// 前缀里任何一段每轮都变，供应商的 prompt 缓存就整段失效。所以本文件钉两件事：
//  ① 同一天内多次构建（哪怕跨越数小时、哪怕概率事件在当天状态不同）系统提示**逐字节一致**；
//  ② 概率事件确实按「天」变化——换一天会变，否则这个功能等于没生效。
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildRequestMessages } from '../src/prompt/chatPipeline.js';
import { buildTimeAwareText } from '../src/chat/currentTime.js';
import {
  buildSchedulePrompt,
  dateKeyOf,
  isScheduleActive,
  normalizeSchedule,
} from '../src/chat/schedule.js';

const character = { name: '小雨', systemPrompt: '你是小雨。', regexScripts: [] };

const schedule = () => normalizeSchedule({
  schema: 2,
  enabled: true,
  splitWeekday: true,
  workday: {
    segments: [
      { id: 'sleep', builtin: 'sleep', start: '23:00', end: '07:00' },
      { name: '上学', start: '08:00', end: '12:00' },
      { name: '喝咖啡', start: '15:00', end: '15:30' },
    ],
    events: [{ id: 'coffee', kind: 'point', at: '15:00', description: '去楼下买咖啡', probability: 50 }],
  },
  restday: {
    segments: [{ name: '睡懒觉', start: '10:00', end: '12:00' }],
    events: [{ id: 'hike', kind: 'range', start: '13:00', end: '17:00', description: '去爬山', probability: 50 }],
  },
  holidays: ['2026-10-08'],
});

// 与真实调用路径同构：读角色作息 → 生成规则文本 → 交给 buildRequestMessages。
// useChatSend / taskRunner 就是这么接的（proactiveRequest 走不传日期的那条）。
function systemPromptAt(scheduleSource, date, characterId = 'c1') {
  const text = buildSchedulePrompt(scheduleSource, { date, characterId });
  const messages = buildRequestMessages({
    character,
    historyMessages: [],
    userText: '你好',
    userProfile: {},
    globalPresets: [],
    currentTimeText: buildTimeAwareText(true, date),
    scheduleText: text,
  });
  return messages.find(item => item.role === 'system').content;
}

test('接线：启用后作息规则与时间行都进系统提示，且作息排在时间之前', () => {
  const s = schedule();
  assert.equal(isScheduleActive(s), true);
  const system = systemPromptAt(s, new Date(2026, 9, 7, 15, 0));
  assert.ok(system.includes('[角色作息]'));
  assert.ok(system.includes('上学 08:00–12:00'));
  assert.ok(system.includes('喝咖啡 15:00–15:30'));
  assert.ok(system.includes('[当前时间]'));
  assert.ok(system.indexOf('[角色作息]') < system.indexOf('[当前时间]'), '分节顺序：schedule 紧跟 time 之前');
});

test('缓存契约：同一天内多次构建系统提示逐字节一致（概率事件不得每轮重掷）', () => {
  const s = schedule();
  const morning = systemPromptAt(s, new Date(2026, 9, 7, 8, 0));
  const noon = systemPromptAt(s, new Date(2026, 9, 7, 12, 30));
  const night = systemPromptAt(s, new Date(2026, 9, 7, 23, 59));
  // 时间行本身按分钟变化，只比较去掉时间行后的部分——那才是进缓存前缀的稳定内容。
  const strip = text => text.split('\n').filter(line => !line.startsWith('[当前时间]')).join('\n');
  assert.equal(strip(morning), strip(noon));
  assert.equal(strip(noon), strip(night));
  // 作息段自身也必须逐字节一致（含「今天会发生什么」的解析结果）
  const scheduleSection = text => text.split('\n').filter(line => line.includes('角色作息') || line.includes('概率事件') || line.includes('[今天]')).join('\n');
  assert.equal(scheduleSection(morning), scheduleSection(night));
});

test('概率事件按天生效：换一天系统提示里的判定结果会变', () => {
  const s = schedule();
  // 在工作日里找一对「一天发生、一天不发生」的日期
  const weekdays = Array.from({ length: 40 }, (_, i) => dateKeyOf(new Date(2026, 9, 1 + i)))
    .filter(key => {
      const day = new Date(`${key}T00:00:00`);
      return day.getDay() !== 0 && day.getDay() !== 6;
    });
  const sections = weekdays.map(key => buildSchedulePrompt(s, { date: key, characterId: 'c1' }));
  const hits = sections.filter(text => text.includes('今天会发生'));
  const misses = sections.filter(text => text.includes('今天这些事都不会发生'));
  assert.ok(hits.length > 0, '存在「今天会发生」的日子');
  assert.ok(misses.length > 0, '存在「都不发生」的日子');
  // 同一份文本重复构建稳定
  assert.equal(buildSchedulePrompt(s, { date: weekdays[0], characterId: 'c1' }), sections[0]);
  // 不同角色同一天可以拿到不同结果（种子含角色 id）
  const other = weekdays.map(key => buildSchedulePrompt(s, { date: key, characterId: 'c2' }));
  assert.notDeepEqual(other, sections);
});

test('主动消息快照路径：不传日期的规则文本不含日期，也不声称今天是哪种日子', () => {
  const s = schedule();
  const snapshotText = buildSchedulePrompt(s);
  assert.equal(/20\d\d-\d\d-\d\d/.test(snapshotText), false);
  assert.equal(snapshotText.includes('[今天]'), false);
  assert.equal(snapshotText.includes('今天会发生'), false);
  // 两套作息与两套事件定义都要在（快照触发日未知）
  assert.ok(snapshotText.includes('工作日：'));
  assert.ok(snapshotText.includes('休息日：'));
  assert.ok(snapshotText.includes('去楼下买咖啡'));
  assert.ok(snapshotText.includes('去爬山'));
  const messages = buildRequestMessages({
    character,
    historyMessages: [],
    userText: '（请现在主动开口）',
    userProfile: {},
    globalPresets: [],
    currentTimeText: '{{proactive_now}}',
    scheduleText: snapshotText,
  });
  const system = messages.find(item => item.role === 'system').content;
  assert.ok(system.includes('{{proactive_now}}'));
  assert.ok(system.includes('睡懒觉 10:00–12:00'));
  assert.equal(/20\d\d-\d\d-\d\d/.test(system.replace('{{proactive_now}}', '')), false);
});

test('未启用作息时不注入作息段（系统提示与之前一致）', () => {
  const off = normalizeSchedule({ ...schedule(), enabled: false });
  assert.equal(buildSchedulePrompt(off, { date: new Date(2026, 9, 7) }), '');
  const system = systemPromptAt(off, new Date(2026, 9, 7, 15, 0));
  assert.equal(system.includes('[角色作息]'), false);
});

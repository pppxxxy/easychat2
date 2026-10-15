// FEAT-AC4 P0-B：闹钟提醒（一次性精确时间）。
//
// 纯层（reminderSchema）Node 直测：时间归一、过去时间拒绝、文案渲染。
// 脏层用注入（原生与 storage 全打桩）。
// 原生侧 Kotlin 源码断言（真编译靠 CI）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  REMINDER_SLOT_PREFIX,
  REMINDER_TEXT_MAX,
  describeReminderValue,
  formatReminderTime,
  isReminderSlot,
  makeReminderSlotId,
  normalizeReminderTime,
  renderReminderConfirmText,
  renderReminderList,
  validateReminder,
} from '../src/workspace/reminderSchema.js';
import {
  __setReminderNativeModules,
  REMINDER_READ_DEFINITIONS,
  REMINDER_TOOL_DEFINITIONS,
  REMINDER_WRITE_DEFINITIONS,
  createReminder,
  readReminders,
  removeReminder,
  renderReminderApproval,
  setReminderRecorder,
} from '../src/workspace/toolDefs/reminderTools.js';
import { AGENT_MODES, listToolsForMode, registerTool, unregisterTool } from '../src/agent/tools/registry.js';

const read = rel => fs.readFileSync(path.resolve(rel), 'utf8');
const byName = name => REMINDER_TOOL_DEFINITIONS.find(item => item.name === name);

// ---------- 纯层：时间归一 ----------

test('时间归一：epoch 毫秒 / 数字串 / ISO 串 三种形态都认', () => {
  const ms = 1_800_000_000_000;
  assert.equal(normalizeReminderTime(ms), ms, '数字 epoch ms');
  assert.equal(normalizeReminderTime(String(ms)), ms, '数字串 epoch ms');
  // 秒级（10 位）按秒补成毫秒
  assert.equal(normalizeReminderTime(1_800_000_000), 1_800_000_000_000, '秒级自动补毫秒');
  // ISO 串（不带时区按本机时区解释）
  const parsed = normalizeReminderTime('2026-10-16T08:00:00');
  assert.ok(Number.isFinite(parsed) && parsed > 0, 'ISO 串可解析');
  assert.equal(new Date(parsed).getHours(), 8, '不带时区的 ISO 按本机时区解释（这正是「明天8点」的意思）');
});

test('时间归一：无法解析一律 null（**不猜**——猜错会在最不该打扰时提醒）', () => {
  for (const bad of [null, undefined, '', '   ', '明天早上', {}, [], NaN, 0, -1, 'abc']) {
    assert.equal(normalizeReminderTime(bad), null, `${JSON.stringify(bad)} 应返回 null`);
  }
});

// ---------- 纯层：校验（过去时间必须拒绝）----------

test('校验：过去时间被拒绝并说明（排过去的闹钟等于立刻打扰或被静默忽略）', () => {
  const now = 1_800_000_000_000;
  const msg = validateReminder({ text: '开会', time: now - 60_000, now });
  assert.ok(msg, '必须拒绝');
  assert.match(msg, /已经过去/);
  // 消息里要有换算后的本地时间（用户才知道自己给的是什么）
  assert.match(msg, /\d{4}-\d{2}-\d{2}/);
});

test('校验：恰好等于 now 也算过去（避免「立刻响」）', () => {
  const now = 1_800_000_000_000;
  assert.ok(validateReminder({ text: 'x', time: now, now }), '等于 now 应拒绝');
  assert.equal(validateReminder({ text: 'x', time: now + 1000, now }), null, '晚 1 秒应通过');
});

test('校验：空内容 / 超长内容被拒绝', () => {
  const future = Date.now() + 3_600_000;
  assert.match(validateReminder({ text: '', time: future }), /不能为空/);
  assert.match(validateReminder({ text: '   ', time: future }), /不能为空/);
  const long = 'x'.repeat(REMINDER_TEXT_MAX + 1);
  const msg = validateReminder({ text: long, time: future });
  assert.match(msg, /太长/);
  assert.match(msg, new RegExp(String(REMINDER_TEXT_MAX)), '要说清上限');
});

test('校验：时间缺失/不可解析 → 给出可行指引（而不是一句「参数错」）', () => {
  const msg = validateReminder({ text: '开会', time: '明天' });
  assert.match(msg, /无法识别提醒时间/);
  assert.match(msg, /「明天」/);
  assert.match(msg, /2026-|ISO|日期时间/, '要给出格式示例');
});

test('校验：合法输入通过', () => {
  assert.equal(validateReminder({ text: '开会', time: Date.now() + 3_600_000 }), null);
});

// ---------- 纯层：文案 ----------

test('时间显示：本机时区 + 相对天数（今天/明天/后天/N 天后）', () => {
  const now = new Date(2026, 9, 15, 12, 0, 0).getTime();   // 2026-10-15 12:00 本机
  const at = (y, m, d, hh, mm) => new Date(y, m, d, hh, mm, 0).getTime();
  assert.match(formatReminderTime(at(2026, 9, 15, 20, 30), { now }), /2026-10-15 20:30（今天）/);
  assert.match(formatReminderTime(at(2026, 9, 16, 8, 0), { now }), /2026-10-16 08:00（明天）/);
  assert.match(formatReminderTime(at(2026, 9, 17, 8, 0), { now }), /2026-10-17 08:00（后天）/);
  assert.match(formatReminderTime(at(2026, 9, 20, 8, 0), { now }), /（5 天后）/);
  // 无效时间如实标注
  assert.match(formatReminderTime(0), /无效时间/);
});

test('确认文案：含换算后的本地时间与内容（任务书要求）', () => {
  const now = new Date(2026, 9, 15, 12, 0, 0).getTime();
  const fireAt = new Date(2026, 9, 16, 8, 0, 0).getTime();
  const text = renderReminderConfirmText({ text: '开会', fireAt, now });
  assert.match(text, /2026-10-16 08:00/);
  assert.match(text, /明天/);
  assert.match(text, /开会/);
  assert.match(text, /允许吗/);
});

test('列表渲染：空列表给空串；有条目给时间+内容+id', () => {
  assert.equal(renderReminderList([]), '');
  const now = Date.now();
  const out = renderReminderList([{ slotId: 'reminder-a', text: '开会', fireAt: now + 3_600_000 }], { now });
  assert.match(out, /开会/);
  assert.match(out, /reminder-a/);
});

test('槽位 id：带前缀（与每日时段区分）', () => {
  const id = makeReminderSlotId();
  assert.ok(id.startsWith(REMINDER_SLOT_PREFIX));
  assert.equal(isReminderSlot(id), true);
  assert.equal(isReminderSlot('slot-1-role-8-0'), false, '每日时段的 id 不该被当成提醒');
  assert.equal(isReminderSlot(''), false);
});

test('describeReminderValue：可读化各类值', () => {
  assert.equal(describeReminderValue('x'), '「x」');
  assert.equal(describeReminderValue(undefined), '（未给）');
  assert.equal(describeReminderValue(null), 'null');
  assert.equal(describeReminderValue({}), '对象');
});

// ---------- 工具形状与门控 ----------

test('工具形状：一个只读（list）+ 两个写（set/cancel），写件都要确认', () => {
  assert.deepEqual(REMINDER_READ_DEFINITIONS.map(i => i.name), ['list_reminders']);
  assert.deepEqual(REMINDER_WRITE_DEFINITIONS.map(i => i.name).sort(), ['cancel_reminder', 'set_reminder']);
  assert.equal(byName('list_reminders').readOnly, true);
  assert.equal(byName('set_reminder').readOnly, false);
  assert.equal(byName('cancel_reminder').readOnly, false);
  // 到点会打扰用户 → 必须经用户点头（与 AC1/AC2 同一条审批链）
  assert.equal(byName('set_reminder').requiresConfirmation, true);
  assert.equal(byName('cancel_reminder').requiresConfirmation, true);
});

test('只读模式下 set_reminder / cancel_reminder 不出现在工具清单', () => {
  for (const definition of REMINDER_TOOL_DEFINITIONS) registerTool(definition);
  try {
    const readNames = listToolsForMode(AGENT_MODES.READ).map(i => i.function.name);
    const writeNames = listToolsForMode(AGENT_MODES.WRITE).map(i => i.function.name);
    assert.ok(readNames.includes('list_reminders'), '只读模式应能看到 list_reminders');
    assert.equal(readNames.includes('set_reminder'), false, '只读模式不得暴露 set_reminder');
    assert.equal(readNames.includes('cancel_reminder'), false, '只读模式不得暴露 cancel_reminder');
    assert.ok(writeNames.includes('set_reminder'));
    assert.ok(writeNames.includes('cancel_reminder'));
  } finally {
    for (const definition of REMINDER_TOOL_DEFINITIONS) unregisterTool(definition.name);
  }
});

test('确认文案：set 含时间与内容；cancel 含 id', () => {
  const now = new Date(2026, 9, 15, 12, 0, 0).getTime();
  const at = new Date(2026, 9, 16, 8, 0, 0).getTime();
  const setText = renderReminderApproval({ name: 'set_reminder', args: { text: '开会', time: at } });
  assert.match(setText, /开会/);
  assert.match(setText, /允许吗/);
  const cancelText = renderReminderApproval({ name: 'cancel_reminder', args: { slotId: 'reminder-x' } });
  assert.match(cancelText, /reminder-x/);
  assert.equal(renderReminderApproval({ name: 'other' }), '');
  void now;
});

// ---------- 脏层（原生 + storage 全打桩）----------

const stubs = {
  proactive: {
    scheduleDailyMessage: async () => 'reminder-x',
    cancelDailySchedule: async () => true,
    canScheduleExactAlarms: async () => true,
  },
  moments: {
    getProactiveSettings: async () => ({ slots: [] }),
    saveProactiveSettings: async settings => settings,
  },
  assistant: {
    resolveWorkspaceAssistant: async () => ({ character: { id: 'wa', name: '助手' } }),
  },
};
const restoreNative = __setReminderNativeModules(stubs);

function resetStubs() {
  stubs.proactive.scheduleDailyMessage = async () => 'reminder-x';
  stubs.proactive.cancelDailySchedule = async () => true;
  stubs.proactive.canScheduleExactAlarms = async () => true;
  stubs.moments.getProactiveSettings = async () => ({ slots: [] });
  stubs.moments.saveProactiveSettings = async settings => settings;
  stubs.assistant.resolveWorkspaceAssistant = async () => ({ character: { id: 'wa', name: '助手' } });
}

test('createReminder：过去时间被拒，且**不排任何调度**', async () => {
  resetStubs();
  let scheduled = false;
  stubs.proactive.scheduleDailyMessage = async () => { scheduled = true; return 'x'; };
  const result = await createReminder({ text: '开会', time: Date.now() - 60_000 });
  assert.equal(result.ok, false);
  assert.match(result.error, /已经过去/);
  assert.equal(scheduled, false, '校验失败绝不许排调度');
});

test('createReminder：无精确闹钟权限 → 如实指引，不静默降级', async () => {
  resetStubs();
  let scheduled = false;
  stubs.proactive.canScheduleExactAlarms = async () => false;
  stubs.proactive.scheduleDailyMessage = async () => { scheduled = true; return 'x'; };
  const result = await createReminder({ text: '开会', time: Date.now() + 3_600_000 });
  assert.equal(result.ok, false);
  assert.match(result.error, /精确闹钟/);
  assert.match(result.error, /设置/, '要指路去哪开');
  assert.equal(scheduled, false, '没权限不该排一个不准时的调度');
});

test('createReminder：正常路径 —— 一次性形态 + 固定文案 + 新建对话', async () => {
  resetStubs();
  let config = null;
  stubs.proactive.scheduleDailyMessage = async payload => { config = payload; return payload.slotId; };
  const fireAt = Date.now() + 3_600_000;
  const result = await createReminder({ text: '开会', time: fireAt });
  assert.equal(result.ok, true);
  assert.equal(result.fireAt, fireAt);
  assert.ok(config, '必须真的排了调度');
  assert.equal(config.mode, 'EXACT', '一次性走精确模式');
  assert.equal(config.fixedText, '开会', '固定文案原样传（不走 LLM）');
  assert.equal(config.requestJson, '', 'requestJson 留空 = 新建对话语义');
  assert.equal(config.roleId, 'workspace-assistant', '发送者是工作区助手');
  assert.ok(isReminderSlot(config.slotId), '槽 id 带提醒前缀');
});

test('createReminder：JS 侧记账（list 才看得到）', async () => {
  resetStubs();
  let saved = null;
  stubs.moments.saveProactiveSettings = async settings => { saved = settings; return settings; };
  const fireAt = Date.now() + 3_600_000;
  await createReminder({ text: '开会', time: fireAt });
  assert.ok(saved, '必须记账');
  assert.equal(saved.slots.length, 1);
  assert.equal(saved.slots[0].fireAt, fireAt);
  assert.equal(saved.slots[0].text, '开会');
});

test('createReminder：调度失败 → 如实报错（不假装设上了）', async () => {
  resetStubs();
  stubs.proactive.scheduleDailyMessage = async () => { throw new Error('native boom'); };
  const result = await createReminder({ text: '开会', time: Date.now() + 3_600_000 });
  assert.equal(result.ok, false);
  assert.match(result.error, /建立提醒失败/);
});

test('readReminders：只列提醒槽（每日时段不混进来），按时间排序', async () => {
  resetStubs();
  const base = Date.now();
  stubs.moments.getProactiveSettings = async () => ({
    slots: [
      { slotId: 'slot-role-8-0', hour: 8, minute: 0 },                       // 每日时段：不该列出
      { slotId: 'reminder-b', text: '晚的', fireAt: base + 7_200_000 },
      { slotId: 'reminder-a', text: '早的', fireAt: base + 3_600_000 },
    ],
  });
  const list = await readReminders();
  assert.equal(list.length, 2, '每日时段不该被当成提醒');
  assert.deepEqual(list.map(i => i.slotId), ['reminder-a', 'reminder-b'], '按时间排序');
});

test('removeReminder：取消原生调度 + 删 JS 记账', async () => {
  resetStubs();
  const cancelled = [];
  let saved = null;
  stubs.proactive.cancelDailySchedule = async id => { cancelled.push(id); return true; };
  stubs.moments.getProactiveSettings = async () => ({
    slots: [{ slotId: 'reminder-a', text: 'x', fireAt: Date.now() + 1000 }],
  });
  stubs.moments.saveProactiveSettings = async settings => { saved = settings; return settings; };
  const result = await removeReminder('reminder-a');
  assert.equal(result.ok, true);
  assert.deepEqual(cancelled, ['reminder-a'], '必须真的取消原生调度');
  assert.equal(saved.slots.length, 0, '记账也要清掉');
});

test('removeReminder：缺 id → 拒绝并指路', async () => {
  resetStubs();
  const result = await removeReminder('');
  assert.equal(result.ok, false);
  assert.match(result.error, /需要给出/);
  assert.match(result.error, /list_reminders/, '要指路怎么查 id');
});

test('list_reminders 工具：空列表如实说', async () => {
  resetStubs();
  const out = await byName('list_reminders').execute({}, {}, {});
  assert.match(out, /没有设置任何提醒/);
});

test('set_reminder 工具：校验失败时明确说「未建立任何提醒」', async () => {
  resetStubs();
  const out = await byName('set_reminder').execute({}, { text: '开会', time: Date.now() - 1000 }, {});
  assert.match(out, /已经过去/);
  assert.match(out, /未建立任何提醒/);
});

test('诊断留痕：set / cancel 各打点', async () => {
  resetStubs();
  const calls = [];
  setReminderRecorder({ noteReminder: (action, detail) => calls.push(`${action}:${detail}`) });
  try {
    await createReminder({ text: '开会', time: Date.now() + 3_600_000 });
    assert.ok(calls.some(c => c.startsWith('set:')), 'set 要打点');
    calls.length = 0;
    await removeReminder('reminder-a');
    assert.ok(calls.some(c => c.startsWith('cancel:')), 'cancel 要打点');
  } finally {
    setReminderRecorder(null);
  }
});

// ---------- 原生（Kotlin 源码断言）----------

test('原生：RoleSchedule 支持一次性 fireAt + 固定文案', () => {
  const core = read('plugins/proactiveMessage/android/ProactiveCore.kt');
  assert.ok(core.includes('val fireAt: Long = 0'), 'fireAt 字段存在');
  assert.ok(core.includes('val fixedText: String = ""'), 'fixedText 字段存在');
  assert.ok(core.includes('val isOneShot: Boolean get() = fireAt > 0'), '一次性判据');
  assert.ok(core.includes('require(fireAt >= 0)'), '负值在构造时就被挡');
  // 序列化往返（老配置缺字段 → 0/空，行为不变）
  assert.ok(core.includes('.put("fireAt", fireAt)') && core.includes('.put("fixedText", fixedText)'));
  assert.match(core, /fireAt = json\.optLong\("fireAt", 0L\)/, '老配置回退 0');
  assert.match(core, /fixedText = json\.optString\("fixedText", ""\)/, '老配置回退空');
});

test('原生：一次性用 fireAt 触发，且过去的时刻不再排', () => {
  const sched = read('plugins/proactiveMessage/android/ProactiveScheduling.kt');
  assert.match(sched, /val triggerAt = if \(schedule\.isOneShot\) schedule\.fireAt else MessageClock\.nextTarget\(schedule\)/,
    '一次性走 fireAt，每日走推出的时刻');
  assert.match(sched, /if \(triggerAt <= System\.currentTimeMillis\(\)\)[\s\S]{0,200}?return/,
    '已过期的触发时刻直接跳过（排过去的闹钟会立刻打扰用户）');
});

test('原生：一次性提醒**触发后自删且不重排**（最容易做错的一处）', () => {
  const sched = read('plugins/proactiveMessage/android/ProactiveScheduling.kt');
  // 既有逻辑每次触发都无条件重排（每日重复语义）——一次性必须走另一条路
  assert.match(sched, /val oneShot = schedule != null && schedule\.isOneShot/);
  assert.match(sched, /if \(oneShot\) \{[\s\S]{0,300}?removeScheduleBySlot\(slotId\)/,
    '一次性触发后必须自删');
  assert.match(sched, /\} else if \(schedule != null && schedule\.enabled\) \{[\s\S]{0,200}?AlarmScheduler\.schedule/,
    '只有非一次性才重排');
});

test('原生：提醒用固定文案（不走 LLM——可靠性优先）', () => {
  const core = read('plugins/proactiveMessage/android/ProactiveCore.kt');
  assert.match(core, /val text = schedule\.fixedText\.ifBlank \{/,
    'fixedText 非空时原样作消息体');
  // 一次性过期判据不能用每日窗口算
  assert.match(core, /if \(config\.isOneShot\) \{\s*return nowMillis - config\.fireAt > MAX_LATENESS_MS/,
    '一次性的过期判据基于 fireAt（每日窗口对它无意义）');
});

test('原生模块：schedule 接受 fireAt / fixedText，且负值夹成 0', () => {
  const module_ = read('plugins/proactiveMessage/android/ProactiveMessageModule.kt');
  assert.match(module_, /fireAt = \(if \(config\.hasKey\("fireAt"\)\) config\.getDouble\("fireAt"\)\.toLong\(\) else 0L\)\s*\.coerceAtLeast\(0L\)/,
    'fireAt 解析 + 负值夹成 0');
  assert.match(module_, /fixedText = if \(config\.hasKey\("fixedText"\)\) config\.getString\("fixedText"\) \?: "" else ""/);
});

test('JS 侧：提醒的惰性依赖与分层（不静态 import 原生）', () => {
  const tools = read('src/workspace/toolDefs/reminderTools.js');
  // 惰性 require（静态会让 14 个 import tools.js 的测试全崩）
  assert.ok(tools.includes("require('../../proactive/proactiveMessage.js')"));
  assert.ok(tools.includes("require('../../storage/moments.js')"));
  assert.equal(/^import .*proactiveMessage/m.test(tools), false, '不得静态 import 原生模块');
  // 纯层与脏层分工
  const schema = read('src/workspace/reminderSchema.js');
  assert.equal(/react-native|expo-/.test(schema), false, '纯层必须零 RN 依赖');
});

test.after(() => {
  restoreNative();
});

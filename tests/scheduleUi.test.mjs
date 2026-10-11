// 角色作息 UI/接线结构守卫。项目无 React 渲染器，按既有约定用源码锚点验证。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = rel => readFileSync(path.join(HERE, '..', rel), 'utf8');

const HOME = read('src/extension/ExtensionHome.js');
const STACK = read('src/extension/ExtensionStack.js');
const PANEL = read('src/extension/SchedulePanel.js');
const SEND = read('src/chat/useChatSend.js');
const PROACTIVE = read('src/proactive/proactiveRequest.js');
const PIPELINE = read('src/prompt/chatPipeline.js');
const TASK = read('src/agent/task/taskRunner.js');
const ZH = read('src/i18n/locales/zh-CN/schedule.js');
const EN = read('src/i18n/locales/en/schedule.js');

test('拓展首页新增作息入口并注册路由', () => {
  assert.ok(HOME.includes("id: 'schedule'"));
  assert.ok(HOME.includes("route: 'ext-schedule'"));
  assert.ok(HOME.includes("labelKey: 'ext.home.schedule'"));
  assert.ok(HOME.includes('getAllCharacterSchedules'));
  assert.ok(STACK.includes("import SchedulePanel from './SchedulePanel.js';"));
  assert.ok(STACK.includes('<Stack.Screen name="ext-schedule" component={SchedulePanel} />'));
});

test('作息面板：角色选择 + 启用/分套开关 + 三个子编辑器 + 保存', () => {
  assert.ok(PANEL.includes('getCharacterSchedule(roleId)'));
  assert.ok(PANEL.includes('saveCharacterSchedule(roleId, normalized)'));
  assert.ok(PANEL.includes('<Switch'));
  assert.ok(PANEL.includes("from './schedule/draftOps.js'"));
  assert.ok(PANEL.includes("from './schedule/SegmentsEditor.js'"));
  assert.ok(PANEL.includes("from './schedule/EventsEditor.js'"));
  assert.ok(PANEL.includes("from './schedule/HolidaysEditor.js'"));
  assert.ok(PANEL.includes("from './schedule/preview.js'"));
  assert.ok(PANEL.includes('<SegmentsEditor'));
  assert.ok(PANEL.includes('<EventsEditor'));
  assert.ok(PANEL.includes('<HolidaysEditor'));
});

test('对话注入：读取角色作息并附带当前时间（同一时刻，保证同日）', () => {
  assert.ok(SEND.includes('getCharacterSchedule(scheduleCharacterId)'));
  assert.ok(SEND.includes('buildSchedulePrompt(schedule, { date: requestNow, characterId: scheduleCharacterId })'));
  assert.ok(SEND.includes('buildTimeAwareText(chatOptionsRef.current.timeAware || scheduleActive, requestNow)'));
  assert.ok(SEND.includes('scheduleText,'));
  assert.ok(PIPELINE.includes('scheduleText'));
  assert.ok(PIPELINE.includes('const scheduleLine = String(scheduleText || \'\').trim();'));
});

test('定时任务注入：按本次运行时刻解析作息（同日的时间行与作息判定）', () => {
  assert.ok(TASK.includes('buildSchedulePrompt(schedule, { date: now, characterId: roleId })'));
});

test('主动消息注入：作息规则写入快照并按作息附带时间占位符', () => {
  assert.ok(PROACTIVE.includes('scheduleText = buildSchedulePrompt(schedule)'));
  assert.ok(PROACTIVE.includes('timeAware: timeAware || scheduleActive'));
  assert.ok(PROACTIVE.includes('scheduleText,'));
});

test('作息词条中英齐备', () => {
  const keys = [
    'schedule.title',
    'schedule.selectRole',
    'schedule.enable',
    'schedule.enableHint',
    'schedule.splitWeekday',
    'schedule.splitWeekdayHint',
    'schedule.dayKind.workday',
    'schedule.dayKind.restday',
    'schedule.timePlaceholder',
    'schedule.segmentFallback',
    'schedule.builtin.sleep',
    'schedule.builtin.work',
    'schedule.segments.title',
    'schedule.segments.empty',
    'schedule.segments.add',
    'schedule.segments.namePlaceholder',
    'schedule.segments.start',
    'schedule.segments.end',
    'schedule.segments.moveUp',
    'schedule.segments.moveDown',
    'schedule.segments.remove',
    'schedule.segments.orderHint',
    'schedule.events.title',
    'schedule.events.empty',
    'schedule.events.add',
    'schedule.events.namePlaceholder',
    'schedule.events.kind.point',
    'schedule.events.kind.range',
    'schedule.events.probability',
    'schedule.events.descriptionPlaceholder',
    'schedule.events.remove',
    'schedule.events.hint',
    'schedule.events.emptyDescriptionHint',
    'schedule.holidays.title',
    'schedule.holidays.empty',
    'schedule.holidays.add',
    'schedule.holidays.placeholder',
    'schedule.holidays.remove',
    'schedule.holidays.invalid',
    'schedule.holidays.hint',
    'schedule.preview',
    'schedule.preview.workday',
    'schedule.preview.restday',
    'schedule.preview.none',
    'schedule.preview.events',
    'schedule.preview.holidays',
    'schedule.period.free',
    'schedule.currentPeriod',
    'schedule.hint',
    'schedule.disabledHint',
    'schedule.save',
    'schedule.saved',
    'schedule.saveFailed',
    'schedule.noRoles',
  ];
  keys.forEach(key => {
    assert.ok(ZH.includes(`'${key}'`), `zh-CN 缺 ${key}`);
    assert.ok(EN.includes(`'${key}'`), `en 缺 ${key}`);
  });
});

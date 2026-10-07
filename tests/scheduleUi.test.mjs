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

test('作息面板：角色选择 + 启用开关 + 四时刻 + 保存', () => {
  assert.ok(PANEL.includes("key: 'wake'") && PANEL.includes("key: 'sleep'"));
  assert.ok(PANEL.includes('<Switch'));
  assert.ok(PANEL.includes('saveCharacterSchedule(roleId, normalized)'));
  assert.ok(PANEL.includes('getCharacterSchedule(roleId)'));
  assert.ok(PANEL.includes('describeSchedule(normalized)'));
  assert.ok(PANEL.includes('resolveSchedulePeriod'));
});

test('对话注入：读取角色作息并附带当前时间', () => {
  assert.ok(SEND.includes('getCharacterSchedule(scheduleCharacterId)'));
  assert.ok(SEND.includes('scheduleText = buildSchedulePrompt(schedule)'));
  assert.ok(SEND.includes('buildTimeAwareText(chatOptionsRef.current.timeAware || scheduleActive)'));
  assert.ok(SEND.includes('scheduleText,'));
  assert.ok(PIPELINE.includes('scheduleText'));
  assert.ok(PIPELINE.includes('const scheduleLine = String(scheduleText || \'\').trim();'));
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
    'schedule.wake',
    'schedule.workStart',
    'schedule.workEnd',
    'schedule.sleep',
    'schedule.save',
    'schedule.hint',
    'schedule.currentPeriod',
  ];
  keys.forEach(key => {
    assert.ok(ZH.includes(`'${key}'`), `zh-CN 缺 ${key}`);
    assert.ok(EN.includes(`'${key}'`), `en 缺 ${key}`);
  });
});

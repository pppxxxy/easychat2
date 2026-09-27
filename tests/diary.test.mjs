import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  appendDiary,
  buildDiaryPrompt,
  buildDiaryTranscript,
  collectWindowMessages,
  formatDiaryDate,
  getRoleDiarySetting,
  isNewDay,
  localDateKey,
  markRoleDiaryDate,
  normalizeDiaryEntry,
  normalizeDiarySettings,
  normalizeDiaryText,
  removeDiariesForCharacter,
  removeRolesFromDiarySettings,
  selectDiariesForCharacter,
  selectDiaryRoles,
  setDiaryLastRunDate,
  setRoleDiaryEnabled,
  yesterdayRange,
  MAX_DIARIES_PER_CHARACTER,
} from '../src/diary/diary.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = name => readFileSync(path.join(HERE, '..', 'src', name), 'utf8');
const STORAGE_SOURCE = read('storage.js');
const RUNNER_SOURCE = read('diary/runDiary.js');
const PANEL_SOURCE = read('DiaryPanel.js');
const EXTENSION_SOURCE = read('ExtensionScreen.js');
const API_SOURCE = read('api.js');
const APP_SOURCE = readFileSync(path.join(HERE, '..', 'App.js'), 'utf8');

// 用固定本地时间构造：2026-09-27 10:00 本地时间
const NOW = new Date(2026, 8, 27, 10, 0, 0).getTime();

test('本地日期键与跨天判定', () => {
  assert.equal(localDateKey(NOW), '2026-09-27');
  // 同一天内多次启动不算跨天
  assert.equal(isNewDay('2026-09-27', NOW), false);
  // 空值或更早的日期算跨天
  assert.equal(isNewDay('', NOW), true);
  assert.equal(isNewDay('2026-09-26', NOW), true);
});

test('昨天时间窗是本地自然日 00:00-24:00', () => {
  const { start, end } = yesterdayRange(NOW);
  assert.equal(localDateKey(start), '2026-09-26');
  assert.equal(end - start, 24 * 60 * 60 * 1000);
});

test('日记设置规范化与按角色开关', () => {
  const base = normalizeDiarySettings(null);
  assert.deepEqual(base.roles, {});
  assert.equal(base.apiConfigId, '');
  assert.equal(base.lastRunDate, '');

  let settings = setRoleDiaryEnabled(base, 'c1', true, '晚星');
  assert.equal(getRoleDiarySetting(settings, 'c1').enabled, true);
  assert.equal(getRoleDiarySetting(settings, 'c1').roleName, '晚星');
  assert.equal(getRoleDiarySetting(settings, 'c2').enabled, false);

  settings = setRoleDiaryEnabled(settings, 'c1', false);
  assert.equal(getRoleDiarySetting(settings, 'c1').enabled, false);
  // 关闭不清掉角色名
  assert.equal(getRoleDiarySetting(settings, 'c1').roleName, '晚星');

  settings = markRoleDiaryDate(settings, 'c1', '2026-09-26');
  assert.equal(getRoleDiarySetting(settings, 'c1').lastDiaryDate, '2026-09-26');

  settings = setDiaryLastRunDate(settings, '2026-09-27');
  assert.equal(normalizeDiarySettings(settings).lastRunDate, '2026-09-27');

  const cleaned = removeRolesFromDiarySettings(settings, ['c1']);
  assert.equal(getRoleDiarySetting(cleaned, 'c1').enabled, false);
});

test('同一角色同一天只保留一篇且有条数上限', () => {
  let list = [];
  list = appendDiary(list, { id: 'd1', characterId: 'c1', date: '2026-09-26', text: '第一篇', createdAt: 1 });
  list = appendDiary(list, { id: 'd2', characterId: 'c1', date: '2026-09-26', text: '覆盖', createdAt: 2 });
  assert.equal(list.length, 1);
  assert.equal(list[0].text, '覆盖');

  // 另一角色互不影响
  list = appendDiary(list, { id: 'd3', characterId: 'c2', date: '2026-09-26', text: 'c2', createdAt: 3 });
  assert.equal(list.length, 2);

  // 超出上限时丢最旧的
  let many = [];
  for (let i = 0; i < MAX_DIARIES_PER_CHARACTER + 5; i += 1) {
    many = appendDiary(many, {
      id: `x-${i}`,
      characterId: 'c1',
      date: `2026-01-${String((i % 28) + 1).padStart(2, '0')}-${i}`,
      text: `t${i}`,
      createdAt: i,
    });
  }
  assert.ok(many.filter(item => item.characterId === 'c1').length <= MAX_DIARIES_PER_CHARACTER);

  // 非法条目被忽略
  assert.equal(appendDiary(list, { id: '', characterId: '', date: '' }).length, 2);
});

test('按角色筛选与删除', () => {
  const list = [
    { id: 'a', characterId: 'c1', date: '2026-09-26', text: '1', createdAt: 1 },
    { id: 'b', characterId: 'c1', date: '2026-09-25', text: '2', createdAt: 2 },
    { id: 'c', characterId: 'c2', date: '2026-09-26', text: '3', createdAt: 3 },
  ].map(normalizeDiaryEntry);
  const c1 = selectDiariesForCharacter(list, 'c1');
  assert.deepEqual(c1.map(item => item.date), ['2026-09-26', '2026-09-25']);
  assert.equal(removeDiariesForCharacter(list, ['c1']).length, 1);
});

test('启动候选：仅开启且昨天未写过的角色，排除群聊', () => {
  const characters = [{ id: 'c1', name: '晚星' }, { id: 'c2', name: '晨曦' }];
  const sessions = [
    { id: 's1', characterId: 'c1', type: 'single' },
    { id: 's2', characterId: 'c2', type: 'single' },
    { id: 'g1', type: 'group', characterId: '' },
  ];
  let settings = setRoleDiaryEnabled(normalizeDiarySettings(null), 'c1', true, '晚星');

  let roles = selectDiaryRoles({ characters, settings, sessions, now: NOW });
  assert.equal(roles.length, 1);
  assert.equal(roles[0].character.id, 'c1');
  assert.deepEqual(roles[0].sessionIds, ['s1']);
  assert.equal(roles[0].date, '2026-09-26');

  // 昨天已经写过就跳过
  settings = markRoleDiaryDate(settings, 'c1', '2026-09-26');
  roles = selectDiaryRoles({ characters, settings, sessions, now: NOW });
  assert.equal(roles.length, 0);
});

test('昨天的消息窗口收集：只纳入能确认在窗口内的消息', () => {
  const inWindow = new Date(2026, 8, 26, 20, 0, 0).getTime();
  const outOfWindow = new Date(2026, 8, 25, 20, 0, 0).getTime();
  const bySession = {
    s1: [
      { role: 'user', text: '昨天的话', timestamp: inWindow },
      { role: 'assistant', text: '昨天的回复', timestamp: inWindow + 1000 },
      { role: 'user', text: '前天的话', timestamp: outOfWindow },
      { role: 'note', text: '备注不算', timestamp: inWindow },
      { role: 'assistant', text: '无时间戳旧消息', timestamp: 0 },
      { role: 'assistant', text: '还在生成', timestamp: inWindow, pending: true },
    ],
  };
  const result = collectWindowMessages(bySession, ['s1'], NOW);
  // 无时间戳旧消息无法确认是否属于昨天，不再纳入；其余按时间戳升序
  assert.deepEqual(result.map(item => item.text), ['昨天的话', '昨天的回复']);
});

test('日记提示词与文本规范化', () => {
  const transcript = buildDiaryTranscript([
    { role: 'user', text: '在吗' },
    { role: 'assistant', text: '在的' },
  ], { charName: '晚星', userName: '我' });
  assert.equal(transcript, '我：在吗\n晚星：在的');

  const prompt = buildDiaryPrompt({ charName: '晚星', userName: '我', transcript, date: '2026-09-26' });
  assert.ok(prompt.includes('你是晚星'));
  assert.ok(prompt.includes('我：在吗'));
  assert.ok(prompt.includes('第一人称'));

  assert.equal(normalizeDiaryText('```\n今天很开心。\n```'), '今天很开心。');
  assert.equal(normalizeDiaryText('“今天很开心。”'), '今天很开心。');
  assert.equal(normalizeDiaryText('   '), '');
  assert.equal(formatDiaryDate('2026-09-26'), '9月26日');
});

test('日记存储使用索引+分键，索引最后写并清理旧条目', () => {
  assert.ok(STORAGE_SOURCE.includes("const DIARY_SETTINGS_KEY = '@easychat2_diary_settings'"));
  assert.ok(STORAGE_SOURCE.includes("const DIARY_INDEX_KEY = '@easychat2_diary_index'"));
  assert.ok(STORAGE_SOURCE.includes("const DIARY_ITEM_PREFIX = '@easychat2_diary_item'"));
  assert.ok(STORAGE_SOURCE.includes('async function writeDiaryCollection'));
  assert.ok(STORAGE_SOURCE.includes('enqueueDiaryMutation'));
  // 设置损坏先备份：沿用既有损坏保护约定
  assert.ok(STORAGE_SOURCE.includes('backupCorruptValue(DIARY_SETTINGS_KEY)'));
  assert.ok(STORAGE_SOURCE.includes('saveDiarySettings'));
  assert.ok(STORAGE_SOURCE.includes('getDiariesStatus'));
  // 角色删除联动清理
  assert.ok(STORAGE_SOURCE.includes('deleteDiariesForCharacterDeletion'));
  assert.ok(STORAGE_SOURCE.includes('removeRolesFromDiarySettings'));
});

test('启动执行器：过一天的首次启动、按所选 API、静默失败', () => {
  assert.ok(RUNNER_SOURCE.includes('export async function runDiaryForNewDay'));
  assert.ok(RUNNER_SOURCE.includes('isNewDay'));
  assert.ok(RUNNER_SOURCE.includes('selectDiaryRoles'));
  assert.ok(RUNNER_SOURCE.includes('collectWindowMessages'));
  assert.ok(RUNNER_SOURCE.includes('appendDiary'));
  // 用所选配置而非强制激活配置
  assert.ok(RUNNER_SOURCE.includes('configId: String(config.id'));
  assert.ok(API_SOURCE.includes('async function resolveChatConfig'));
  assert.ok(API_SOURCE.includes('getApiConfigs'));
  // 启动时挂载
  assert.ok(APP_SOURCE.includes("import { runDiaryForNewDay } from './src/diary/runDiary'"));
  assert.ok(APP_SOURCE.includes('<DiaryStartup />'));
});

test('启动执行器：有失败不推进全局日期，同日可重扫补写', () => {
  // 回归：单角色失败后仍提交 lastRunDate=今天，会让该角色当天日记永久缺失
  //（同日不再重扫、次日窗口已前移）。失败时保留 nextSettings（不设 lastRunDate）。
  assert.ok(RUNNER_SOURCE.includes('let hadFailure = false;'));
  assert.ok(RUNNER_SOURCE.includes('hadFailure = true;'));
  assert.ok(RUNNER_SOURCE.includes('const finalSettings = hadFailure'));
  assert.ok(RUNNER_SOURCE.includes('? nextSettings'));
  assert.ok(RUNNER_SOURCE.includes(': setDiaryLastRunDate(nextSettings, dayKey)'));
  // 已成功角色通过各自 lastDiaryDate 跳过，只补失败的
  assert.ok(RUNNER_SOURCE.includes('markRoleDiaryDate(nextSettings, character.id, role.date)'));
});

test('昨天时间窗用本地日历日两端，避免夏令时偏移', () => {
  // 3 月 9 日（美国夏令时切换日）的“昨天”应是 3 月 8 日 00:00 到 3 月 9 日 00:00，
  // 而不是用 start + 24h 硬算。
  const now = new Date(2026, 2, 9, 10, 0, 0).getTime();
  const { start, end } = yesterdayRange(now);
  assert.equal(localDateKey(start), '2026-03-08');
  assert.equal(localDateKey(end), '2026-03-09');
  assert.equal(localDateKey(new Date(end - 1).getTime()), '2026-03-08');
});

test('世界分组新增日记入口并复用折叠容器', () => {
  assert.ok(EXTENSION_SOURCE.includes("id: 'diary', label: '日记'"));
  assert.ok(EXTENSION_SOURCE.includes("section.id === 'diary'"));
  assert.ok(EXTENSION_SOURCE.includes('<DiaryPanel embedded />'));
  assert.ok(EXTENSION_SOURCE.includes("import DiaryPanel from './DiaryPanel'"));
});

test('日记面板：角色选择、单角色开关、API 选择与查看', () => {
  assert.ok(PANEL_SOURCE.includes('DiaryPanel'));
  assert.ok(PANEL_SOURCE.includes('选择角色'));
  assert.ok(PANEL_SOURCE.includes('写日记的模型'));
  assert.ok(PANEL_SOURCE.includes('setRoleDiaryEnabled'));
  assert.ok(PANEL_SOURCE.includes('selectDiariesForCharacter'));
  assert.ok(PANEL_SOURCE.includes('saveDiarySettings'));
});

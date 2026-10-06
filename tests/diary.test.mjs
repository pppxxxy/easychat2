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
  resolveRoleDiaryConfigId,
  pickPrimarySession,
  selectWindowSessions,
  setDiaryLastRunDate,
  setDiaryLastRunSummary,
  shouldAdvanceDiaryRunDate,
  setRoleDiaryEnabled,
  DIARY_SOURCE_SESSION_LIMIT,
  setRoleDiarySetting,
  yesterdayRange,
  MAX_DIARIES_PER_CHARACTER,
} from '../src/diary/diary.js';
import { runDiaryIfNewDay, shouldRunDiaryForDay } from '../src/diary/diaryStartup.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = name => readFileSync(path.join(HERE, '..', 'src', name), 'utf8');
const STORAGE_SOURCE = read('storage.js');
const DIARY_STORAGE_SOURCE = read('storage/diary.js');
const RUNNER_SOURCE = read('diary/runDiary.js');
const PANEL_SOURCE = read('DiaryPanel.js');

const API_SOURCE = read('network/api.js');
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

test('每角色专属写日记 API 与回退', () => {
  let settings = normalizeDiarySettings({ apiConfigId: 'global-cfg' });
  // 未单独指定时，解析回退到全局
  assert.equal(resolveRoleDiaryConfigId(settings, 'c1'), 'global-cfg');
  settings = setRoleDiarySetting(settings, 'c1', { enabled: true, roleName: '晚星', apiConfigId: 'role-cfg' });
  assert.equal(getRoleDiarySetting(settings, 'c1').apiConfigId, 'role-cfg');
  assert.equal(resolveRoleDiaryConfigId(settings, 'c1'), 'role-cfg');
  // 清空角色专属 → 回退全局
  settings = setRoleDiarySetting(settings, 'c1', { apiConfigId: '' });
  assert.equal(resolveRoleDiaryConfigId(settings, 'c1'), 'global-cfg');
  // 全局也没有 → 空串（由调用方回退当前激活配置）
  assert.equal(resolveRoleDiaryConfigId(normalizeDiarySettings(null), 'c2'), '');
});

test('日记提示词要求格式与内容（无标题/署名、第一人称、150-400 字）', () => {
  const prompt = buildDiaryPrompt({ charName: '晚星', userName: '我', transcript: '我：在吗', date: '2026-09-26' });
  assert.ok(prompt.includes('只输出日记正文本身'));
  assert.ok(prompt.includes('不要标题、日期行、署名'));
  assert.ok(prompt.includes('第一人称'));
  assert.ok(prompt.includes('150-400'));
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
  assert.ok(DIARY_STORAGE_SOURCE.includes("const DIARY_SETTINGS_KEY = '@easychat2_diary_settings'"));
  assert.ok(DIARY_STORAGE_SOURCE.includes("const DIARY_INDEX_KEY = '@easychat2_diary_index'"));
  assert.ok(DIARY_STORAGE_SOURCE.includes("const DIARY_ITEM_PREFIX = '@easychat2_diary_item'"));
  assert.ok(DIARY_STORAGE_SOURCE.includes('async function writeDiaryCollection'));
  assert.ok(DIARY_STORAGE_SOURCE.includes('enqueueDiaryMutation'));
  // 设置损坏先备份：沿用既有损坏保护约定
  assert.ok(DIARY_STORAGE_SOURCE.includes('backupCorruptValue(DIARY_SETTINGS_KEY)'));
  assert.ok(DIARY_STORAGE_SOURCE.includes('saveDiarySettings'));
  assert.ok(DIARY_STORAGE_SOURCE.includes('getDiariesStatus'));
  // 角色删除联动清理：改由 diary 域注册生命周期钩子（storage.js 只跑钩子）
  assert.ok(DIARY_STORAGE_SOURCE.includes('onCharacterDeleted'), '日记域必须注册角色删除钩子');
  assert.ok(DIARY_STORAGE_SOURCE.includes('deleteDiariesForCharacterDeletion'));
  assert.ok(DIARY_STORAGE_SOURCE.includes('removeRolesFromDiarySettings'));
  assert.ok(STORAGE_SOURCE.includes('runCharacterCleanup'), 'barrel 必须调用钩子运行器');
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
  assert.ok(APP_SOURCE.includes("import { runDiaryForNewDay } from './src/diary/runDiary.js'"));
  assert.ok(APP_SOURCE.includes('<DiaryStartup />'));
});

test('闸门推进规则：有候选角色一律不推进（写入/失败/纯跳过都保留当天补写机会）', () => {
  // 回归（2026-10-07）：此前「纯跳过」也推进 lastRunDate——早上启动时昨天没聊过，
  // 闸门被推到今天，用户当天稍后聊天也不补写，必须等下一次跨天；失败不推进的
  // 旧语义同样保留（极少数「当天永久缺失」由本规则一并堵死）。
  assert.equal(shouldAdvanceDiaryRunDate({ roleCount: 0 }), true, '无候选角色才推进');
  assert.equal(shouldAdvanceDiaryRunDate({ roleCount: 1 }), false, '有候选角色不推进');
  assert.equal(shouldAdvanceDiaryRunDate({ roleCount: 3 }), false);
  assert.equal(shouldAdvanceDiaryRunDate({}), true, '缺参安全视为无需写');
});

test('启动执行器：按纯函数规则决定闸门，跳过/失败均计数入摘要', () => {
  // 源码锚：规则经纯函数判定（不是内联布尔），摘要落盘供面板展示
  assert.ok(RUNNER_SOURCE.includes('shouldAdvanceDiaryRunDate({ roleCount: roles.length })'));
  assert.ok(RUNNER_SOURCE.includes('? setDiaryLastRunDate(withSummary, dayKey)'));
  assert.ok(RUNNER_SOURCE.includes(': withSummary'));
  assert.ok(RUNNER_SOURCE.includes('const outcome = { date: dayKey, written: 0, skipped: 0, failed: 0 };'));
  assert.ok(RUNNER_SOURCE.includes('outcome.skipped += 1;'));
  assert.ok(RUNNER_SOURCE.includes('outcome.failed += 1;'));
  assert.ok(RUNNER_SOURCE.includes('outcome.written += 1;'));
  assert.ok(RUNNER_SOURCE.includes('setDiaryLastRunSummary(nextSettings, outcome)'));
  // 已成功角色通过各自 lastDiaryDate 跳过，只补未完成的
  assert.ok(RUNNER_SOURCE.includes('markRoleDiaryDate(nextSettings, character.id, role.date)'));
});

test('设置摘要 lastRun：归一化与落盘（面板状态行数据源）', () => {
  const normalized = normalizeDiarySettings({ lastRun: { date: '2026-10-06', written: 2, skipped: 1, failed: 0 } });
  assert.deepEqual(normalized.lastRun, { date: '2026-10-06', written: 2, skipped: 1, failed: 0 });
  // 旧数据/非法值安全归零，不得因此判损坏
  assert.deepEqual(normalizeDiarySettings({}).lastRun, { date: '', written: 0, skipped: 0, failed: 0 });
  assert.deepEqual(normalizeDiarySettings({ lastRun: 'bad' }).lastRun, { date: '', written: 0, skipped: 0, failed: 0 });
  assert.equal(normalizeDiarySettings({ lastRun: { written: -3, failed: 'x' } }).lastRun.written, 0);
  const withSummary = setDiaryLastRunSummary({ roles: {} }, { date: '2026-10-06', written: 1, skipped: 2, failed: 1 });
  assert.deepEqual(withSummary.lastRun, { date: '2026-10-06', written: 1, skipped: 2, failed: 1 });
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

test('日记入口已在拓展首页注册（Stack 化，不再 embedded）', () => {
  const home = read('extension/ExtensionHome.js');
  assert.ok(home.includes("route: 'ext-diary'"), '首页有日记入口');
  assert.ok(read('extension/ExtensionStack.js').includes('DiaryPanel'), 'Stack 注册了 DiaryPanel');
  assert.equal(read('DiaryPanel.js').includes('embedded'), false, 'DiaryPanel 不再有 embedded prop');
});

test('日记面板：折叠选角色、单角色开关、专属 API 与左右滑动查看', () => {
  assert.ok(PANEL_SOURCE.includes('DiaryPanel'));
  assert.ok(PANEL_SOURCE.includes('选择角色'));
  // 折叠选择角色/API（不一次性罗列所有角色卡）
  assert.ok(PANEL_SOURCE.includes('rolePickerOpen'));
  assert.ok(PANEL_SOURCE.includes('apiPickerOpen'));
  assert.ok(PANEL_SOURCE.includes('setRoleDiarySetting'));
  assert.ok(PANEL_SOURCE.includes('selectDiariesForCharacter'));
  assert.ok(PANEL_SOURCE.includes('saveDiarySettings'));
  // 左右滑动翻阅日记 + 分页
  assert.ok(PANEL_SOURCE.includes('pagingEnabled'));
  assert.ok(PANEL_SOURCE.includes('diaryIndex'));
  assert.ok(PANEL_SOURCE.includes('onMomentumScrollEnd'));
  // 翻页按钮必须程序化滚动：只改 diaryIndex 不滚 ScrollView 的话按钮按了页面不动
  assert.ok(PANEL_SOURCE.includes('ref={pagerRef}'));
  assert.ok(PANEL_SOURCE.includes('pagerRef.current.scrollTo({ x: diaryIndex * viewWidth, animated: true })'));
});

test('条目归属字段：旧数据零迁移兼容，新字段归一/去重/封顶', () => {
  // 旧条目（无归属）：安全降级为 '' / []，不得因此判为损坏
  const legacy = normalizeDiaryEntry({ id: 'd1', characterId: 'c1', date: '2026-10-05', text: 'x' });
  assert.equal(legacy.sessionId, '');
  assert.deepEqual(legacy.sourceSessionIds, []);
  // 新字段归一：去重、去空、封顶
  const entry = normalizeDiaryEntry({
    id: 'd1', characterId: 'c1', date: '2026-10-06', text: 'x',
    sessionId: 's2',
    sourceSessionIds: ['s2', 's2', '', 's1', null, 's3'],
  });
  assert.equal(entry.sessionId, 's2');
  assert.deepEqual(entry.sourceSessionIds, ['s2', 's1', 's3']);
  const many = normalizeDiaryEntry({
    id: 'd2', characterId: 'c1', date: '2026-10-06', text: 'x',
    sourceSessionIds: Array.from({ length: DIARY_SOURCE_SESSION_LIMIT + 20 }, (_, i) => `s${i}`),
  });
  assert.equal(many.sourceSessionIds.length, DIARY_SOURCE_SESSION_LIMIT);
});

test('同日覆盖保留归属字段（重跑幂等不丢来源）', () => {
  const first = appendDiary([], {
    id: 'diary-c1-2026-10-06', characterId: 'c1', date: '2026-10-06', text: 'v1',
    sessionId: 's1', sourceSessionIds: ['s1'],
  });
  const second = appendDiary(first, {
    id: 'diary-c1-2026-10-06', characterId: 'c1', date: '2026-10-06', text: 'v2',
    sessionId: 's2', sourceSessionIds: ['s1', 's2'],
  });
  assert.equal(second.length, 1);
  assert.equal(second[0].text, 'v2');
  assert.equal(second[0].sessionId, 's2');
  assert.deepEqual(second[0].sourceSessionIds, ['s1', 's2']);
});

test('归属会话选择：只认窗口内的有效对话轮（排除 pending/无时间戳/越界）', () => {
  const now = new Date(2026, 9, 6, 10, 0, 0).getTime(); // 2026-10-06 10:00
  const { start } = yesterdayRange(now);
  const inside = start + 3600 * 1000;
  const outside = now - 60 * 1000;
  const bySession = {
    s1: [
      { role: 'user', text: 'a', timestamp: inside },
      { role: 'assistant', text: 'b', timestamp: inside + 1000 },
    ],
    s2: [
      { role: 'user', text: 'c', timestamp: inside + 500 },
      { role: 'assistant', text: 'pending', timestamp: inside + 2000, pending: true },
    ],
    s3: [
      { role: 'user', text: 'no-ts' },
      { role: 'user', text: 'today', timestamp: outside },
    ],
    s4: [],
  };
  const ids = ['s1', 's2', 's3', 's4'];
  // 只有 s1/s2 在窗口内有有效轮次；按最早消息时间排序（s1 的首条更早）
  assert.deepEqual(selectWindowSessions(bySession, ids, now), ['s1', 's2']);
  // 主会话：s1 有 2 轮、s2 有 1 轮 → s1
  assert.equal(pickPrimarySession(bySession, ids, now), 's1');
  // 并列时取最早开始的一段
  const tie = {
    a: [{ role: 'user', text: 'x', timestamp: inside + 100 }],
    b: [{ role: 'user', text: 'y', timestamp: inside + 50 }],
  };
  assert.equal(pickPrimarySession(tie, ['a', 'b'], now), 'b');
  // 无窗口消息时安全返回
  assert.deepEqual(selectWindowSessions({ s3: bySession.s3 }, ['s3'], now), []);
  assert.equal(pickPrimarySession({ s4: [] }, ['s4'], now), '');
});

test('执行器写入条目携带归属字段；面板展示来源并可跳转（源码锚）', () => {
  assert.ok(RUNNER_SOURCE.includes('selectWindowSessions(bySession, role.sessionIds, now)'));
  assert.ok(RUNNER_SOURCE.includes('pickPrimarySession(bySession, contributingSessionIds, now)'));
  assert.ok(RUNNER_SOURCE.includes('sourceSessionIds: contributingSessionIds'));
  const panel = read('DiaryPanel.js');
  assert.ok(panel.includes('diarySource'), '面板应解析来源会话');
  assert.ok(panel.includes("t('diary.source.deleted')"), '会话被删显示降级文案');
  assert.ok(panel.includes('switchSession(target.id)'), '来源行应可跳回会话');
  assert.ok(panel.includes('navigation.navigate(ROUTE_NAMES.chat)'));
  assert.ok(panel.includes('previousSessionId'), '跳转失败要回滚');
  // 旧条目无归属时不渲染来源行
  assert.ok(panel.includes('if (ids.length === 0) return null;'));
});

test('diaryStartup：跨天判定与执行（注入式，RN-free 可直测）', async () => {
  const now = new Date(2026, 9, 7, 9, 0, 0).getTime();
  assert.equal(shouldRunDiaryForDay({ lastRunDate: '2026-10-07', now }), false);
  assert.equal(shouldRunDiaryForDay({ lastRunDate: '2026-10-06', now }), true);
  assert.equal(shouldRunDiaryForDay({ lastRunDate: '', now }), true);

  // 同日：不执行
  let calls = 0;
  const same = await runDiaryIfNewDay({
    now,
    readSettings: async () => ({ lastRunDate: '2026-10-07' }),
    run: async () => { calls += 1; return 1; },
  });
  assert.deepEqual(same, { ran: false, written: 0, reason: 'same-day' });
  assert.equal(calls, 0);

  // 跨天：执行一次，返回写入数
  const cross = await runDiaryIfNewDay({
    now,
    readSettings: async () => ({ lastRunDate: '2026-10-05' }),
    run: async ({ now: passedNow }) => { calls += 1; assert.equal(passedNow, now); return 2; },
  });
  assert.equal(cross.ran, true);
  assert.equal(cross.written, 2);
  assert.equal(calls, 1);

  // 读设置失败：安全不跑（日记不能因设置损坏影响启动）
  const failedRead = await runDiaryIfNewDay({
    now,
    readSettings: async () => { throw new Error('boom'); },
    run: async () => { calls += 1; return 9; },
  });
  assert.equal(failedRead.ran, true, '读取失败视为无 lastRunDate（首跑）');
  assert.equal(calls, 2, '首跑语义：失败读设置也要给一次机会');
  // 未配置注入：不动
  assert.deepEqual(await runDiaryIfNewDay({}), { ran: false, written: 0, reason: 'not-configured' });
});

test('R4 可见化：运行摘要进诊断 + 面板状态行（源码锚）', () => {
  // 行首调用锚：注入态（void 0 && recordDiagnostic(）不得再命中
  assert.ok(/^\s{4}recordDiagnostic\(/m.test(RUNNER_SOURCE), '运行结果应进诊断（真实调用，非死代码）');
  assert.ok(/recordDiagnostic\(\s*\n\s*'startup',/.test(RUNNER_SOURCE), 'kind 用既有白名单（startup）');
  assert.ok(RUNNER_SOURCE.includes('written=${outcome.written} skipped=${outcome.skipped} failed=${outcome.failed}'));
  const panel = read('DiaryPanel.js');
  assert.ok(panel.includes("t('diary.lastRun'"), '面板应显示上次运行状态行');
  assert.ok(panel.includes('settings.lastRun'), '状态行数据来自设置摘要');
  // App 侧接线：只在 DiaryStartup 函数块内断言（App.js 里还有一个主动消息桥的
  // AppState 监听，裸串断言会被它满足——substring 陷阱）
  const app = read('../App.js');
  const startAt = app.indexOf('function DiaryStartup');
  const endAt = app.indexOf('function ProactiveMessageBridge');
  assert.ok(startAt > 0 && endAt > startAt, 'DiaryStartup 区块定位失败');
  const block = app.slice(startAt, endAt);
  const callCount = (block.match(/runDiaryIfNewDay\(/g) || []).length;
  assert.equal(callCount, 2, '冷启动与回前台各一次 runDiaryIfNewDay');
  assert.ok(block.includes("AppState.addEventListener('change'"), '应有回前台监听');
  assert.ok(block.includes('cameToForeground'), '只在回前台时补跑');
  assert.ok(block.includes('runDiaryForNewDay').valueOf(), '运行器经 diaryStartup 注入');
  assert.ok(block.includes('startedRef'), '冷启动一次性语义保留');
});

test('R1 面板：开关路径必须立即落盘，且不得「catch 后无条件成功提示」', () => {
  const panel = read('DiaryPanel.js');
  // 开关回调经 persistSettings → 立即 saveDiarySettings（不再是「只改内存 state」）
  assert.ok(panel.includes('const persistSettings = useCallback'), '应有落盘收口');
  assert.ok(panel.includes('.then(() => saveDiarySettings(next))'), '落盘必须真的写存储');
  assert.ok(
    panel.includes('persistSettings(current => setRoleDiarySetting(current, id, { enabled, roleName }))'),
    'toggleRole 必须走落盘收口（回归：只 setSettings 不落盘 = 日记永远不生成）'
  );
  assert.ok(
    panel.includes('persistSettings(current => setRoleDiarySetting(current, id, { apiConfigId }))'),
    'chooseRoleApi 同样即时落盘'
  );
  // 失败按真实结果分支：回滚到存储值 + 失败提示（禁止吞异常后报成功）
  const persist = panel.slice(panel.indexOf('const persistSettings'), panel.indexOf('const toggleRole'));
  assert.ok(persist.includes("setNotice(t('diary.notice.saveFailed'))"), '失败应提示失败');
  assert.ok(persist.includes('catch'), '写盘失败必须有失败分支');
  assert.ok(persist.indexOf('catch') < persist.indexOf("setNotice(t('diary.notice.saveFailed'))"), '失败提示在 catch 分支内');
  // 离开前 flush：在途写盘未完成不得静默丢弃
  assert.ok(panel.includes("navigation.addListener('beforeRemove'"), '应有离开拦截');
  assert.ok(panel.includes('inFlightRef.current === 0'), '无在途写时直接放行');
  assert.ok(panel.includes('writeChainRef.current.finally'), '有在途写时先 flush 再离开');
});

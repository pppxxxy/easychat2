// 跨端数据兼容测试：同一份存储被手机写、被桌面读（或反之）时不该丢字段。
//
// 为什么需要它：桌面与手机共用同一份 AsyncStorage 键。两端的写入路径都经过共享
// normalize，但**桌面构造的对象形状是否被 normalize 完整接住**，只有跑一遍才知道。
// 这类问题不会在单页测试里暴露——它是「桌面写进去、手机读出来是默认值」这种静默丢失。
//
// 覆盖三类边界：字段缺省 / 类型不一致 / 旧版本残留。
//
// 范围说明：只 import 能在 Node 里直接加载的零依赖模块（cardHelpers / worldInfo /
// autoBackupPolicy / diary）。chatOptions、security、music/library、books/shelves
// 在链上拖进 expo-file-system，那几个的归一行为由各页面的结构守卫覆盖。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCharacterFormState,
  characterWithFormState,
} from '../../../src/character/cardHelpers.js';
import { normalizeWorldEntry } from '../../../src/character/cardParser/worldInfo.js';
import { normalizeAutoBackupSettings } from '../../../src/backup/autoBackupPolicy.js';
import { normalizeDiaryEntry } from '../../../src/diary/diary.js';

test('角色：编辑保存不丢表单未覆盖的字段（...source 优先）', () => {
  // 模拟一份「手机写的」角色：含桌面表单不编辑的字段。
  const fromPhone = {
    id: 'c1',
    name: '小林',
    description: '描述',
    postHistoryInstructions: '历史后指令（手机编辑器会带上）',
    creatorNotes: '作者备注',
    voiceConfig: { voiceId: 'v1', speed: 1.2 },
    extensions: { some_mobile_only: true },
    createdAt: 1700000000000,
  };
  const form = buildCharacterFormState(fromPhone);
  const saved = characterWithFormState(fromPhone, { ...form, name: '小林改' });
  // 表单覆盖的字段生效。
  assert.equal(saved.name, '小林改');
  // 表单**不覆盖**的字段必须原样保留（否则手机端数据被桌面静默抹掉）。
  assert.equal(saved.postHistoryInstructions, '历史后指令（手机编辑器会带上）');
  assert.equal(saved.creatorNotes, '作者备注');
  assert.deepEqual(saved.voiceConfig, { voiceId: 'v1', speed: 1.2 });
  assert.deepEqual(saved.extensions, { some_mobile_only: true });
  assert.equal(saved.createdAt, 1700000000000);
  assert.equal(saved.id, 'c1', 'id 不能被表单改掉');
});

test('角色：字段缺省时表单给出安全默认（不产生 undefined）', () => {
  const form = buildCharacterFormState(null);
  for (const [key, value] of Object.entries(form)) {
    assert.notEqual(value, undefined, `${key} 不应是 undefined`);
  }
  assert.equal(form.voiceDisplay, 'text', '缺失语音形态应回落 text');
  // 类型不一致的常见形态：非法枚举值。
  assert.equal(buildCharacterFormState({ voiceDisplay: 'bogus' }).voiceDisplay, 'text');
});

test('角色：worldInfo / regexScripts / tags 类型不一致时归一为数组', () => {
  const form = buildCharacterFormState({ worldInfo: 'not-an-array', regexScripts: { a: 1 }, tags: 'x,y' });
  assert.deepEqual(form.worldInfo, [], 'worldInfo 应归一为空数组');
  assert.deepEqual(form.regexScripts, [], 'regexScripts 应归一为空数组');
  assert.deepEqual(form.tags, [], 'tags 应归一为空数组');
});

test('世界书条目：旧版本放在 extensions 里的字段要被读出来', () => {
  // SillyTavern 把 depth / probability / scan_depth 放 extensions：只读顶层会静默重置。
  const entry = normalizeWorldEntry({
    content: '正文',
    keys: ['a'],
    extensions: { depth: 7, probability: 55, scan_depth: 3 },
  }, 0);
  assert.equal(entry.depth, 7, 'extensions.depth 应被读出');
  assert.equal(entry.probability, 55, 'extensions.probability 应被读出');
  assert.equal(entry.scanDepth, 3, 'extensions.scan_depth 应被读出（下划线写法）');
});

test('世界书条目：缺省字段给安全默认（不产生 undefined 数值）', () => {
  const empty = normalizeWorldEntry({}, 0);
  assert.equal(empty.depth, 4);
  assert.equal(empty.probability, 100);
  assert.equal(empty.scanDepth, null);
  assert.equal(typeof empty.content, 'string');
  assert.ok(Array.isArray(empty.keys));
});

test('自动备份：旧版本/缺失字段的间隔被夹回合法区间', () => {
  const settings = normalizeAutoBackupSettings({ intervalMs: 'abc' });
  assert.ok(Number.isFinite(settings.intervalMs), '间隔必须是数值');
  assert.ok(settings.intervalMs > 0, '间隔必须为正');
  // 极端值被夹取（不能出现 0 或 1 毫秒这种「每次操作都备份」的配置）。
  assert.ok(normalizeAutoBackupSettings({ intervalMs: 1 }).intervalMs >= 60 * 60 * 1000,
    '过小的间隔应被夹到下限');
});

test('日记条目：缺失 / 类型错误都不产生畸形对象', () => {
  const entry = normalizeDiaryEntry({ date: '2026-01-01' });
  assert.equal(typeof entry.text, 'string');
  assert.ok(Array.isArray(entry.sourceSessionIds), 'sourceSessionIds 应为数组');
  // 类型不一致：该是数组给了字符串。
  const coerced = normalizeDiaryEntry({ sourceSessionIds: 'abc' });
  assert.ok(Array.isArray(coerced.sourceSessionIds), '字符串应被归一为空数组');
});
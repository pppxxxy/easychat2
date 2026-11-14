// 桌面外壳结构守卫（S32）：跨端数据兼容。
//
// 桌面与手机共用同一份 AsyncStorage 键。两边写入都经过共享 normalize，但**桌面构造
// 的对象形状是否被消费方正确读取**只有逐个字段核对才知道。这类问题不会在单页测试里
// 暴露——它是「桌面写进去、手机/聊天读出来是默认值」这种静默丢失。
//
// 本轮查出的真缺口：制卡预设用错了字段名。
//   手机/ChatScreen 的注入路径读 `item.prompt` 并按 `item.enabled !== false` 过滤；
//   我写的制卡高级区块用 `content` 且没有 enabled。`content` 只有在经过
//   normalizeCharacterPreset 时才会被映射成 prompt，而**制卡草稿不经过 normalize**
//   （它直接被保存与发送），所以桌面新建的预设在聊天里是空的。
//
// 经核对已正确的：世界书（comment/keys/content/constant/enabled）与正则
// （findRegex/replaceString）用的都是共享层的规范字段名。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(HERE, '..');
const ROOT = path.resolve(DESKTOP, '..');
const read = (...parts) => readFileSync(path.join(DESKTOP, ...parts), 'utf8');
const readRoot = (...parts) => readFileSync(path.join(ROOT, ...parts), 'utf8');

const FORGE_ADV = read('src', 'extension', 'screens', 'ForgeAdvancedPanels.jsx');
const CHARACTER_EDIT = read('src', 'character', 'CharacterEditScreen.jsx');

test('跨端写入：桌面不碰存储 key 字面量（形状由共享 normalize 决定）', () => {
  // 这是一条架构性保证：桌面只要不自己拼 key，写入形状就不可能绕过归一。
  const sources = ['src/provider/DesktopApp.jsx', 'src/settings/SettingsScreen.jsx',
    'src/extension/screens/DiaryScreen.jsx', 'src/extension/screens/MomentsScreen.jsx'];
  for (const file of sources) {
    const text = read(...file.split('/'));
    assert.ok(!/['"]@easychat2_/.test(text), `${file} 不应出现存储 key 字面量`);
  }
});

test('角色：编辑保存保留表单未覆盖的字段（...source 在前）', () => {
  // 共享 helper 是两端共用的；这里钉住实现顺序（...source 先展开，表单值覆盖）。
  const shared = readRoot('src', 'character', 'cardHelpers.js');
  const fn = shared.slice(shared.indexOf('export function characterWithFormState'));
  assert.ok(/\.\.\.source,\s*\.\.\.state,/.test(fn.slice(0, 300)),
    '必须先展开 source 再展开 state（否则手机端独有字段被抹掉）');
});

test('制卡预设：字段名必须是 prompt + enabled（与注入路径一致）', () => {
  assert.ok(/prompt: ''/.test(FORGE_ADV), '新建预设应写 prompt 字段');
  assert.ok(/enabled: true/.test(FORGE_ADV), '新建预设应带 enabled');
  assert.ok(/preset\.prompt/.test(FORGE_ADV), '编辑应读写 prompt');
  assert.ok(/preset\.enabled/.test(FORGE_ADV), '应能切换 enabled');
  // 不得再写 content（normalize 才会映射，而草稿不经过 normalize）。
  // 注意排除 i18n key：forge.preset.contentPlaceholder 里的 content 只是词条名。
  assert.ok(!/preset\.content(?!Placeholder)/.test(FORGE_ADV), '不得再用 preset.content 字段');

  // 注入侧的真实判据（作为基准，漂移时本守卫应提醒复核）。
  const pipeline = readRoot('src', 'prompt', 'chatPipeline.js');
  assert.ok(/item\.enabled !== false/.test(pipeline), '注入应按 enabled 过滤');
  assert.ok(/item\.prompt/.test(pipeline), '注入应读 prompt');
});

test('制卡世界书 / 正则：字段名与共享规范一致', () => {
  for (const field of ['comment', 'keys', 'content', 'constant', 'enabled']) {
    assert.ok(new RegExp(`entry\\.${field}`).test(FORGE_ADV) || FORGE_ADV.includes(`{ ${field}:`),
      `世界书应使用规范字段 ${field}`);
  }
  for (const field of ['findRegex', 'replaceString', 'name', 'enabled']) {
    assert.ok(new RegExp(`script\\.${field}`).test(FORGE_ADV), `正则应使用规范字段 ${field}`);
  }
  // 规范字段的权威定义在共享层。
  const world = readRoot('src', 'character', 'cardParser', 'worldInfo.js');
  assert.ok(/^\s+comment:/m.test(world), '共享层应返回 comment 字段');
  const regex = readRoot('src', 'character', 'cardParser', 'regexScripts.js');
  assert.ok(/findRegex:/.test(regex), '共享层应返回 findRegex 字段');
});

test('角色编辑：表单不编辑的字段不会被默认值覆盖', () => {
  // buildCharacterFormState 只产出它认识的字段；其余靠 characterWithFormState 的
  // ...source 保留。这条断言防止有人把 helper 改成「只输出表单字段」。
  const shared = readRoot('src', 'character', 'cardHelpers.js');
  assert.ok(/export function buildCharacterFormState/.test(shared), '应有表单状态构造');
  assert.ok(/export function characterWithFormState/.test(shared), '应有回写构造');
  // 桌面编辑页必须走这套 helper，而不是自己拼对象。
  assert.ok(CHARACTER_EDIT.includes('buildCharacterFormState'), '桌面应用共享表单构造');
  assert.ok(CHARACTER_EDIT.includes('characterWithFormState'), '桌面应用共享回写');
});
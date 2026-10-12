// 角色库列表的滚动内边距守卫（2026-10-06 遮挡修复）。
// 背景：FlatList 化（d8d2644）后 padding 挂在 FlatList 的 style（外框）而非
// contentContainerStyle（内容）——RN 文档明确告诫的反模式：Android 静止时
// getMaxScrollY 会扣 paddingBottom 所以只是「差一点」，但 JS 侧 visibleLength
// 含 frame padding，scrollToEnd/定位滑块系统性少滚（上下 padding 之和），
// iOS 惯性滚动内容还会滑进 padding 区被裁。
// 同时钉住：characterStyles.container 的 padding 是 CharacterDetailScreen 的
// ScrollView 依赖，不许「顺手清理」。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { zhCN } from '../src/i18n/locales/zh-CN.js';
import { en } from '../src/i18n/locales/en.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCREEN = readFileSync(path.join(HERE, '..', 'src', 'character', 'CharacterLibraryScreen.js'), 'utf8');
// 群聊创建弹层已外提到该模块，成员计数文案断言需读新文件。
const GROUP_MODAL = readFileSync(path.join(HERE, '..', 'src', 'character', 'GroupCreateModal.js'), 'utf8');
const STYLES = readFileSync(path.join(HERE, '..', 'src', 'character', 'characterStyles.js'), 'utf8');
// 库列表 <FlatList ...> 的完整元素文本
const flatListStart = SCREEN.indexOf('<FlatList');
assert.ok(flatListStart > 0, '找不到库列表 FlatList');
const flatListEnd = SCREEN.indexOf('/>', flatListStart);
const FLAT_LIST = SCREEN.slice(flatListStart, flatListEnd);

test('库列表 FlatList：style 无 padding 语义，内容内边距走 contentContainerStyle', () => {
  assert.ok(FLAT_LIST.includes('contentContainerStyle={styles.listContent}'), 'FlatList 必须接 contentContainerStyle={styles.listContent}');
  assert.ok(FLAT_LIST.includes('style={styles.flex}'), 'FlatList 外框应为无 padding 的 styles.flex');
  assert.ok(!FLAT_LIST.includes('style={styles.container}'), '外框不得再挂带 padding 的 container（反模式回潮）');
});

test('characterStyles：listContent 含四向内边距（底 24 对齐记忆页）', () => {
  const start = STYLES.indexOf('listContent:');
  assert.ok(start > 0, 'characterStyles 缺 listContent 定义');
  const line = STYLES.slice(start, STYLES.indexOf('}', start));
  assert.ok(line.includes('paddingHorizontal: 18'), '横向内边距 18（与旧版一致）');
  assert.ok(line.includes('paddingTop: 18'), '顶部内边距 18（承接旧版 frame padding）');
  assert.ok(line.includes('paddingBottom: 24'), '底部净空 24（对齐记忆页 listContent）');
  // flex 外框：铺满 + 背景色，无任何 padding
  const flexStart = STYLES.indexOf('flex: {');
  assert.ok(flexStart > 0, 'characterStyles 缺 flex 外框定义');
  const flexLine = STYLES.slice(flexStart, STYLES.indexOf('}', flexStart));
  assert.ok(!flexLine.includes('padding'), 'flex 外框不得带 padding');
});

test('container 的 padding 保留：CharacterDetailScreen 的 ScrollView 依赖它', () => {
  const start = STYLES.indexOf('container: {');
  const line = STYLES.slice(start, STYLES.indexOf('}', start));
  assert.ok(line.includes('padding: 18'), 'container 的 padding 不得删（详情页共用此样式）');
  const detail = readFileSync(path.join(HERE, '..', 'src', 'character', 'CharacterDetailScreen.js'), 'utf8');
  assert.ok(detail.includes('style={styles.container}'), '详情页 ScrollView 仍在用 container，删 padding 会破坏详情页布局');
});

test('角色库头部动作组可换行：英文长标签不再把按钮挤出屏幕', () => {
  // 三枚胶囊（新建 / Group Chat / Select）包进 cardActions 动作组，与标题行分开。
  assert.ok(SCREEN.includes('styles.cardActions'), '三枚胶囊应包在 cardActions 动作组里');
  const headerStart = STYLES.indexOf('cardHeader: {');
  const headerLine = STYLES.slice(headerStart, STYLES.indexOf('}', headerStart));
  assert.ok(headerLine.includes("flexWrap: 'wrap'"), 'cardHeader 应允许换行（标题与动作组分两行）');
  const actionsStart = STYLES.indexOf('cardActions: {');
  assert.ok(actionsStart > 0, 'characterStyles 缺 cardActions 定义');
  const actionsLine = STYLES.slice(actionsStart, STYLES.indexOf('}', actionsStart));
  assert.ok(actionsLine.includes("flexWrap: 'wrap'"), 'cardActions 应允许组内换行');
  assert.ok(actionsLine.includes("marginLeft: 'auto'"), '动作组应靠右（换行后仍贴右缘）');
  // 硬编码中文清干净：这些文案一律走 i18n
  assert.ok(!SCREEN.includes("'多选'"), '多选应走 t(character.library.select)');
  assert.ok(!SCREEN.includes("'全选'"), '全选应走 t(common.selectAll)');
  assert.ok(!SCREEN.includes('已选'), '已选计数应走 t(character.library.selectedCount)');
  assert.ok(!SCREEN.includes('折叠角色列表'), '折叠角色列表应走 i18n');
  assert.ok(!SCREEN.includes('创建中'), '创建中应走 i18n');
  assert.ok(!SCREEN.includes('未命名'), '未命名兜底应走 t(common.unnamedCharacter)');
  assert.ok(!SCREEN.includes('当前：${'), '页头「当前：」应走 t(character.library.currentLabel)');
  assert.ok(!SCREEN.includes('本卡由 AI 生成'), 'AIGC 角标应走 t(character.library.aigcBadge)');
  assert.ok(SCREEN.includes("t('character.library.select')"));
  assert.ok(SCREEN.includes("t('character.library.expandAll', { count: characterDisplayItems.length })"));
  assert.ok(SCREEN.includes("t('character.library.currentLabel', {"));
  assert.ok(GROUP_MODAL.includes("t('character.library.group.selectMembers', { count: groupSelected.length })"));
  // 词条两语言都在，英文确实较短（这是「挤不下」的根因）
  assert.equal(zhCN['character.library.select'], '多选');
  assert.equal(en['character.library.select'], 'Select');
  assert.equal(en['character.library.expandAll'], 'Show all characters ({count})');
  assert.equal(en['common.selectAll'], 'Select All');
  assert.equal(en['common.deselectAll'], 'Deselect All');
  assert.equal(en['character.library.currentLabel'], 'Current: {name}');
  assert.equal(en['character.library.group.selectMembers'], 'Select members ({count} selected / 2-8)');
  assert.equal(en['common.unnamedCharacter'], 'Unnamed character');
});

// 设置页布局守卫：三处溢出修复的收缩协商 + 分区顺序/搜索索引对齐。
// 背景（2026-10-07 真机截图取证）：
// - API 名长时「教学/新建」被推出屏——collapseSummary 无 flexShrink，RN 里
//   numberOfLines 只在宽度受限时才截断，文本不收缩就永不截断（与拓展页
//   PaneHeader 溢出同构）；摘要短时按钮又贴死折叠箭头（零间距）；
// - 生成参数字段行大字体下 Switch 被挤出——linkLeft 无弹性、samplingInput
//   minWidth 固定，无收缩协商；
// - 分区调序后五处同步（JSX 顺序/渲染数组/sticky/offsets/搜索索引）易漏，
//   漏一处即搜索跳错或吸顶错位——「关于必须殿底」与索引对齐都钉死在这里。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { SETTINGS_SEARCH_INDEX, settingsSectionLabel } from '../src/settings/searchIndex.js';

const read = relativePath => fs.readFileSync(path.resolve(relativePath), 'utf8');

test('折叠头收缩协商：headRight 可缩、箭头有间距、摘要文本可截断', () => {
  const collapsible = read('src/ui/Collapsible.js');
  assert.ok(/headRight:\s*\{[^}]*flexShrink:\s*1/.test(collapsible), 'headRight 必须参与收缩协商');
  assert.ok(/headChevron:\s*\{[^}]*marginLeft/.test(collapsible), '折叠箭头与右侧插槽之间必须有保底间距');
  assert.ok(collapsible.includes('style={styles.headChevron}'), '折叠箭头必须实际接线间距样式（定义而不用=假修复）');

  const styles = read('src/settings/settingsStyles.js');
  assert.ok(/collapseSummary:\s*\{[^}]*flexShrink:\s*1/.test(styles),
    'collapseSummary 必须有 flexShrink——numberOfLines 只在宽度受限时才截断');
});

test('生成参数行挤压顺序：字段名省略 → 输入框收窄 → Switch 固定', () => {
  const card = read('src/settings/SamplingCard.js');
  assert.ok(/<Text style=\{styles\.linkText\} numberOfLines=\{1\}>/.test(card), '字段名必须 numberOfLines 截断');
  assert.ok(/<Text style=\{styles\.collapseSummary\} numberOfLines=\{1\}>/.test(card), '卡头摘要必须 numberOfLines 截断');
  const styles = read('src/settings/settingsStyles.js');
  assert.ok(/linkLeft:\s*\{[^}]*flex:\s*1/.test(styles), 'linkLeft 必须吃剩余空间（受挤压先收缩）');
  assert.ok(/linkText:\s*\{[^}]*flexShrink:\s*1/.test(styles), 'linkText 必须可缩（否则省略号不生效）');
  assert.ok(/samplingInput:\s*\{[^}]*flexShrink:\s*1/.test(styles), 'samplingInput 必须可收窄');
  assert.ok(/samplingInput:\s*\{[^}]*minWidth:\s*84/.test(styles), 'samplingInput 保底下限 84 不得丢');
});

test('分区顺序：关于殿底、语言倒数第二，渲染顺序与搜索索引对齐', () => {
  const screen = read('src/SettingsScreen.js');
  const match = /const SECTION_RENDER_ORDER = \[([^\]]*)\]/.exec(screen);
  assert.ok(match, 'SECTION_RENDER_ORDER 必须是模块级数组字面量（五处同步的单一事实源）');
  const order = match[1].split(',').map(part => part.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  assert.equal(order[order.length - 1], 'about', '关于必须是最后一张卡（用户硬诉求）');
  assert.equal(order[order.length - 2], 'language', '语言在关于之前');
  assert.ok(order.includes('localmodel'), '本地模型必须是独立卡');
  assert.ok(order.indexOf('localmodel') > order.indexOf('github'), '本地模型卡在 GitHub 之后');
  assert.equal(new Set(order).size, order.length, '分区 id 不得重复');

  // 五处同步之搜索索引：sectionId 必须都在渲染顺序内，否则搜索跳错/吸顶错位
  for (const entry of SETTINGS_SEARCH_INDEX) {
    assert.ok(order.includes(entry.sectionId),
      `搜索条目「${entry.label}」的 sectionId=${entry.sectionId} 必须在 SECTION_RENDER_ORDER 内`);
  }
  assert.equal(settingsSectionLabel('localmodel'), '本地模型', '搜索结果的分区名必须登记');
  assert.ok(settingsSectionLabel('about'), '关于的分区名保留');

  // 五处同步之 offsets：新卡必须登记 onLayout（滚动定位用）
  assert.ok(screen.includes('sectionOffsetsRef.current.localmodel'), '本地模型卡必须登记 onLayout 偏移');
  // 吸顶索引由渲染顺序数组推导（自动跟随，禁止另写一份）
  assert.ok(/stickyHeaderIndices = SECTION_RENDER_ORDER/.test(screen), '吸顶索引必须由 SECTION_RENDER_ORDER 推导');

  // 旧挂载点清理：关于卡不再含本地模型入口；新卡直连面板
  const about = read('src/settings/sections/AboutSection.js');
  assert.ok(!about.includes('localModel') && !about.includes('localmodel'), 'AboutSection 不得再含本地模型入口');
  assert.ok(screen.includes("t('settings.localModel.title')"), '本地模型独立卡使用新文案键');
  assert.ok(screen.includes('onPress={() => setLocalModelOpen(true)}'), '本地模型卡直连面板');
  // 文案键迁移：旧键退役
  const locales = ['src/i18n/locales/zh-CN.js', 'src/i18n/locales/en.js'];
  for (const file of locales) {
    const table = read(file);
    assert.ok(!table.includes("'settings.about.localModel'"), `${file} 旧键 settings.about.localModel 必须删除`);
    assert.ok(table.includes("'settings.localModel.title'") && table.includes("'settings.localModel.entry'"),
      `${file} 必须有 settings.localModel.title/entry`);
  }
});

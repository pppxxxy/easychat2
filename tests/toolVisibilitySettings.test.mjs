// 设置页「工具使用提示」分区的接线与词条。
//
// 这一批的风险不在算法（判定与状态变换已由 tests/toolNoticeVisibility.test.mjs 与
// tests/toolBubbleVisibility.test.mjs 覆盖），而在**接线**：
//   - 卡片定义了却没人渲染（用户根本看不到开关）；
//   - 设置页手抄一份工具清单（新增工具时开关漏掉——本仓库被咬过六次以上）；
//   - 界面自己算 hideAll / hiddenToolNotices（与运行时判定漂移，出现「显示已隐藏其实没隐藏」）；
//   - 用户可见文案漏了「失败与确认不受影响」这句（隐藏了却还弹确认会被当成 bug）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { zhCN } from '../src/i18n/locales/zh-CN.js';
import { en } from '../src/i18n/locales/en.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = rel => fs.readFileSync(path.join(HERE, '..', rel), 'utf8');

const TOOL_NOTICE_KEYS = [
  'settings.toolNotice.sectionTitle',
  'settings.toolNotice.hideAll',
  'settings.toolNotice.hideAllHint',
  'settings.toolNotice.stateVisible',
  'settings.toolNotice.stateHidden',
  'settings.toolNotice.stateHiddenByAll',
  'settings.toolNotice.boundaryHint',
];

test('设置分区接线：卡片存在、由扩展分区渲染、清单从 chatTools 派生', () => {
  const section = read('src/settings/sections/ExtensionsSection.js');
  const card = read('src/settings/sections/ToolVisibilityCard.js');
  assert.ok(section.includes("import ToolVisibilityCard from './ToolVisibilityCard.js';"), '扩展分区必须引入卡片');
  assert.ok(section.includes('<ToolVisibilityCard'), '必须真的渲染（定义而不用 = 假接线）');
  assert.ok(card.includes('listChatToolDefinitions('), '工具清单必须从定义派生，不许手抄数组');
  assert.ok(card.includes('isToolNoticeHidden('), '生效状态必须问判定层，界面不自算 hideAll');
  // 零余量棘轮：SettingsScreen.js 停在基线上，装配落在扩展分区文件里
  assert.equal(read('src/SettingsScreen.js').includes('ToolVisibilityCard'), false,
    'SettingsScreen 行数零余量：装配不进屏幕，留在扩展分区');
});

test('设置搜索能命中「工具提示」并指向扩展分区（否则折叠卡里翻不到）', () => {
  const index = read('src/settings/searchIndex.js');
  // 标签走 i18n key（2026-10-12 收敛）：索引里认键，措辞在 settings 词条里。
  assert.ok(index.includes("labelKey: 'settings.toolNotice.sectionTitle'"), '搜索索引必须收录本分区');
  assert.ok(/sectionId: 'extensions', labelKey: 'settings\.toolNotice\.sectionTitle'/.test(index), '必须挂在扩展分区下');
  assert.ok(index.includes("'隐藏工具'"), '关键词要覆盖用户会输入的词');
});

test('「工具使用提示」词条中英齐备', () => {
  TOOL_NOTICE_KEYS.forEach(key => {
    assert.equal(typeof zhCN[key], 'string', `zh-CN 缺 ${key}`);
    assert.ok(zhCN[key].length > 0, `zh-CN ${key} 不得为空`);
    assert.equal(typeof en[key], 'string', `en 缺 ${key}`);
    assert.ok(en[key].length > 0, `en ${key} 不得为空`);
  });
});

test('文案必须把两条边界讲给用户听：失败照常显示、确认照常弹', () => {
  // 这是本功能的知情同意部分：用户开开关前必须知道「隐藏的是什么、没隐藏什么」。
  const zh = zhCN['settings.toolNotice.hideAllHint'];
  const english = en['settings.toolNotice.hideAllHint'];
  assert.ok(zh.includes('确认'), '中文必须说明审批不受影响');
  assert.ok(zh.includes('失败') || zh.includes('出错'), '中文必须说明失败照常显示');
  assert.ok(english.toLowerCase().includes('confirmation'), '英文必须说明审批不受影响');
  assert.ok(english.toLowerCase().includes('failed'), '英文必须说明失败照常显示');
});

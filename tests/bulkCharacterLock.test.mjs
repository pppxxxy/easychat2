// 角色锁「批量上锁 + 密码提示」接线契约测试。
// 背景（2026-10-09 用户需求）：① 单角色锁之外新增多选/全选，统一设一个密码；
// ② 加锁时可写一条「密码提示」给自己，忘记密码时点开提示帮回忆。
// 逻辑本体在 storage/security.js（tests/securityStorage.test.mjs 覆盖），
// 这里守住 UI 接线与文案：任何一环被改断，用户侧就是入口消失或点了没反应。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { localeSource } from './helpers/localeSource.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = relative => readFileSync(path.join(HERE, '..', relative), 'utf8');

const sectionSrc = read('src/settings/sections/SecuritySection.js');
const pickerSrc = read('src/settings/sections/BulkLockPickerModal.js');
const settingsSrc = read('src/SettingsScreen.js');
const pinSrc = read('src/security/PinModal.js');
const zh = localeSource('src/i18n/locales/zh-CN');
const en = localeSource('src/i18n/locales/en');

test('SecuritySection：批量入口 + 已锁角色的提示入口都已接线', () => {
  assert.ok(sectionSrc.includes('onBulkLock'), '批量上锁回调应透传');
  assert.ok(sectionSrc.includes('onShowHint'), '查看提示回调应透传');
  assert.ok(sectionSrc.includes("t('settings.security.bulkLock')"), '批量入口文案');
  assert.ok(sectionSrc.includes('bulb-outline'), '已锁行应有灯泡入口（忘记密码的回忆入口）');
  assert.ok(sectionSrc.includes("t('settings.security.hint.show'"), '灯泡的无障碍标签');
  // 提示按钮只在已锁角色上出现：未锁角色没有密码，也就没有提示可看
  const hintBlock = sectionSrc.slice(sectionSrc.indexOf('hintButton'));
  assert.ok(hintBlock.includes('{locked ?'), '提示按钮须以 locked 为条件渲染');
});

test('BulkLockPickerModal：多选、全选/全不选、确认回调', () => {
  assert.ok(pickerSrc.includes('export default function BulkLockPickerModal'), '组件存在');
  assert.ok(pickerSrc.includes('toggleAll'), '全选/全不选切换');
  assert.ok(pickerSrc.includes("new Set(list.map(item => item.id))"), '全选即选中全部角色');
  assert.ok(pickerSrc.includes("if (visible) setSelected(new Set())"), '每次打开重置勾选（防误锁一批）');
  assert.ok(pickerSrc.includes('onConfirm(ids)'), '确认回传选中的 id 列表');
  assert.ok(pickerSrc.includes('disabled={selected.size === 0}'), '未勾选任何角色时下一步不可用');
  assert.ok(pickerSrc.includes("t('settings.security.bulk.selectAll')"), '全选文案');
  assert.ok(pickerSrc.includes("t('settings.security.bulk.clearAll')"), '全不选文案');
});

test('SettingsScreen：批量两步流程 + 提示查看，且批量存储函数不被 state setter 遮蔽', () => {
  // 回归焦点：本页 useState 的 setter 也叫 setCharacterLocks，直接同名导入会被遮蔽，
  // 批量上锁会误调 state setter（lint 抓到过一次，这里钉死别名）。
  assert.ok(settingsSrc.includes('setCharacterLocks as setCharacterLocksBulk'),
    '同名遮蔽防护：批量存储函数必须以别名导入');
  assert.ok(settingsSrc.includes('await setCharacterLocksBulk('), '批量提交走存储函数');

  assert.ok(settingsSrc.includes('handleBulkConfirm'), '第一歩（选人）到第二步（设密码）的交接');
  assert.ok(settingsSrc.includes('handleBulkPinSubmit'), '批量设密码提交');
  assert.ok(settingsSrc.includes('onConfirm={handleBulkConfirm}'), '选择弹窗的确认接线');
  // PinModal 由单角色与批量共用，提交按目标分派
  assert.ok(settingsSrc.includes('onSubmit={pinTarget ? handlePinSubmit : handleBulkPinSubmit}'),
    '单角色/批量提交分派');

  assert.ok(settingsSrc.includes('showLockHint'), '查看提示的处理函数');
  assert.ok(settingsSrc.includes('getCharacterLockHint'), '提示从安全存储读');
  assert.ok(settingsSrc.includes("t('settings.security.hint.remove')"), '提示弹窗里可删除提示');

  assert.ok(settingsSrc.includes('onBulkLock: () => setBulkLockOpen(true)'), 'sectionProps 透传批量入口');
  assert.ok(settingsSrc.includes('onShowHint: showLockHint'), 'sectionProps 透传提示入口');
});

test('PinModal：set 模式带密码提示输入，onSubmit 回传 (pin, hint)', () => {
  assert.ok(pinSrc.includes('showHint'), '提示输入开关（验证弹窗不显示）');
  assert.ok(pinSrc.includes("showHint === undefined ? mode === 'set'"),
    '默认：set 显示、verify 隐藏');
  assert.ok(pinSrc.includes('LOCK_HINT_MAX_LENGTH'), '提示限长');
  assert.ok(pinSrc.includes('normalizeLockHint'), '提示经过归一化');
  assert.ok(pinSrc.includes("onSubmit(pin, hintVisible ? normalizeLockHint(hint) : undefined)"),
    '提交时必须把提示一起交给调用方');
  assert.ok(pinSrc.includes("t('settings.security.pin.hintNote')"), '提示用途说明（给自己看）');
});

test('i18n：批量上锁与密码提示的文案中英齐全', () => {
  const keys = [
    'settings.security.bulkLock',
    'settings.security.bulk.title',
    'settings.security.bulk.hint',
    'settings.security.bulk.selectAll',
    'settings.security.bulk.clearAll',
    'settings.security.bulk.selected',
    'settings.security.bulk.next',
    'settings.security.bulk.locked',
    'settings.security.bulk.pinTitle',
    'settings.security.bulk.pinSubtitle',
    'settings.security.bulk.done',
    'settings.security.pin.hintPlaceholder',
    'settings.security.pin.hintNote',
    'settings.security.hint.show',
    'settings.security.hint.title',
    'settings.security.hint.empty',
    'settings.security.hint.remove',
  ];
  for (const key of keys) {
    assert.ok(zh.includes(`'${key}'`), `中文缺键：${key}`);
    assert.ok(en.includes(`'${key}'`), `英文缺键：${key}`);
  }
});

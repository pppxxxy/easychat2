// i18n 核心：语言解析、词条回退、插值与漏译检查。
//
// src/i18n/index.js 是零依赖纯逻辑（Provider 在 I18nContext.js，含 RN 依赖），
// 所以这里可以直接 import，不需要打桩 react-native。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BASE_LOCALE,
  LOCALES,
  LOCALE_IDS,
  allKeys,
  getBundle,
  interpolate,
  isSupportedLocale,
  missingKeys,
  resolveLocale,
  translate,
} from '../src/i18n/index.js';
import { zhCN } from '../src/i18n/locales/zh-CN.js';
import { en } from '../src/i18n/locales/en.js';

test('语言清单：基准语言在中，且每个语言有自名与英文名', () => {
  assert.equal(BASE_LOCALE, 'zh-CN');
  assert.ok(LOCALE_IDS.includes('zh-CN'));
  assert.ok(LOCALE_IDS.includes('en'));
  for (const item of LOCALES) {
    assert.ok(item.id && item.label && item.english, `${item.id} 应同时有 label 与 english`);
  }
  // 语言名用各自写法：中文在英文界面下也显示为「简体中文」
  assert.equal(LOCALES.find(i => i.id === 'zh-CN').label, '简体中文');
});

test('resolveLocale：容忍常见变体，未知语言回退基准', () => {
  assert.equal(resolveLocale('en'), 'en');
  assert.equal(resolveLocale('EN'), 'en');
  assert.equal(resolveLocale('en-US'), 'en');
  assert.equal(resolveLocale('en_US'), 'en');
  assert.equal(resolveLocale('zh-CN'), 'zh-CN');
  assert.equal(resolveLocale('zh'), 'zh-CN');
  assert.equal(resolveLocale('zh-Hans-CN'), 'zh-CN');
  assert.equal(resolveLocale('zh_CN'), 'zh-CN');
  // 未支持的语言（后续批次才有）回退到基准，而不是显示空白
  assert.equal(resolveLocale('ja'), 'zh-CN');
  assert.equal(resolveLocale('ar'), 'zh-CN');
  assert.equal(resolveLocale(''), 'zh-CN');
  assert.equal(resolveLocale(null), 'zh-CN');
  assert.equal(resolveLocale(undefined), 'zh-CN');
  assert.equal(isSupportedLocale('ja'), false);
  assert.equal(isSupportedLocale('en'), true);
});

test('interpolate：替换已给参数，保留缺失占位符', () => {
  assert.equal(interpolate('已选择 {count} 条', { count: 3 }), '已选择 3 条');
  assert.equal(interpolate('{a} 和 {b}', { a: 'x', b: 'y' }), 'x 和 y');
  assert.equal(interpolate('{a} {b}', { a: 'x' }), 'x {b}', '缺失参数保留占位符便于排查');
  assert.equal(interpolate('无占位符', { a: 1 }), '无占位符');
  assert.equal(interpolate('{n}', { n: 0 }), '0', '0 是有效值，不应被当成缺失');
  assert.equal(interpolate('{n}', { n: null }), '{n}');
  assert.equal(interpolate(null, {}), '');
  assert.equal(interpolate('{a}', null), '{a}', '无参数时原样返回');
});

test('translate：按语言取值，缺失回退基准语言，再缺才返回 key', () => {
  assert.equal(translate('zh-CN', 'app.tab.chat'), '聊天');
  assert.equal(translate('en', 'app.tab.chat'), 'Chat');
  // 英文缺某 key 时回退中文（本批次英文是按批次补齐的）
  const zhOnlyKey = Object.keys(zhCN).find(key => !(key in en));
  if (zhOnlyKey) {
    assert.equal(translate('en', zhOnlyKey), zhCN[zhOnlyKey], `英文缺 ${zhOnlyKey} 应回退中文`);
  }
  // 两种语言都没有的 key：返回 key 本身（便于开发期发现漏登记）
  assert.equal(translate('en', 'nonexistent.key'), 'nonexistent.key');
  assert.equal(translate('zh-CN', ''), '');
});

test('词条表：key 用点分命名，值都是非空字符串', () => {
  for (const bundle of [zhCN, en]) {
    for (const [key, value] of Object.entries(bundle)) {
      assert.match(key, /^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+)+$/, `key 格式不规范：${key}`);
      assert.equal(typeof value, 'string', `${key} 的值应为字符串`);
      assert.ok(value.length > 0, `${key} 的值不应为空`);
    }
  }
});

test('基准语言自身不得有重复语义的空 key；英语漏译量受控', () => {
  // 本批次只覆盖外壳层（导航/顶栏/输入区/附件菜单/设置-语言），
  // 英语应与中文这些 key 完全对齐——不对齐说明新增词条时漏了英文。
  const missing = missingKeys('en');
  assert.deepEqual(missing, [], `英语缺少 ${missing.length} 个词条：${missing.slice(0, 8).join(', ')}`);
  // 反向：英语不应有中文没有的 key（否则是孤儿词条）
  const orphans = Object.keys(en).filter(key => !(key in zhCN));
  assert.deepEqual(orphans, [], `英语有 ${orphans.length} 个孤儿词条：${orphans.join(', ')}`);
});

test('getBundle / allKeys：取包与列 key', () => {
  assert.equal(getBundle('en'), en);
  assert.equal(getBundle('zh-CN'), zhCN);
  assert.equal(getBundle('ja'), zhCN, '未支持语言取基准包');
  assert.deepEqual(allKeys('en').sort(), Object.keys(en).sort());
});

test('不翻译提示词：词条表里不得出现发给模型的内容', () => {
  // 这些模块里的中文是发给大模型的提示词，翻译会改变角色行为（中文关键词表
  // 翻成英文后对中文对话直接失灵），因此它们不应出现在词条表里。
  // 这里用「提示词特征片段」做反向断言，防止将来有人顺手把它们搬进来。
  const promptFragments = [
    '始终以角色的身份',
    '不要替 {{user}} 说话',
    '从本段对话中提取值得在后续对话中记住的新信息',
    '记忆总结',
  ];
  const values = [...Object.values(zhCN), ...Object.values(en)].join('\n');
  for (const fragment of promptFragments) {
    assert.equal(values.includes(fragment), false, `词条表不应包含提示词片段：${fragment}`);
  }
});

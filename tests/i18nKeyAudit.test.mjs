// i18n 键对账测试：把 scripts/i18nKeyAudit.mjs 的真仓扫描接进测试网。
// 2026-10-09 实证背景：SamplingCard 的 labelKey 间接引用漏补词条，界面长期显示
// settings.sampling... 原始键名（t() 回退语义），而旧扫描器只认 t('字面量')，
// 看不见间接形态。这里既守真仓零缺失，也自检扫描器本身还能抓这类问题。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { auditI18nKeys } from '../scripts/i18nKeyAudit.mjs';

test('真仓对账：直接 + 间接引用零缺失，采样参数四键在列', () => {
  const result = auditI18nKeys();

  // 扫描器失灵自检：引用总数暴跌说明扫描逻辑被改坏（当前基线约 2700+）
  assert.ok(result.refCount > 2000, `引用总数异常偏低：${result.refCount}`);
  assert.ok(result.localeCount > 2500, `语言包键数异常偏低：${result.localeCount}`);

  const missingKeys = result.missing.map(item => item.key);
  assert.deepEqual(missingKeys, [],
    `存在代码引用但语言包缺失的键：\n${missingKeys.join('\n')}`);

  // 回归焦点：四个采样字段标签必须以「间接引用 + 词条存在」成对出现
  for (const key of [
    'settings.sampling.maxTokens',
    'settings.sampling.temperature',
    'settings.sampling.topP',
    'settings.sampling.topK',
  ]) {
    assert.ok(!missingKeys.includes(key), `${key} 缺词条（界面会显示键名原文）`);
  }
});

test('能力自检：fixture 中人为制造的引用缺键会被抓，注释里的引用不误报', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-audit-'));
  try {
    const srcDir = path.join(root, 'src', 'demo');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(
      path.join(srcDir, 'Card.js'),
      [
        "// t('ghost.comment.key') 旧扫描器会把这行注释当引用",
        "const FIELDS = [{ name: 'x', labelKey: 'demo.missing.key' }];",
        "const ok = t('demo.present.key');",
        "const bad = t('demo.direct.missing');",
        "const data = open({ listKey: 'worldInfo' });",
      ].join('\n')
    );
    const localeDir = path.join(root, 'src', 'i18n', 'locales', 'zh-CN');
    fs.mkdirSync(localeDir, { recursive: true });
    fs.writeFileSync(
      path.join(localeDir, 'demo.js'),
      "export const demo = { 'demo.present.key': '在' };\n"
    );

    const result = auditI18nKeys(root);
    const missingKeys = result.missing.map(item => item.key);
    assert.deepEqual(missingKeys, ['demo.direct.missing', 'demo.missing.key'],
      '应恰好抓到两个真缺失：一个直接引用、一个间接引用');
    // 注释里的引用与无点的数据标识都不该出现
    assert.ok(!missingKeys.includes('ghost.comment.key'), '整行注释不该被当引用');
    assert.ok(!missingKeys.includes('worldInfo'), '无点数据标识不该被当 i18n 键');
    // 间接引用要带标记（输出里区分「（间接）」，便于定位）
    const indirect = result.missing.find(item => item.key === 'demo.missing.key');
    assert.equal(indirect.sites[0].indirect, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

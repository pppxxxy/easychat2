// Q1 回归：回合小结的渲染计划（纯函数）。
//
// 背景（实测）：一次快照拉取提交 = 整仓（1066 文件）≈ 2.1 万像素高，而
// TurnSummaryPanel 挂在消息 ScrollView **外面**且自己不带滚动容器——
// 裸渲染把消息区挤到 0 高，两头都动不了。这里钉住「内联多少 / 折叠多少」的口径。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  summarizeTurnFiles,
  TURN_SUMMARY_BULK_THRESHOLD,
  TURN_SUMMARY_ROW_LIMIT,
} from '../src/workspace/screen/turnSummaryFiles.js';

const makeFiles = count => Array.from({ length: count }, (_, i) => ({ path: `src/f${i}.js`, op: 'edit', count: 1 }));

test('普通回合（≤ 上限）：全部内联，不折叠', () => {
  const plan = summarizeTurnFiles({ files: makeFiles(5) });
  assert.equal(plan.total, 5);
  assert.equal(plan.shown.length, 5);
  assert.equal(plan.hidden, 0);
  assert.equal(plan.bulk, false);

  const atLimit = summarizeTurnFiles({ files: makeFiles(TURN_SUMMARY_ROW_LIMIT) });
  assert.equal(atLimit.shown.length, TURN_SUMMARY_ROW_LIMIT, '恰好等于上限时仍全部内联');
  assert.equal(atLimit.hidden, 0);
});

test('略多（上限+1 .. 阈值）：内联前 N 条 + 「还有 M 个」', () => {
  const plan = summarizeTurnFiles({ files: makeFiles(TURN_SUMMARY_ROW_LIMIT + 1) });
  assert.equal(plan.shown.length, TURN_SUMMARY_ROW_LIMIT);
  assert.equal(plan.hidden, 1);
  assert.equal(plan.bulk, false, '刚到上限+1 不算批量');

  const atThreshold = summarizeTurnFiles({ files: makeFiles(TURN_SUMMARY_BULK_THRESHOLD) });
  assert.equal(atThreshold.bulk, false, '恰好等于阈值时不折叠（阈值是「超过」）');
  assert.equal(atThreshold.shown.length, TURN_SUMMARY_ROW_LIMIT);
  assert.equal(atThreshold.hidden, TURN_SUMMARY_BULK_THRESHOLD - TURN_SUMMARY_ROW_LIMIT);
});

test('批量提交（> 阈值）：内联 0 条，只报总数（明细全在 Sheet）', () => {
  const plan = summarizeTurnFiles({ files: makeFiles(1066) });
  assert.equal(plan.total, 1066);
  assert.equal(plan.bulk, true);
  assert.deepEqual(plan.shown, [], '面板本体不再渲染任何明细行——这就是「不再卡死」的结构保证');
  assert.equal(plan.hidden, 1066);
});

test('坏输入安全：null / 非数组 / 非法上限都不抛', () => {
  assert.deepEqual(summarizeTurnFiles({}), { shown: [], hidden: 0, total: 0, bulk: false });
  assert.deepEqual(summarizeTurnFiles({ files: null }), { shown: [], hidden: 0, total: 0, bulk: false });
  assert.deepEqual(summarizeTurnFiles({ files: 'nope' }), { shown: [], hidden: 0, total: 0, bulk: false });
  const zero = summarizeTurnFiles({ files: makeFiles(3), limit: 0 });
  assert.equal(zero.shown.length, 0);
  assert.equal(zero.hidden, 3);
  const nan = summarizeTurnFiles({ files: makeFiles(3), limit: Number.NaN });
  assert.equal(nan.hidden, 3, '非法上限当 0 处理而不是全量渲染');
});

test('折叠文案与 Sheet 标题在 zh-CN / en 都有词条（漏译会让界面出现原始键名）', async () => {
  const { zhCN } = await import('../src/i18n/locales/zh-CN.js');
  const { en } = await import('../src/i18n/locales/en.js');
  for (const [locale, table] of [['zh-CN', zhCN], ['en', en]]) {
    for (const key of [
      'workspace.chat.summary.more',
      'workspace.chat.summary.bulkFolded',
      'workspace.chat.summary.allTitle',
    ]) {
      assert.ok(typeof table[key] === 'string' && table[key].length > 0, `${locale} 缺 ${key}`);
    }
    assert.match(table['workspace.chat.summary.more'], /\{count\}/);
    assert.match(table['workspace.chat.summary.bulkFolded'], /\{count\}/);
    assert.match(table['workspace.chat.summary.allTitle'], /\{count\}/);
  }
  // 真渲染一遍：参数喂进去不得残留占位符
  const { translate } = await import('../src/i18n/index.js');
  const plan = summarizeTurnFiles({ files: makeFiles(1066) });
  const text = translate('zh-CN', 'workspace.chat.summary.bulkFolded', { count: plan.total });
  assert.ok(text.includes('1066') && !text.includes('{'), text);
});

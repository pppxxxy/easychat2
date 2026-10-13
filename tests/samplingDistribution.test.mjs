// 采样分布预览的数学口径（纯函数）。
//
// 这张图的价值全在「画的是真实采样管线会发生什么」——所以测试重点不是「有 8 根柱子」，
// 而是三级筛的**语义正确**：
//   温度：T<1 拉大差距（尖锐）、T>1 压缩差距（平缓）、恒等归一
//   top-k：只留最高的前 k 根（k=0/>=总数 = 全留）
//   top-p：在**存活集**上重新归一后累加截断（这是最容易写错的一处：在全集上算会少选）
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  CANDIDATE_BASE_PROBABILITIES,
  MIN_VISUAL_TEMPERATURE,
  applyTemperature,
  applyTopK,
  applyTopP,
  buildCandidateBars,
} from '../src/settings/samplingDistribution.js';

const sum = list => list.reduce((acc, item) => acc + item, 0);

test('初始概率就是用户指定的 8 项（40/35/10/5/4/3/2/1）', () => {
  assert.equal(CANDIDATE_BASE_PROBABILITIES.length, 8);
  assert.deepEqual(
    [...CANDIDATE_BASE_PROBABILITIES].map(item => Math.round(item * 100)),
    [40, 35, 10, 5, 4, 3, 2, 1]
  );
  assert.equal(Math.round(sum(CANDIDATE_BASE_PROBABILITIES) * 100), 100, '初始概率合计 100%');
});

test('温度：归一化恒成立（任何 T 下概率和都是 1）', () => {
  for (const temperature of [0, 0.05, 0.5, 1, 2, 10, 100, -1, Number.NaN, 'x']) {
    const result = applyTemperature(CANDIDATE_BASE_PROBABILITIES, temperature);
    assert.equal(result.length, 8, `T=${temperature} 长度不变`);
    assert.ok(Math.abs(sum(result) - 1) < 1e-9, `T=${temperature} 概率和应为 1（实际 ${sum(result)}）`);
    assert.ok(result.every(item => item > 0 && item <= 1), `T=${temperature} 每项应在 (0,1]`);
  }
});

test('温度 <1 尖锐：最高柱更高、长尾更低（差距拉大）', () => {
  const base = applyTemperature(CANDIDATE_BASE_PROBABILITIES, 1);
  const sharp = applyTemperature(CANDIDATE_BASE_PROBABILITIES, 0.5);
  assert.ok(sharp[0] > base[0], '最高柱变高');
  assert.ok(sharp[7] < base[7], '最低柱变低');
  // 用「首尾比」衡量尖锐度（比单看某一根更能说明分布形状）
  assert.ok(sharp[0] / sharp[7] > base[0] / base[7], '首尾比应增大（更尖锐）');
});

test('温度 >1 平缓：所有柱子趋于接近（差距缩小）', () => {
  const base = applyTemperature(CANDIDATE_BASE_PROBABILITIES, 1);
  const flat = applyTemperature(CANDIDATE_BASE_PROBABILITIES, 2);
  assert.ok(flat[0] < base[0], '最高柱变矮');
  assert.ok(flat[7] > base[7], '最低柱变高');
  assert.ok(flat[0] / flat[7] < base[0] / base[7], '首尾比应减小（更平缓）');
  // 极端高温趋近均匀分布 1/8
  const veryFlat = applyTemperature(CANDIDATE_BASE_PROBABILITIES, 100);
  veryFlat.forEach(item => assert.ok(Math.abs(item - 1 / 8) < 0.02, 'T=100 应接近均匀'));
});

test('温度 =1 保持原分布（恒等）', () => {
  const result = applyTemperature(CANDIDATE_BASE_PROBABILITIES, 1);
  result.forEach((item, index) => {
    assert.ok(Math.abs(item - CANDIDATE_BASE_PROBABILITIES[index]) < 1e-9, `第 ${index} 项应不变`);
  });
});

test('温度下限夹取：T=0 不产生 NaN/Infinity（极端尖锐而非精确 argmax）', () => {
  const result = applyTemperature(CANDIDATE_BASE_PROBABILITIES, 0);
  assert.ok(result.every(item => Number.isFinite(item)), '不得出现 NaN/Infinity');
  assert.ok(Math.abs(sum(result) - 1) < 1e-9);
  // T 被夹到 MIN_VISUAL_TEMPERATURE（0.05），不是 0：0.05 的温度仍给第二项留了
  // 约 6.5% 的概率（真正的 argmax 才是 100%）。断言要如实反映夹取后的形态。
  assert.ok(result[0] > 0.9, `T→下限应高度集中（实际 ${result[0]}）`);
  assert.ok(result[1] < 0.1, '第二项应被压到很低');
  assert.ok(result[2] < 1e-6, '更长的尾应几乎归零');
  assert.ok(result[0] > result[1] && result[1] > result[2], '单调递减');
  assert.equal(MIN_VISUAL_TEMPERATURE > 0, true);
});

test('top-k：只留最高的前 k 根；k=0 与 k>=总数 = 全留', () => {
  const probabilities = CANDIDATE_BASE_PROBABILITIES;
  assert.deepEqual(applyTopK(probabilities, 3), [true, true, true, false, false, false, false, false]);
  assert.deepEqual(applyTopK(probabilities, 1), [true, false, false, false, false, false, false, false]);
  assert.deepEqual(applyTopK(probabilities, 0), Array(8).fill(true), 'k=0 全显示');
  assert.deepEqual(applyTopK(probabilities, 8), Array(8).fill(true), 'k=总数 全显示');
  assert.deepEqual(applyTopK(probabilities, 99), Array(8).fill(true), 'k 超上限 全显示');
  assert.deepEqual(applyTopK(probabilities, -5), Array(8).fill(true), '非法 k 按全显示');
});

test('top-k 按概率排序而非下标：乱序输入也留最大的几根', () => {
  // 第 3 根最大 → k=1 必须留它
  const probabilities = [0.1, 0.2, 0.5, 0.05, 0.05, 0.04, 0.03, 0.03];
  assert.deepEqual(applyTopK(probabilities, 1), [false, false, true, false, false, false, false, false]);
  assert.deepEqual(applyTopK(probabilities, 2), [false, true, true, false, false, false, false, false]);
});

test('top-p：在存活集上累加截断（40+35=75% → p=0.75 恰好选中 2 根）', () => {
  const probabilities = CANDIDATE_BASE_PROBABILITIES;
  const allKept = Array(8).fill(true);
  assert.deepEqual(applyTopP(probabilities, allKept, 0.75), [true, true, false, false, false, false, false, false]);
  assert.deepEqual(applyTopP(probabilities, allKept, 0.4), [true, false, false, false, false, false, false, false]);
  // p=1 全高亮（用户明确要求）
  assert.deepEqual(applyTopP(probabilities, allKept, 1), Array(8).fill(true));
  // p 略大于 0.75（40+35+10=85%）→ 选中 3 根
  assert.deepEqual(applyTopP(probabilities, allKept, 0.8), [true, true, true, false, false, false, false, false]);
});

test('top-p 在存活集上归一：top-k 砍剩 2 根时 p=0.5 只需第一根', () => {
  // 存活两根 [0.40, 0.35]，归一后 53.3% / 46.7%
  // p=0.5 → 第一根累计 53.3% 已达标 → 只选第一根
  const probabilities = [0.40, 0.35, 0.10, 0.05, 0.04, 0.03, 0.02, 0.01];
  const kept = [true, true, false, false, false, false, false, false];
  assert.deepEqual(applyTopP(probabilities, kept, 0.5), [true, false, false, false, false, false, false, false]);
  // 若错误地在全集上算：0.40/1.0 = 40% < 50% → 会多选一根（这正是本用例要防的）
  assert.deepEqual(applyTopP(probabilities, kept, 0.6), [true, true, false, false, false, false, false, false]);
});

test('top-p 边界：p=0 只留最高一根；存活集为空则无选中', () => {
  const probabilities = CANDIDATE_BASE_PROBABILITIES;
  assert.deepEqual(applyTopP(probabilities, Array(8).fill(true), 0), [true, false, false, false, false, false, false, false]);
  assert.deepEqual(applyTopP(probabilities, Array(8).fill(false), 0.9), Array(8).fill(false), '没有存活项就没有可选项');
  assert.deepEqual(applyTopP(probabilities, Array(8).fill(true), 2), Array(8).fill(true), 'p>1 按全选');
});

test('buildCandidateBars：三段联动 + 显示比例（最高柱 = 1）', () => {
  const plain = buildCandidateBars({ temperature: 1, topK: 0, topP: 1 });
  assert.equal(plain.bars.length, 8);
  assert.equal(plain.keptCount, 8);
  assert.equal(plain.selectedCount, 8);
  assert.equal(plain.bars[0].ratio, 1, '最高柱显示比例 = 1');
  assert.ok(Math.abs(plain.bars[0].probability - 0.40) < 1e-9, '概率仍是真实值（可读作 40%）');
  // 浮点比较用近似（1/40 在 IEEE754 下不是精确值）
  assert.ok(Math.abs(plain.bars[7].ratio - 0.025) < 1e-12, `1%/40% = 0.025（实际 ${plain.bars[7].ratio}）`);

  // top-k=3：其余概率归零（图上隐藏/变暗），且不参与显示比例
  const cut = buildCandidateBars({ temperature: 1, topK: 3, topP: 1 });
  assert.equal(cut.keptCount, 3);
  assert.equal(cut.bars[3].kept, false);
  assert.equal(cut.bars[3].ratio, 0, '被裁掉的柱高 0');
  assert.equal(cut.bars[3].probability, 0);

  // top-p=0.75：选中 2 根，但存活仍是 8（长尾只是变暗，不消失）
  const tail = buildCandidateBars({ temperature: 1, topK: 0, topP: 0.75 });
  assert.equal(tail.selectedCount, 2);
  assert.equal(tail.keptCount, 8);
  assert.equal(tail.bars[2].selected, false, '第三根不在 top-p 内');
  assert.ok(tail.bars[2].ratio > 0, '长尾仍有高度（变暗而非截断）');
});

test('buildCandidateBars：温度影响显示比例（尖锐时最高柱更突出）', () => {
  const neutral = buildCandidateBars({ temperature: 1 });
  const sharp = buildCandidateBars({ temperature: 0.5 });
  // 显示比例是相对最高的，所以「第二根相对第一根」更能体现形状
  assert.ok(sharp.bars[1].ratio < neutral.bars[1].ratio, '尖锐时第二根相对变矮');
  assert.equal(sharp.bars[0].ratio, 1);
  const flat = buildCandidateBars({ temperature: 2 });
  assert.ok(flat.bars[1].ratio > neutral.bars[1].ratio, '平缓时第二根相对变高');
});

test('坏输入不抛：空数组/非法值都给可绘制的结果', () => {
  assert.deepEqual(applyTemperature([], 1), []);
  assert.deepEqual(applyTemperature(null, 1), []);
  assert.deepEqual(applyTopK(null, 3), []);
  assert.deepEqual(applyTopP(null, null, 0.5), []);
  const bars = buildCandidateBars({ base: [], temperature: 1 });
  assert.equal(bars.bars.length, 0);
  assert.equal(bars.maxProbability, 0);
  // 全零输入：不产生 NaN
  const zero = buildCandidateBars({ base: [0, 0, 0], temperature: 1 });
  assert.equal(zero.bars.length, 0, '全零（过滤后为空）→ 空结果，不画 NaN 柱');
});

// 接线：组件在 Node 里进不来（RN Flow 语法），只能钉源码——与仓库既有做法一致
// （tests/uiSheet.test.mjs 等）。这三条防的是「图被摘掉/参数没接上」。
test('接线：图表挂在生成参数卡里，且四个参数都接进了图', () => {
  const card = readFileSync(path.resolve('src/settings/SamplingCard.js'), 'utf8');
  assert.ok(card.includes("import SamplingChart from './SamplingChart.js'"), '卡片引入图表组件');
  assert.ok(card.includes('<SamplingChart'), '卡片渲染图表');
  // 三个参与联动的参数必须从**当前采样状态**取值（写死常量 = 图不会动）
  for (const name of ['temperature', 'topK', 'topP']) {
    assert.ok(card.includes(`fieldValue(sampling, '${name}'`), `${name} 必须接进图表`);
  }
  // 图表必须在四个参数**下方**（用户明确要求「四个参数下方增加一张图」）
  const chartAt = card.indexOf('<SamplingChart');
  const lastFieldAt = card.lastIndexOf('SAMPLING_ITEMS.map');
  assert.ok(lastFieldAt > 0 && chartAt > lastFieldAt, '图表应排在参数列表之后');
});

test('接线：图表组件用 Animated 做平滑动画，且高度动画未误用 native driver', () => {
  const chart = readFileSync(path.resolve('src/settings/SamplingChart.js'), 'utf8');
  assert.ok(chart.includes("from 'react-native'") && chart.includes('Animated'), '用 RN 内置 Animated');
  assert.ok(chart.includes('Animated.timing('), '参数变化走 timing 动画');
  assert.ok(chart.includes('Easing.'), '有缓动曲线');
  // height 不是 transform/opacity：useNativeDriver:true 会直接报错，必须 false
  assert.match(chart, /useNativeDriver:\s*false/, 'height 动画必须 useNativeDriver:false');
  assert.equal(/useNativeDriver:\s*true/.test(chart), false, '不得对 height 用 native driver');
  // 三段视觉状态：选中（高亮）/ 长尾（变暗）/ 被 top-k 裁掉（更暗）
  assert.ok(chart.includes('bar.selected ?'), '选中态有独立配色');
  assert.ok(chart.includes('CUT_OPACITY') && chart.includes('TAIL_OPACITY'), '裁掉/长尾各有透明度');
});

test('词条齐备：图表文案 zh/en 都在（漏译界面会显示原始键名）', async () => {
  const { zhCN } = await import('../src/i18n/locales/zh-CN.js');
  const { en } = await import('../src/i18n/locales/en.js');
  for (const [locale, table] of [['zh-CN', zhCN], ['en', en]]) {
    for (const key of [
      'settings.sampling.chart.sharp',
      'settings.sampling.chart.flat',
      'settings.sampling.chart.neutral',
      'settings.sampling.chart.keptK',
      'settings.sampling.chart.selectedP',
    ]) {
      assert.ok(typeof table[key] === 'string' && table[key].length > 0, `${locale} 缺 ${key}`);
    }
    assert.match(table['settings.sampling.chart.keptK'], /\{count\}/);
    assert.match(table['settings.sampling.chart.selectedP'], /\{count\}/);
  }
});

// 对话长图（shareCardImage）的布局测试。
//
// 用桩 measure（每个字符 10px）代替真实 canvas：本模块只需要「文本多宽」这一个事实，
// 换成桩之后换行、高度、截断提示都能在 Node 里断言，不必装 canvas 原生依赖。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CARD_WIDTH,
  drawShareCard,
  planShareCard,
  wrapLines,
} from '../../src/chat/shareCardImage.js';

const measure = text => String(text).length * 10;

test('wrapLines：按宽度断行；英文尽量在空格处断', () => {
  // 宽 30px = 3 个字符。
  assert.deepEqual(wrapLines(measure, 'abcdef', 30), ['abc', 'def']);
  // 英文：最后一个空格落在接近行尾时在空格处断（读起来自然）。
  const lines = wrapLines(measure, 'hello world', 60);
  assert.equal(lines.join('').replace(/\s/g, ''), 'helloworld', '断行不得丢字符');
  // 空文本返回一个空行（不产生 0 行，否则后续高度计算会少算）。
  assert.deepEqual(wrapLines(measure, '', 30), ['']);
});

test('planShareCard：高度随消息条数与行数增长', () => {
  const one = planShareCard({
    entries: [{ role: 'user', speaker: '我', time: '1/1 10:00', body: '短' }],
    meta: { title: 'T', metaText: '共 1 条' },
    measure,
  });
  const two = planShareCard({
    entries: [
      { role: 'user', speaker: '我', time: '1/1 10:00', body: '短' },
      { role: 'assistant', speaker: '甲', time: '1/1 10:01', body: '短' },
    ],
    meta: { title: 'T', metaText: '共 2 条' },
    measure,
  });
  assert.ok(two.height > one.height, '两条应比一条高');
  assert.equal(one.count, 1);
  assert.equal(two.count, 2);
  // 长正文应让同一张卡更高（换行生效）。
  const long = planShareCard({
    entries: [{ role: 'assistant', speaker: '甲', time: '', body: 'x'.repeat(200) }],
    meta: { title: 'T', metaText: '' },
    measure,
  });
  assert.ok(long.height > one.height, '长正文应更高');
});

test('planShareCard：用户气泡靠右、助手靠左', () => {
  const plan = planShareCard({
    entries: [
      { role: 'user', speaker: '我', time: '', body: 'a' },
      { role: 'assistant', speaker: '甲', time: '', body: 'b' },
    ],
    meta: { title: 'T', metaText: '' },
    measure,
  });
  const bubbles = plan.blocks.filter(block => block.kind === 'bubble');
  assert.equal(bubbles[0].isUser, true);
  assert.equal(bubbles[1].isUser, false);
  assert.ok(bubbles[0].left > bubbles[1].left, '用户气泡应在右侧');
  // 两者都不越界。
  bubbles.forEach(bubble => {
    assert.ok(bubble.left >= 0);
    assert.ok(bubble.left + bubble.width <= plan.width);
  });
});

test('planShareCard：超过导出上限时按上限截断', () => {
  const entries = Array.from({ length: 500 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user',
    speaker: 'x',
    time: '',
    body: 'y',
  }));
  const plan = planShareCard({ entries, meta: { title: 'T', metaText: '' }, measure });
  assert.ok(plan.count <= 300, `应截断到导出上限，实际 ${plan.count}`);
});

test('drawShareCard：把每个气泡真的画出来（用桩 ctx 计数）', () => {
  const calls = { fill: 0, text: 0, rects: 0 };
  const ctx = {
    set fillStyle(value) { this._fill = value; },
    get fillStyle() { return this._fill; },
    set font(value) { this._font = value; },
    get font() { return this._font; },
    fillRect: () => { calls.rects += 1; },
    beginPath: () => {},
    moveTo: () => {},
    arcTo: () => {},
    closePath: () => {},
    fill: () => { calls.fill += 1; },
    fillText: () => { calls.text += 1; },
  };
  const plan = planShareCard({
    entries: [
      { role: 'user', speaker: '我', time: '', body: 'a' },
      { role: 'assistant', speaker: '甲', time: '', body: 'b' },
    ],
    meta: { title: '标题', metaText: '共 2 条' },
    measure,
  });
  drawShareCard(ctx, plan, {});
  assert.equal(calls.rects, 1, '应铺一次背景');
  assert.equal(calls.fill, 2, '两个气泡各填一次');
  assert.ok(calls.text >= 4, '标题 + 元信息 + 两段正文都应被画出');
  assert.equal(plan.width, CARD_WIDTH);
});

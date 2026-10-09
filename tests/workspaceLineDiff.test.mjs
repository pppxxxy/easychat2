// H2 行级 diff 测试：LCS / unified 解析 / HTML 生成（纯函数，Node 直测）。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDiffHtml,
  buildLineDiff,
  LINE_DIFF_MAX_LINES,
  parseUnifiedDiff,
} from '../src/workspace/lineDiff.js';

test('H2 buildLineDiff：常规改动 / 空 / 全删全增 / 无尾换行边界', () => {
  // 常规：改一行 + 加一行
  const basic = buildLineDiff('a\nb\nc', 'a\nB\nc\nd');
  assert.deepEqual(basic.stats, { added: 2, removed: 1 });
  const kinds = basic.lines.map(item => item.type);
  assert.deepEqual(kinds, ['ctx', 'del', 'add', 'ctx', 'add']);
  assert.deepEqual(
    basic.lines.filter(item => item.type === 'ctx').map(item => item.text),
    ['a', 'c'],
    '未改行保持 ctx'
  );
  assert.equal(basic.lines[1].text, 'b');
  assert.equal(basic.lines[1].oldNo, 2);
  assert.equal(basic.lines[2].newNo, 2);

  // 空 → 全增 / 全删
  assert.deepEqual(buildLineDiff('', 'x\ny').stats, { added: 2, removed: 0 });
  assert.deepEqual(buildLineDiff('x\ny', '').stats, { added: 0, removed: 2 });
  assert.deepEqual(buildLineDiff('', '').lines, []);

  // 无尾换行：'a\n' 与 'a' 是同一内容（不产生假差异）
  assert.deepEqual(buildLineDiff('a\n', 'a').stats, { added: 0, removed: 0 });
  assert.deepEqual(buildLineDiff('a\nb\n', 'a\nb').lines.map(item => item.type), ['ctx', 'ctx']);

  // 坏输入安全
  assert.deepEqual(buildLineDiff(null, undefined).lines, []);
});

test('H2 buildLineDiff：超限退化为整体对比并如实标记（不假装精细）', () => {
  const big = Array.from({ length: LINE_DIFF_MAX_LINES + 1 }, (_, i) => `line${i}`).join('\n');
  const result = buildLineDiff(big, 'only');
  assert.equal(result.truncated, true);
  assert.equal(result.lines.filter(item => item.type === 'del').length, LINE_DIFF_MAX_LINES + 1);
  assert.equal(result.lines.filter(item => item.type === 'add').length, 1);
});

test('H2 parseUnifiedDiff：行首分类 / 增删计数 / 尾空行', () => {
  const text = [
    'diff --git a/x.js b/x.js',
    'index 111..222 100644',
    '--- a/x.js',
    '+++ b/x.js',
    '@@ -1,3 +1,4 @@',
    ' keep',
    '-old line',
    '+new line',
    '+extra',
    '\\ No newline at end of file',
    '',
  ].join('\n');
  const { lines, stats } = parseUnifiedDiff(text);
  assert.deepEqual(stats, { added: 2, removed: 1 });
  assert.equal(lines[0].type, 'file', 'diff 头');
  assert.equal(lines[4].type, 'hunk');
  assert.equal(lines[5].type, 'ctx');
  assert.equal(lines[5].text, 'keep', '行首空格剥离');
  assert.equal(lines[6].type, 'del');
  assert.equal(lines[6].text, 'old line');
  const last = lines[lines.length - 1];
  assert.equal(last.type, 'file', '无尾换行标记是最后一行（其后的空行已被去掉）');
  assert.match(last.text, /No newline/);
  assert.equal(parseUnifiedDiff('').lines.length, 0);
  assert.deepEqual(parseUnifiedDiff(null).stats, { added: 0, removed: 0 });
});

test('H2 buildDiffHtml：转义收口（无注入）/ 统计头 / 深浅色 / 行号', () => {
  const model = parseUnifiedDiff('@@ -1 +1 @@\n-<script>alert(1)</script>\n+safe & sound');
  const html = buildDiffHtml(model, { dark: true, title: 'abc1234' });
  assert.ok(!html.includes('<script>alert(1)</script>'), '原始标签必须被转义');
  assert.ok(html.includes('&lt;script&gt;'), '转义形态在');
  assert.ok(html.includes('safe &amp; sound'));
  assert.ok(html.includes('+1') && html.includes('-1'), '增删统计头');
  assert.ok(html.includes('#1b1c1f'), '深色主题');
  const light = buildDiffHtml(model, { dark: false });
  assert.ok(light.includes('#ffffff'), '浅色主题');
  // 行号：unified 文本没有老/新行号 → 留空但结构仍在
  const numbered = buildDiffHtml(buildLineDiff('a\nb', 'a\nc'), {});
  assert.ok(numbered.includes('>1</span>'), 'LCS 通路带行号');
  assert.equal(buildDiffHtml(null).includes('<!DOCTYPE html>'), true, '空模型也产出合法 HTML');
});

// 精确替换的纯逻辑（edit.js）。

import test from 'node:test';
import assert from 'node:assert/strict';

import { applyWorkspaceEdit, countOccurrences } from '../src/workspace/edit.js';

test('countOccurrences 统计不重叠匹配', () => {
  assert.equal(countOccurrences('猫 猫 猫', '猫'), 3);
  assert.equal(countOccurrences('aaaa', 'aa'), 2);
  assert.equal(countOccurrences('abc', 'z'), 0);
  assert.equal(countOccurrences('abc', ''), 0);
  assert.equal(countOccurrences(null, 'a'), 0);
});

test('applyWorkspaceEdit：唯一匹配才默认允许', () => {
  const result = applyWorkspaceEdit({ content: '# 标题\n旧句子\n结尾', find: '旧句子', replace: '新句子' });
  assert.equal(result.count, 1);
  assert.equal(result.content, '# 标题\n新句子\n结尾');
});

test('applyWorkspaceEdit：多处匹配默认拒绝，all:true 才全替换', () => {
  assert.throws(
    () => applyWorkspaceEdit({ content: '猫 猫', find: '猫', replace: '狗' }),
    /匹配到 2 处/,
  );
  const all = applyWorkspaceEdit({ content: '猫 猫', find: '猫', replace: '狗', all: true });
  assert.equal(all.count, 2);
  assert.equal(all.content, '狗 狗');
  // all:true 但只匹配一处也算成功（调用方传 all 是「允许多处」，不是「必须多处」）
  const single = applyWorkspaceEdit({ content: '猫', find: '猫', replace: '狗', all: true });
  assert.equal(single.count, 1);
  assert.equal(single.content, '狗');
});

test('applyWorkspaceEdit：找不到原文、空 find、空 replace 都明确报错', () => {
  assert.throws(() => applyWorkspaceEdit({ content: 'abc', find: 'z', replace: 'y' }), /未找到要替换的原文/);
  assert.throws(() => applyWorkspaceEdit({ content: 'abc', find: '', replace: 'y' }), /find）不能为空/);
  assert.throws(() => applyWorkspaceEdit({ content: 'abc', find: 'a', replace: '' }), /不能为空/);
  assert.throws(() => applyWorkspaceEdit({ content: 'abc', find: 'a', replace: null }), /不能为空/);
});

test('替换文本里的 $ 不会被当成替换模式（不产生意外插值）', () => {
  // 走函数式 replace：'$&' 这类特殊序列必须原样落盘，否则模型写下 $ 就会改错内容
  const result = applyWorkspaceEdit({ content: '价格 = 100', find: '100', replace: '$&元' });
  assert.equal(result.content, '价格 = $&元');
  const all = applyWorkspaceEdit({ content: '100 100', find: '100', replace: '$1', all: true });
  assert.equal(all.content, '$1 $1');
});

test('多行原文（含缩进与换行）逐字匹配', () => {
  const content = ['function a() {', '  return 1;', '}', '', 'function b() {', '  return 2;', '}'].join('\n');
  const result = applyWorkspaceEdit({
    content,
    find: 'function b() {\n  return 2;\n}',
    replace: 'function b() {\n  return 3;\n}',
  });
  assert.equal(result.count, 1);
  assert.ok(result.content.includes('return 3;'));
  assert.ok(result.content.includes('return 1;'), '另一处函数不受影响');
});

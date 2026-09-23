import test from 'node:test';
import assert from 'node:assert/strict';

import {
  REGEX_PLACEMENT,
  applyRegexScripts,
  compileRegex,
  compileRegexCached,
} from '../src/regexEngine.js';

const script = (patch = {}) => ({
  enabled: true,
  placement: [REGEX_PLACEMENT.AI_OUTPUT],
  findRegex: '/foo/g',
  replaceString: 'bar',
  ...patch,
});

test('没有脚本时原样返回（且不做任何处理）', () => {
  assert.equal(applyRegexScripts('foo foo', [], REGEX_PLACEMENT.AI_OUTPUT), 'foo foo');
  assert.equal(applyRegexScripts('foo foo', null, REGEX_PLACEMENT.AI_OUTPUT), 'foo foo');
});

test('按 placement 过滤脚本', () => {
  const scripts = [script({ placement: [REGEX_PLACEMENT.USER_INPUT] })];
  assert.equal(applyRegexScripts('foo', scripts, REGEX_PLACEMENT.AI_OUTPUT), 'foo');
  assert.equal(applyRegexScripts('foo', scripts, REGEX_PLACEMENT.USER_INPUT), 'bar');
});

test('非法正则被跳过，不影响其它脚本', () => {
  const scripts = [
    script({ findRegex: '/(/g' }),
    script({ findRegex: '/foo/g', replaceString: 'ok' }),
  ];
  assert.equal(applyRegexScripts('foo', scripts, REGEX_PLACEMENT.AI_OUTPUT), 'ok');
});

test('缓存的正则复用时不残留 lastIndex（连续 replace 结果一致）', () => {
  const first = applyRegexScripts('a b c', [script({ findRegex: '/\\w/g', replaceString: 'x' })], REGEX_PLACEMENT.AI_OUTPUT);
  const second = applyRegexScripts('a b c', [script({ findRegex: '/\\w/g', replaceString: 'x' })], REGEX_PLACEMENT.AI_OUTPUT);
  assert.equal(first, 'x x x');
  assert.equal(second, first);
});

test('compileRegexCached 命中缓存并返回同一实例', () => {
  const a = compileRegexCached('/cache-me/g');
  const b = compileRegexCached('/cache-me/g');
  assert.equal(a, b);
  assert.ok(a instanceof RegExp);
});

test('compileRegex 仍按 /pattern/flags 解析并拒绝空表达式', () => {
  const re = compileRegex('/ab+c/i');
  assert.equal(re.source, 'ab+c');
  assert.equal(re.flags, 'i');
  assert.throws(() => compileRegex(''), /不能为空/);
});

test('替换文本中的 $0 视作整段匹配（兼容角色卡写法）', () => {
  const s = script({ findRegex: '/([\\s\\S]+?。)/g', replaceString: '$0<panel/>' });
  assert.equal(
    applyRegexScripts('第一句。第二句。', [s], REGEX_PLACEMENT.AI_OUTPUT),
    '第一句。<panel/>第二句。<panel/>'
  );
  // 已支持的原生写法不受影响
  const amp = script({ findRegex: '/x/g', replaceString: '[$&]' });
  assert.equal(applyRegexScripts('x', [amp], REGEX_PLACEMENT.AI_OUTPUT), '[x]');
  // $$0 表示字面量 $0，不能被当成整段匹配
  const literal = script({ findRegex: '/x/g', replaceString: '$$0' });
  assert.equal(applyRegexScripts('x', [literal], REGEX_PLACEMENT.AI_OUTPUT), '$0');
});

test('超长文本：只对尾部执行脚本，头部原样保留（防灾难性回溯拖死主线程）', () => {
  const head = 'H'.repeat(25000);
  const tail = 'foo';
  const output = applyRegexScripts(
    head + tail,
    [script({ findRegex: '/foo/g', replaceString: 'bar' })],
    REGEX_PLACEMENT.AI_OUTPUT
  );
  assert.equal(output.length, head.length + tail.length);
  assert.equal(output.slice(0, head.length), head);
  assert.equal(output.slice(-3), 'bar');
});

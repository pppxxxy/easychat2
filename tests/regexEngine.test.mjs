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

test('大型角色卡文本在上限内完整执行展示正则', () => {
  const head = 'H'.repeat(6800000);
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

test('大型完整 HTML 替换文本按原长度完整写入', () => {
  const largeHtml = [
    '<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width"/></head>',
    '<body><main>',
    'x'.repeat(6800000),
    '</main><script>window.triggerSlash("/send ok")</script></body></html>',
  ].join('');
  const output = applyRegexScripts(
    '[代桔出品]',
    [script({ findRegex: '/\\[代桔出品\\]/g', replaceString: largeHtml })],
    REGEX_PLACEMENT.AI_OUTPUT,
    { mode: 'display' }
  );
  assert.equal(output.length, largeHtml.length);
  assert.equal(output, largeHtml);
});

test('展示正则只处理 HTML 可见文本，不改写标签、脚本和样式', () => {
  const highlight = script({
    findRegex: '/(foo)/g',
    replaceString: '<strong>$1</strong>',
  });
  const output = applyRegexScripts(
    '<div>foo</div><script>const foo = 1;</script><style>.foo{}</style>',
    [highlight],
    REGEX_PLACEMENT.AI_OUTPUT,
    { mode: 'display' }
  );
  assert.equal(
    output,
    '<div><strong>foo</strong></div><script>const foo = 1;</script><style>.foo{}</style>'
  );
});

test('展示正则保留整条消息的 $ 锚点，不再逐段复制或错序', () => {
  const status = script({ findRegex: '/$/g', replaceString: '<div id="status">状态</div>' });
  const video = script({ findRegex: '/$/g', replaceString: '<video controls></video>' });

  const plain = applyRegexScripts(
    '第一段。第二段。',
    [status, video],
    REGEX_PLACEMENT.AI_OUTPUT,
    { mode: 'display' }
  );
  assert.equal((plain.match(/id="status"/g) || []).length, 1);
  assert.equal((plain.match(/<video/g) || []).length, 1);
  assert.ok(plain.indexOf('id="status"') < plain.indexOf('<video'));

  // 行内标签把正文切段时，仍然只各追加一次
  const withTag = applyRegexScripts(
    '第一段<br>第二段',
    [status, video],
    REGEX_PLACEMENT.AI_OUTPUT,
    { mode: 'display' }
  );
  assert.equal((withTag.match(/id="status"/g) || []).length, 1);
  assert.equal((withTag.match(/<video/g) || []).length, 1);
  assert.ok(withTag.indexOf('id="status"') < withTag.indexOf('<video'));
  assert.ok(withTag.includes('<br>'));
});

test('展示正则还原哨兵后标签与脚本逐字保留', () => {
  const append = script({ findRegex: '/$/g', replaceString: '<b>尾</b>' });
  const output = applyRegexScripts(
    '<div>文</div><script>const x = 1;</script>',
    [append],
    REGEX_PLACEMENT.AI_OUTPUT,
    { mode: 'display' }
  );
  assert.ok(output.includes('<div>文</div>'));
  assert.ok(output.includes('<script>const x = 1;</script>'));
  assert.ok(output.endsWith('<b>尾</b>'));
  assert.equal((output.match(/<b>尾<\/b>/g) || []).length, 1);
});

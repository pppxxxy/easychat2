import test from 'node:test';
import assert from 'node:assert/strict';

import { collectActiveWorldInfo, getUnsafeWorldEntryKeys, isEntryActive } from '../src/lorebook.js';

const entry = (patch = {}) => ({
  id: 'e1',
  enabled: true,
  constant: false,
  keys: ['apple'],
  secondaryKeys: [],
  selective: false,
  useRegex: false,
  caseSensitive: false,
  matchWholeWords: false,
  content: 'content',
  position: 0,
  order: 100,
  ...patch,
});

test('默认（useRegex=false）按字面量匹配：正则元字符不再被当模式', () => {
  assert.equal(isEntryActive(entry({ keys: ['C++'] }), ['I like C++']), true);
  // 之前默认 useRegex=true 时，'C++' 会作为正则匹配到 'C'
  assert.equal(isEntryActive(entry({ keys: ['C++'] }), ['I like C']), false);
});

test('语法非法的键不再抛错，也不会误命中', () => {
  assert.equal(isEntryActive(entry({ keys: ['('] }), ['a ( b']), true);
  assert.equal(isEntryActive(entry({ keys: ['('] }), ['no match here']), false);
});

test('显式 useRegex=true 时仍按正则匹配', () => {
  const regexEntry = entry({ keys: ['a.c'], useRegex: true });
  assert.equal(isEntryActive(regexEntry, ['abc']), true);
  assert.equal(isEntryActive(regexEntry, ['ac']), false);
});

test('useRegex=true 但模式非法时静默不命中（不抛错）', () => {
  assert.equal(isEntryActive(entry({ keys: ['('], useRegex: true }), ['(']), false);
});

test('兼容 SillyTavern 的 /pattern/flags 键写法', () => {
  const slashEntry = entry({ keys: ['/c\\+\\+/i'] });
  assert.equal(isEntryActive(slashEntry, ['I like c++']), true);
  assert.equal(isEntryActive(slashEntry, ['nothing']), false);
});

test('selective + secondaryKeys 的触发条件', () => {
  const withoutSelective = entry({ keys: ['apple'], secondaryKeys: ['pie'], selective: false });
  // selective=false 时次要关键词不参与判定（与 SillyTavern 一致）
  assert.equal(isEntryActive(withoutSelective, ['apple']), true);

  const selective = entry({ keys: ['apple'], secondaryKeys: ['pie'], selective: true });
  assert.equal(isEntryActive(selective, ['apple']), false);
  assert.equal(isEntryActive(selective, ['apple pie']), true);
});

test('constant 条目与 disabled 条目', () => {
  assert.equal(isEntryActive(entry({ constant: true, keys: [] }), ['anything']), true);
  assert.equal(isEntryActive(entry({ enabled: false }), ['apple']), false);
  assert.equal(isEntryActive(null, ['apple']), false);
});

test('matchWholeWords 不会把单词内部误命中', () => {
  const whole = entry({ keys: ['app'], matchWholeWords: true });
  assert.equal(isEntryActive(whole, ['an app here']), true);
  assert.equal(isEntryActive(whole, ['apple']), false);
});

test('matchWholeWords 对中文关键词仍能命中', () => {
  const whole = entry({ keys: ['房间'], matchWholeWords: true });
  assert.equal(isEntryActive(whole, ['这是房间']), true);
  assert.equal(isEntryActive(whole, ['这是房']), false);
  const partial = entry({ keys: ['房间'], matchWholeWords: false });
  assert.equal(isEntryActive(partial, ['这是房间']), true);
});

test('collectActiveWorldInfo 按 position 分组并保留顺序', () => {
  const character = {
    worldInfo: [
      entry({ id: 'a', keys: ['apple'], position: 0, order: 2, content: 'before-2' }),
      entry({ id: 'b', keys: ['apple'], position: 0, order: 1, content: 'before-1' }),
      entry({ id: 'c', keys: ['apple'], position: 4, content: 'depth' }),
      entry({ id: 'd', keys: ['apple'], position: 1, content: 'after' }),
    ],
  };
  const result = collectActiveWorldInfo(character, [], 'apple');
  assert.deepEqual(result.before.map(item => item.content), ['before-1', 'before-2']);
  assert.deepEqual(result.after.map(item => item.content), ['after']);
  assert.deepEqual(result.depth.map(item => item.content), ['depth']);
});

test('getUnsafeWorldEntryKeys 只标记会触发正则防护的关键词', () => {
  // useRegex 默认关闭：裸表达式按普通文本处理，只有 /pattern/ 写法才走正则防护
  const slashOnly = entry({ keys: ['(a+)+$', '安全词', '/(\\w+)*$/g'] });
  assert.deepEqual(getUnsafeWorldEntryKeys(slashOnly), ['/(\\w+)*$/g']);

  // useRegex 开启时，裸表达式也会被检查
  const regexEntry = entry({ keys: ['(a+)+$'], useRegex: true });
  assert.deepEqual(getUnsafeWorldEntryKeys(regexEntry), ['(a+)+$']);

  // 常规正则不误报
  const safe = entry({ keys: ['\\bword\\b', '/foo/g'], useRegex: true });
  assert.deepEqual(getUnsafeWorldEntryKeys(safe), []);
});

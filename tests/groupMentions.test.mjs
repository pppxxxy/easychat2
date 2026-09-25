import test from 'node:test';
import assert from 'node:assert/strict';

import { hasEveryoneMention, parseMentions } from '../src/groupMentions.js';

const characters = [
  { id: 'al', name: 'Al' },
  { id: 'alice', name: 'Alice' },
  { id: 'ming', name: '小明' },
  { id: 'mingming', name: '小明明' },
];

test('前缀角色名不会误触发较短的提及', () => {
  assert.deepEqual(parseMentions('@Alice 你怎么看', characters), ['alice']);
  assert.deepEqual(parseMentions('@Al 你怎么看', characters), ['al']);
});

test('中文角色名按完整 mention 匹配', () => {
  assert.deepEqual(parseMentions('@小明明 说说看', characters), ['mingming']);
  assert.deepEqual(parseMentions('@小明 说说看', characters), ['ming']);
});

test('mention 右侧标点和行尾都能结束 token', () => {
  assert.deepEqual(parseMentions('@Alice，你来', characters), ['alice']);
  assert.deepEqual(parseMentions('@Alice', characters), ['alice']);
  assert.deepEqual(parseMentions('@Alice@Al', characters), ['al', 'alice']);
});

test('@全体 返回所有成员且去重', () => {
  assert.equal(hasEveryoneMention('@全体 出发'), true);
  assert.deepEqual(parseMentions('@全体 出发', characters), ['al', 'alice', 'ming', 'mingming']);
  assert.deepEqual(parseMentions('没有提及', characters), []);
});
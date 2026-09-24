import test from 'node:test';
import assert from 'node:assert/strict';

import { getVectorOwnerId, shouldIndexSession } from '../src/vectorMemory/scope.js';

test('向量作用域只接受有角色归属的单聊会话', () => {
  assert.equal(shouldIndexSession({ type: 'single', characterId: 'character-a' }), true);
  assert.equal(shouldIndexSession({ type: 'group', characterId: '' }), false);
  assert.equal(shouldIndexSession({ type: 'single', characterId: '' }), false);
  assert.equal(shouldIndexSession(null), false);
});

test('向量 owner id 对群聊返回空值，对单聊返回角色 id', () => {
  assert.equal(getVectorOwnerId({ type: 'group', characterId: '' }, 'fallback'), '');
  assert.equal(getVectorOwnerId({ type: 'single', characterId: 'character-a' }, 'fallback'), 'character-a');
});

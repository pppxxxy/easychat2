import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRestoredSession,
  guessCharacterIdForMessages,
} from '../src/context/sessionLibrary.js';

test('恢复会话沿用原 id，时间取消息时间戳', () => {
  const session = buildRestoredSession({
    sessionId: 'session-abc',
    characterId: 'char-8',
    messages: [
      { id: '1', role: 'user', text: '你好', timestamp: 1000 },
      { id: '2', role: 'assistant', text: '欢迎回来', timestamp: 2000 },
      { id: '3', role: 'assistant', text: '未完成', timestamp: 3000, pending: true },
    ],
  });
  assert.equal(session.id, 'session-abc');
  assert.equal(session.characterId, 'char-8');
  assert.equal(session.type, 'single');
  assert.equal(session.createdAt, 1000);
  assert.equal(session.updatedAt, 2000);
  assert.equal(session.preview, '欢迎回来');
  assert.equal(session.summarizedUpTo, '');
  assert.equal(session.pinned, false);
});

test('没有时间戳时用传入的 now 兜底', () => {
  const session = buildRestoredSession({
    sessionId: 's1',
    characterId: 'c1',
    messages: [{ role: 'user', text: 'x' }],
    now: 555,
  });
  assert.equal(session.createdAt, 555);
  assert.equal(session.updatedAt, 555);
});

test('按开场白精确匹配角色（忽略首尾空白、还原 {{user}}）', () => {
  const characters = [
    { id: 'c5', name: '角色5', firstMes: '早呀，{{user}}。今天想聊点什么？' },
    { id: 'c8', name: '角色八', firstMes: '我是角色八，初次见面。' },
  ];
  const messages = [
    { role: 'assistant', text: '  早呀，主人。今天想聊点什么？  ' },
    { role: 'user', text: '在吗' },
  ];
  assert.equal(
    guessCharacterIdForMessages(messages, characters, { userName: '主人' }),
    'c5'
  );
});

test('开场白后追加了内容时用前缀匹配', () => {
  const characters = [
    { id: 'c5', name: '角色5', firstMes: '早呀，今天想聊点什么？' },
    { id: 'c8', name: '角色八', firstMes: '我是角色八，初次见面。' },
  ];
  const messages = [
    { role: 'assistant', text: '早呀，今天想聊点什么？——顺便说，外面在下雨。' },
  ];
  assert.equal(guessCharacterIdForMessages(messages, characters), 'c5');
});

test('判不出来时返回空串，不瞎猜', () => {
  const characters = [{ id: 'c5', name: '角色5', firstMes: '早呀' }];
  assert.equal(
    guessCharacterIdForMessages([{ role: 'assistant', text: '完全不同的开场白内容' }], characters),
    ''
  );
  assert.equal(guessCharacterIdForMessages([], characters), '');
  assert.equal(guessCharacterIdForMessages([{ role: 'user', text: 'hi' }], characters), '');
  assert.equal(guessCharacterIdForMessages([{ role: 'assistant', text: '早呀' }], []), '');
});

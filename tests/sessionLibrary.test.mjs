import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRestoredSession,
  collectMessageSpeakers,
  guessCharacterIdForMessages,
  isMessageGroup,
  regenerateMessageIds,
  selectSessionsForCharacters,
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

test('恢复群聊：按消息里的 speakerId 还原成员，忽略传入的角色', () => {
  const session = buildRestoredSession({
    sessionId: 'g1',
    characterId: 'should-be-ignored',
    messages: [
      { role: 'user', text: '大家好', timestamp: 1500 },
      { role: 'assistant', text: 'a', speakerId: 'c1', speakerName: '小明', timestamp: 1000 },
      { role: 'assistant', text: 'b', speakerId: 'c2', speakerName: '小红', timestamp: 2000 },
      { role: 'assistant', text: 'c', speakerId: 'c1', speakerName: '小明', timestamp: 2500 },
    ],
  });
  assert.equal(session.type, 'group');
  assert.equal(session.characterId, '');
  assert.deepEqual(session.members, ['c1', 'c2']);
  assert.deepEqual(session.memberProfiles, { c1: '小明', c2: '小红' });
  assert.equal(session.groupMode, 'ensemble');
});

test('选择角色关联会话时同时匹配单聊归属与群聊成员', () => {
  const sessions = [
    { id: 's1', type: 'single', characterId: 'c1', members: [] },
    { id: 'g1', type: 'group', characterId: '', members: ['c1', 'c2'] },
    { id: 'g2', type: 'group', characterId: '', members: ['c2'] },
  ];
  assert.deepEqual(
    selectSessionsForCharacters(sessions, ['c1']).map(session => session.id),
    ['s1', 'g1']
  );
  assert.deepEqual(selectSessionsForCharacters(sessions, []), []);
});

test('单聊（无 speakerId）仍按 characterId 恢复', () => {
  const session = buildRestoredSession({
    sessionId: 's2',
    characterId: 'c9',
    messages: [{ role: 'assistant', text: 'hi', timestamp: 1 }],
  });
  assert.equal(session.type, 'single');
  assert.equal(session.characterId, 'c9');
});

test('collectMessageSpeakers/isMessageGroup 只统计 assistant 的 speakerId', () => {
  const messages = [
    { role: 'user', speakerId: 'x' },
    { role: 'assistant', speakerId: 'c1', speakerName: '甲' },
    { role: 'assistant', speakerId: 'c2', speakerName: '乙' },
  ];
  assert.deepEqual(collectMessageSpeakers(messages), [
    { id: 'c1', name: '甲' },
    { id: 'c2', name: '乙' },
  ]);
  assert.equal(isMessageGroup(messages), true);
  assert.equal(isMessageGroup([{ role: 'assistant', speakerId: 'c1' }]), false);
});

test('克隆消息 ID 时同步重写 quoted 引用', () => {
  const cloned = regenerateMessageIds([
    { id: 'u1', role: 'user', text: '原文' },
    { id: 'a1', role: 'assistant', text: '回复', quoted: { id: 'u1', text: '原文' } },
    { id: 'a2', role: 'assistant', text: '外部引用', quoted: { id: 'not-in-list' } },
  ], 1000);
  assert.deepEqual(cloned.map(item => item.id), [
    '1000-clone-0',
    '1000-clone-1',
    '1000-clone-2',
  ]);
  assert.equal(cloned[1].quoted.id, '1000-clone-0');
  assert.equal(cloned[1].quoted.text, '原文');
  assert.equal(cloned[2].quoted.id, 'not-in-list');
});

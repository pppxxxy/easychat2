// 流式草稿（Z 系采纳 #8）：节流判定、收敛、读写清。纯函数 + 假 storage。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  STREAM_DRAFT_MIN_DELTA,
  STREAM_DRAFT_MIN_INTERVAL_MS,
  clearStreamDraft,
  normalizeStreamDraft,
  readStreamDraft,
  saveStreamDraft,
  shouldWriteStreamDraft,
  streamDraftKey,
} from '../src/chat/streamDraft.js';

function fakeStorage() {
  const map = new Map();
  return {
    map,
    async setItem(k, v) { map.set(k, v); },
    async getItem(k) { return map.has(k) ? map.get(k) : null; },
    async removeItem(k) { map.delete(k); },
  };
}

test('normalizeStreamDraft：字段白名单；空正文/缺 id → null', () => {
  assert.equal(normalizeStreamDraft({ messageId: 'm1', text: '  ' }), null);
  assert.equal(normalizeStreamDraft({ text: 'x' }), null);
  const ok = normalizeStreamDraft({ messageId: 'm1', text: '你好', reasoning: 'r', at: 123, extra: 'drop' });
  assert.deepEqual(ok, { messageId: 'm1', text: '你好', reasoning: 'r', at: 123 });
});

test('shouldWriteStreamDraft：正文没增长不写', () => {
  assert.equal(shouldWriteStreamDraft({ lastLen: 100, nextLen: 100, now: 999999, lastAt: 0 }), false);
  assert.equal(shouldWriteStreamDraft({ lastLen: 100, nextLen: 90, now: 999999, lastAt: 0 }), false);
});

test('shouldWriteStreamDraft：增长够多立即写', () => {
  assert.equal(shouldWriteStreamDraft({ lastLen: 0, nextLen: STREAM_DRAFT_MIN_DELTA, now: 0, lastAt: 0 }), true);
});

test('shouldWriteStreamDraft：增长小则看间隔', () => {
  assert.equal(shouldWriteStreamDraft({ lastLen: 10, nextLen: 12, now: 100, lastAt: 0 }), false);
  assert.equal(shouldWriteStreamDraft({ lastLen: 10, nextLen: 12, now: STREAM_DRAFT_MIN_INTERVAL_MS, lastAt: 0 }), true);
});

test('save/read/clear：按会话分键，读回同一份', async () => {
  const storage = fakeStorage();
  assert.equal(await saveStreamDraft('s1', { messageId: 'm1', text: '半截回复', at: 5 }, { storage }), true);
  const back = await readStreamDraft('s1', { storage });
  assert.deepEqual(back, { messageId: 'm1', text: '半截回复', reasoning: '', at: 5 });
  assert.equal(storage.map.has(streamDraftKey('s1')), true);
  assert.equal(await readStreamDraft('s2', { storage }), null, '别的会话读不到');
  assert.equal(await clearStreamDraft('s1', { storage }), true);
  assert.equal(await readStreamDraft('s1', { storage }), null);
});

test('save：无效草稿不写盘', async () => {
  const storage = fakeStorage();
  assert.equal(await saveStreamDraft('s1', { messageId: '', text: 'x' }, { storage }), false);
  assert.equal(storage.map.size, 0);
});

test('接线：useSessionMessages 生成中落草稿、加载时恢复', () => {
  const src = readFileSync(path.resolve('src/chat/useSessionMessages.js'), 'utf8');
  assert.ok(src.includes('shouldWriteStreamDraft('), '节流判定');
  assert.ok(src.includes('saveStreamDraft(sessionId,'), '生成中落盘');
  assert.ok(src.includes('readStreamDraft(activeSessionId)'), '加载时读草稿');
  assert.ok(src.includes('recovered: true'), '恢复消息带标记');
  assert.ok(src.includes('clearStreamDraft(previous)'), '结束后清草稿');
});

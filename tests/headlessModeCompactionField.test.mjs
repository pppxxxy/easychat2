// P0 修复回归：端点写模式门控 + 压缩摘要字段兼容。
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveHeadlessMode } from '../src/agent/agentEndpoint.js';
import { applyCompactionWithAuthority } from '../src/chat/compactionPipeline.js';

test('resolveHeadlessMode：写模式默认降级为 read，显式 allowWrite 才放行', () => {
  assert.equal(resolveHeadlessMode('write', false), 'read');
  assert.equal(resolveHeadlessMode('write'), 'read');
  assert.equal(resolveHeadlessMode('write', true), 'write');
  assert.equal(resolveHeadlessMode('read', false), 'read');
  assert.equal(resolveHeadlessMode('ask', false), 'ask');
});

test('applyCompactionWithAuthority：摘要消息同时带 text 与 content（主聊天页读 text、工作区读 content）', () => {
  const messages = [
    { id: 'u1', role: 'user', text: '第一轮' },
    { id: 'a1', role: 'assistant', text: '答复' },
  ];
  const out = applyCompactionWithAuthority(messages, '历史摘要内容', { keep: 0 });
  const summary = out[0];
  assert.equal(summary.role, 'assistant');
  assert.equal(typeof summary.text, 'string');
  assert.ok(summary.text.includes('历史摘要内容'), 'text 含摘要');
  assert.equal(summary.text, summary.content, 'text 与 content 同值');
});

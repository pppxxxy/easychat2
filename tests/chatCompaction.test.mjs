// D3 轻量 Compaction 测试（纯函数 + 接线契约）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  COMPACTION_KEEP_RECENT,
  COMPACTION_MARKER,
  COMPACTION_PER_MESSAGE_MAX,
  COMPACTION_THRESHOLD_BYTES,
  COMPACTION_TRANSCRIPT_MAX,
  applyCompaction,
  buildCompactionSummaryRequest,
  compactionStatus,
  estimateMessagesBytes,
  formatBytes,
  parseCompactionSummary,
  shouldCompact,
} from '../src/chat/compaction.js';

const msg = (role, text) => ({ id: `${role}-${text.length}`, role, text, at: 0 });

test('estimateMessagesBytes / shouldCompact：序列化体积口径 + 阈值', () => {
  assert.equal(estimateMessagesBytes([]), 2, "'[]' 长度");
  const small = [msg('user', 'hi')];
  assert.ok(estimateMessagesBytes(small) > 2);
  assert.equal(shouldCompact(small), false, '小会话不触发');
  assert.equal(
    shouldCompact([msg('user', 'x'.repeat(COMPACTION_THRESHOLD_BYTES))]),
    true,
    '超阈值触发'
  );
  assert.equal(estimateMessagesBytes(null), 2, '坏输入安全');
  assert.equal(shouldCompact(small, 10), true, '自定义阈值');
});

test('formatBytes：B / KB / MB', () => {
  assert.equal(formatBytes(0), '0B');
  assert.equal(formatBytes(999), '999B');
  assert.equal(formatBytes(2048), '2KB');
  assert.equal(formatBytes(4.5 * 1024 * 1024), '4.5MB');
});

test('buildCompactionSummaryRequest：system 三段式要求 + 转写 + 超长丢最旧', () => {
  const req = buildCompactionSummaryRequest([
    { role: 'user', text: '帮我看看', extra: 'ignored' },
    { role: 'assistant', text: '好的' },
    { role: 'system', text: '系统消息不进转写' },
    { role: 'user', text: '   ' },
  ]);
  assert.equal(req.length, 2);
  assert.match(req[0].content, /已完成/);
  assert.match(req[0].content, /关键决策与发现/);
  assert.match(req[0].content, /未完成与下一步/);
  assert.match(req[1].content, /用户：帮我看看/);
  assert.match(req[1].content, /助手：好的/);
  assert.equal(/系统消息/.test(req[1].content), false, 'system 不进转写');

  // 单条超长截断
  const long = buildCompactionSummaryRequest([{ role: 'user', text: 'x'.repeat(2000) }]);
  assert.ok(long[1].content.length <= COMPACTION_PER_MESSAGE_MAX + 10);

  // 总量超限：丢最旧的、保最新
  const many = Array.from({ length: 200 }, (unused, index) => msg('user', `第${index}条 ${'x'.repeat(400)}`));
  const capped = buildCompactionSummaryRequest(many);
  assert.ok(capped[1].content.length <= COMPACTION_TRANSCRIPT_MAX + 1000, '请求本身不爆');
  assert.ok(capped[1].content.includes('第199条'), '最新的一定在');
  assert.equal(capped[1].content.includes('第0条'), false, '最旧的被丢');
});

test('applyCompaction：摘要消息 + 最近 K 条原文（保序）；空/keep=0 安全', () => {
  const list = Array.from({ length: 20 }, (unused, index) => msg(index % 2 === 0 ? 'user' : 'assistant', `消息${index}`));
  const next = applyCompaction(list, '已完成：A\n关键决策与发现：B\n未完成与下一步：C');
  assert.equal(next.length, 1 + COMPACTION_KEEP_RECENT);
  assert.equal(next[0].role, 'assistant');
  assert.ok(next[0].text.startsWith(COMPACTION_MARKER));
  assert.ok(next[0].id.startsWith('compaction-'));
  assert.deepEqual(
    next.slice(1).map(item => item.text),
    list.slice(-COMPACTION_KEEP_RECENT).map(item => item.text),
    '最近 K 条按原顺序保留'
  );
  assert.equal(applyCompaction([], 'x').length, 1, '空输入只有摘要');
  assert.equal(applyCompaction(list, 'x', 0).length, 1, 'keep=0 只有摘要');
});

test('parseCompactionSummary / compactionStatus：trim 与体积概览', () => {
  assert.equal(parseCompactionSummary('  a\n b  '), 'a\n b');
  assert.equal(parseCompactionSummary(null), '');
  const status = compactionStatus([msg('user', 'hi')]);
  assert.ok(status.bytes > 0 && status.sizeText);
  assert.equal(status.due, false);
  assert.equal(
    compactionStatus([msg('user', 'x'.repeat(COMPACTION_THRESHOLD_BYTES + 10))]).due,
    true,
    '超阈值时给设置页「该压缩了」信号'
  );
});

test('D3 接线契约：ChatScreen 手动压缩 + 设置弹窗入口 + 失败不动会话', () => {
  const screen = fs.readFileSync(path.resolve('src/ChatScreen.js'), 'utf8');
  assert.ok(screen.includes('handleCompactSession'), '压缩 handler 存在');
  assert.ok(screen.includes('stream: false'), '压缩走一次非流式模型调用');
  assert.ok(screen.includes('applyCompaction(list, summary)'), '成功才替换消息数组');
  assert.ok(screen.includes("t('chat.settings.compactFail')"), '失败明确提示');
  assert.ok(screen.includes('compactInfo={compactInfo}'), '体积概览传给设置弹窗');
  const modal = fs.readFileSync(path.resolve('src/chat/ChatSettingsModal.js'), 'utf8');
  assert.ok(modal.includes("t('chat.settings.compact'"), '设置入口（带体积）');
  assert.ok(modal.includes('onCompactSession'), '触发回调');
});

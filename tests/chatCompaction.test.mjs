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

test('E2 压缩自动化接线：silent 模式 + 85% 空闲自动触发 + 70% 提示条 + 设置开关', () => {
  const screen = fs.readFileSync(path.resolve('src/ChatScreen.js'), 'utf8');
  // silent 模式：自动路径不弹窗、返回结果对象供调用方决策；防重入走 ref
  assert.ok(screen.includes('options && options.silent === true'), 'handleCompactSession 支持 silent');
  assert.ok(screen.includes('compactBusyRef.current = true'), '防重入走 ref（异步闭包里 state 不可靠）');
  assert.ok(!screen.includes('if (compactBusy) return;\n    const list ='), '旧的 state 防重入已换成 ref 版');
  // 自动触发：空闲时静默压缩——不放发送路径（避免「压缩替换消息」与「发送读消息」竞态）。
  // Z 系采纳 #5：触发口径从固定 85% 改为 token 预算，触发逻辑外提到 useAutoCompact。
  assert.ok(screen.includes("import useAutoCompact from './chat/useAutoCompact.js';"), '自动触发已外提');
  assert.ok(screen.includes('useAutoCompact({'), '聊天页接线');
  assert.ok(screen.includes('enabled: chatOptions.autoCompact'), '系统设置可关（缺省开）');
  const autoCompact = fs.readFileSync(path.resolve('src/chat/useAutoCompact.js'), 'utf8');
  assert.ok(autoCompact.includes('enabled === false'), '开关关时不触发');
  assert.ok(autoCompact.includes('shouldAutoCompactByBudget(contextUsage.tokens, policy)'), 'token 预算阈值（不再是固定比例）');
  assert.ok(autoCompact.includes('if (isSending || compactBusyRef.current) return;'), '发送中/压缩中不触发');
  assert.ok(autoCompact.includes('microcompactMessages(messagesRef.current)'), '先试本地微压缩（零 API 调用）');
  assert.ok(autoCompact.includes('onCompact({ silent: true })'), '自动路径走 silent');
  assert.ok(
    autoCompact.includes('attemptRef.current === messages.length'),
    '同一消息条数只尝试一次（失败不重试、防死循环）'
  );
  // 70% 非阻塞提示条（手动入口 + 可忽略）
  assert.ok(screen.includes("t('chat.compact.hint'"), '提示条文案（带占用百分比）');
  assert.ok(screen.includes("t('chat.compact.action')"), '一键压缩按钮');
  assert.ok(screen.includes('setCompactHintDismissed(true)'), '可忽略提示');

  // 设置开关：体验区 Switch + 存储归一（默认开）
  const section = fs.readFileSync(path.resolve('src/settings/sections/ExperienceSection.js'), 'utf8');
  assert.ok(section.includes("updateChatOption('autoCompact', value)"), '体验区开关接线');
  const options = fs.readFileSync(path.resolve('src/storage/settings/chatOptions.js'), 'utf8');
  assert.ok(options.includes('autoCompact: source.autoCompact !== false'), '缺省开启（只有显式 false 才关）');
});

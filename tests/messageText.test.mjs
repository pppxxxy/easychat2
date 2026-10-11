// 消息正文口径（src/chat/messageText.js）+ 压缩摘要气泡正文契约的回归测试。
//
// 为什么单独立文件：这个口径出过一次事故（2026-10-11 逐行审查 P0-3）——压缩管线建的摘要消息
// 只写了 `content`，而聊天页的正文契约是 `text`：气泡空白、摘要对模型不可见、导出也是空的。
// 当时门禁全绿，因为既有测试读的是 `content`（管线自己的口径），从没走过聊天页的读取方。
// 所以这里的断言必须**跨读取方**：管线产出 → 聊天页的发送路径（getMessagePromptText）、
// 导出路径（messageBodyText）、渲染路径的字段（text）都要取到同一段正文。

import test from 'node:test';
import assert from 'node:assert/strict';

import { hasMessageText, messageTextOf } from '../src/chat/messageText.js';
import { getMessagePromptText } from '../src/chat/chatMedia.js';
import { messageBodyText } from '../src/chat/conversationExport.js';
import { COMPACTION_MARKER } from '../src/chat/compaction.js';
import { applyCompactionWithAuthority } from '../src/chat/compactionPipeline.js';

test('messageTextOf：两种消息形状一个口径（text 优先，非空字符串才算正文）', () => {
  // 聊天页形状（正文在 text）
  assert.equal(messageTextOf({ role: 'user', text: '你好' }), '你好');
  // 工作区形状 / 模型历史 / tool 消息（正文在 content）
  assert.equal(messageTextOf({ role: 'assistant', content: '读完了' }), '读完了');
  assert.equal(messageTextOf({ role: 'tool', tool_call_id: 'c1', content: '文件内容' }), '文件内容');
  // 两者都有 → text 优先（聊天页正文契约）
  assert.equal(messageTextOf({ text: '聊天页正文', content: '工作区正文' }), '聊天页正文');
  // **关键**：text 是空串不是「有正文」——流式占位消息常见形态，必须回落到 content。
  // 旧口径（compactionPipeline 的 content 优先）在这里对、compaction.js 的 `text || content` 也对，
  // 但 contextUsage.js 的「只看 text」会把工作区消息整条读成空。统一后只有一个答案。
  assert.equal(messageTextOf({ text: '', content: '工作区正文' }), '工作区正文');
  // 缺字段 / 坏输入
  assert.equal(messageTextOf({ role: 'user' }), '');
  assert.equal(messageTextOf({ text: null, content: null }), '');
  assert.equal(messageTextOf(null), '');
  assert.equal(messageTextOf(undefined), '');
  assert.equal(messageTextOf('字符串不是消息'), '');
  // 非字符串正文按字符串处理（不抛）
  assert.equal(messageTextOf({ content: 0 }), '0');
  // 「有正文」判据与之一致（trim 后非空）
  assert.equal(hasMessageText({ text: '  ' }), false);
  assert.equal(hasMessageText({ content: 'x' }), true);
});

test('回归 P0-3：压缩摘要消息在**所有读取方**都取得到正文（text + content 都写）', () => {
  const messages = [
    { role: 'user', text: '把工具结果修一下' },
    { role: 'assistant', text: '好' },
  ];
  const out = applyCompactionWithAuthority(messages, '已完成：A\n关键决策与发现：B\n未完成与下一步：C', {
    transcriptPath: '.transcripts/2026.jsonl',
  });
  const summary = out[0];
  assert.equal(summary.role, 'assistant');
  // 1) 聊天页渲染 / 分支 / 导出读的是 text —— 缺了就是空气泡
  assert.equal(typeof summary.text, 'string');
  assert.ok(summary.text.includes(COMPACTION_MARKER), '摘要气泡正文必须带压缩标记');
  assert.ok(summary.text.includes('已完成：A'));
  // 2) 工作区面板渲染读的是 content —— 只写 text 会让工作区面板空白
  assert.equal(typeof summary.content, 'string');
  assert.ok(summary.content.includes(COMPACTION_MARKER));
  // 3) 两个字段必须是同一段正文（否则「同一会话两种渲染」又分叉）
  assert.equal(summary.text, summary.content);
  // 4) 发送路径（模型到底看不看得见摘要）
  const promptText = getMessagePromptText(summary);
  assert.ok(promptText.includes('已完成：A'), '摘要必须能被投影进发给模型的消息');
  assert.ok(promptText.includes('完整历史：.transcripts/2026.jsonl'), '归档指针也要在正文里');
  // 5) 导出路径
  assert.ok(messageBodyText(summary).includes('已完成：A'), '导出不能导出空条目');
  // 6) 统一口径读得到
  assert.equal(messageTextOf(summary), summary.text);
});

test('回归 P0-3：旧写法（只写 content）会被本测试抓住', () => {
  // 这条是「注入验证」的固化：把 applyCompactionWithAuthority 改回只写 content，
  // 上一条测试的 text / getMessagePromptText / messageBodyText 三处断言立刻变红。
  // 这里用一个只写 content 的等价消息证明那三处断言确实有鉴别力（不是恒真）。
  const legacy = { id: 'compaction-1', role: 'assistant', content: `${COMPACTION_MARKER}\n已完成：A`, at: 1 };
  assert.equal(legacy.text, undefined, '旧写法没有 text');
  assert.equal(getMessagePromptText(legacy), '', '旧写法在发送路径上正文为空（模型看不见摘要）');
  assert.equal(messageBodyText(legacy), '', '旧写法导出为空');
  // 而统一口径能兜住 content——这正是「读取方各自为政」与「统一口径」的差别所在：
  // 口径统一解决「谁读得到」，字段写全解决「聊天页渲染/发送/导出」。两者都要。
  assert.ok(messageTextOf(legacy).includes(COMPACTION_MARKER));
});

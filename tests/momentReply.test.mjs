import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildMomentMemoryText,
  buildMomentReplyPrompt,
  buildMomentThread,
  normalizeMomentReply,
} from '../src/moments/momentReply.js';

test('记忆正文优先使用会话摘要', () => {
  const text = buildMomentMemoryText({
    summaries: [{ summary: '- 你们约好周末去看海' }, { summary: '   ' }],
    messages: [{ role: 'user', text: '这条不该出现' }],
  });
  assert.equal(text, '- 你们约好周末去看海');
});

test('没有摘要时退化为该会话最近若干条消息', () => {
  const messages = Array.from({ length: 12 }, (unused, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    text: `第${index + 1}句`,
  }));
  const text = buildMomentMemoryText({
    messages,
    charName: '角色5',
    userName: '主人',
    maxMessages: 3,
  });
  const lines = text.split('\n');
  assert.equal(lines.length, 3);
  assert.equal(lines[0], '角色5：第10句');
  assert.equal(lines[1], '主人：第11句');
  assert.equal(lines[2], '角色5：第12句');
  assert.equal(text.includes('第9句'), false);
});

test('记忆正文在无摘要无消息时为空串', () => {
  assert.equal(buildMomentMemoryText({}), '');
  assert.equal(buildMomentMemoryText({ messages: [{ role: 'system', text: 'x' }] }), '');
});

test('退化记忆会移除富文本标签和样式', () => {
  const text = buildMomentMemoryText({
    messages: [{ role: 'assistant', text: '<style>.x{color:red}</style><p>你好 &amp; 朋友</p>' }],
  });
  assert.equal(text, '角色：你好 & 朋友');
});

test('评论串按说话人渲染', () => {
  const thread = buildMomentThread(
    [
      { by: 'user', text: '怎么啦' },
      { by: 'character', name: '角色5', text: '没什么' },
      { by: 'user', text: '' },
    ],
    { charName: '角色5', userName: '主人' }
  );
  assert.equal(thread, '主人：怎么啦\n角色5：没什么');
});

test('提示词包含动态正文、记忆与全部评论', () => {
  const prompt = buildMomentReplyPrompt({
    moment: { text: '今天心情特别好', characterName: '角色5' },
    comments: [
      { by: 'user', text: '怎么啦' },
      { by: 'character', name: '角色5', text: '没什么' },
      { by: 'user', text: '真的吗' },
    ],
    memoryText: '- 你们约好周末去看海',
    charName: '角色5',
    userName: '主人',
  });
  assert.ok(prompt.includes('今天心情特别好'));
  assert.ok(prompt.includes('你们约好周末去看海'));
  assert.ok(prompt.includes('主人：怎么啦'));
  assert.ok(prompt.includes('主人：真的吗'));
  assert.ok(prompt.includes('40 字以内'));
  assert.ok(prompt.includes('不要提到“记忆”“摘要”“系统”这类词'));
});

test('没有记忆时不留记忆段落', () => {
  const prompt = buildMomentReplyPrompt({
    moment: { text: '动态' },
    comments: [{ by: 'user', text: '在吗' }],
    charName: '角色5',
  });
  assert.equal(prompt.includes('你对那段经历的记忆是'), false);
  assert.ok(prompt.includes('动态下的评论：'));
});

test('回复清洗：去引号、去换行、去括号、截断', () => {
  assert.equal(normalizeMomentReply('「记得带伞。」'), '记得带伞。');
  assert.equal(normalizeMomentReply('第一行\n第二行'), '第一行 第二行');
  assert.equal(normalizeMomentReply('（笑）'), '笑');
  assert.equal(normalizeMomentReply('回复：好呀'), '好呀');
  assert.equal(normalizeMomentReply('   '), '');
  assert.equal(normalizeMomentReply(null), '');

  const long = 'a'.repeat(300);
  const cut = normalizeMomentReply(long);
  assert.equal(cut.length, 200);
  assert.ok(cut.endsWith('…'));
});

test('记忆正文与评论串都有长度上限', () => {
  const huge = buildMomentMemoryText({
    summaries: Array.from({ length: 20 }, () => ({ summary: 'x'.repeat(1000) })),
  });
  assert.equal(huge.length, 4000);

  const messages = Array.from({ length: 40 }, (unused, index) => ({
    role: 'assistant',
    text: `第${index}-${'y'.repeat(300)}`,
  }));
  const fallback = buildMomentMemoryText({ messages, maxMessages: 40 });
  assert.equal(fallback.length, 4000);

  const thread = buildMomentThread(
    Array.from({ length: 50 }, (unused, index) => ({ by: 'user', text: `第${index}条${'z'.repeat(100)}` }))
  );
  assert.equal(thread.length, 2000);
  // 保留最近的部分（末尾）
  assert.ok(thread.endsWith('z'));
});

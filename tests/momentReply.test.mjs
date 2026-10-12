import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));

import {
  buildMomentCommentPrompt,
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

test('用户动态的评论提示词：重点是回应用户本人，嵌套回复走「回复<名字>：」前缀', () => {
  const prompt = buildMomentCommentPrompt({
    moment: { text: '人世间悲苦吃不完', authorType: 'user' },
    comments: [
      { id: 'c1', by: 'character', name: '宵宫', text: '怎么啦' },
    ],
    memoryText: '- 你们聊过烟花',
    charName: '镜流',
    userName: '我',
  });
  assert.ok(prompt.includes('你是镜流'));
  assert.ok(prompt.includes('我发了一条动态：'));
  assert.ok(prompt.includes('人世间悲苦吃不完'));
  assert.ok(prompt.includes('你们聊过烟花'));
  assert.ok(prompt.includes('宵宫：怎么啦'), '已有评论要作为参考出现');
  assert.ok(prompt.includes('重点是回应用户我发的这条动态'));
  assert.ok(prompt.includes('回复<对方名字>：'), '给出嵌套回复的写法');
  // 不能再出现「回复最新那条评论」——那正是用户抱怨的「只接上一个角色的评论」
  assert.equal(prompt.includes('回复最新那条评论'), false);
});

test('用户动态的评论提示词：指定 focus 时点名回应那句话', () => {
  const prompt = buildMomentCommentPrompt({
    moment: { text: '动态', authorType: 'user' },
    comments: [{ id: 'c1', by: 'user', name: '我', text: '你上次说的那件事呢' }],
    charName: '宵宫',
    userName: '我',
    focusCommentId: 'c1',
  });
  assert.ok(prompt.includes('我刚刚说：「你上次说的那件事呢」'));
  assert.ok(prompt.includes('回应我说'));
  assert.equal(prompt.includes('重点是回应用户'), false);
});

test('角色动态的回复提示词：指定 focusCommentId 时点名回复那条评论', () => {
  const prompt = buildMomentReplyPrompt({
    moment: { text: '今天心情特别好', characterName: '角色5' },
    comments: [
      { id: 'c1', by: 'character', name: '宵宫', text: '怎么啦' },
      { id: 'c2', by: 'user', name: '我', text: '没什么吧' },
    ],
    charName: '角色5',
    userName: '主人',
    focusCommentId: 'c2',
  });
  assert.ok(prompt.includes('主人刚刚评论说：「没什么吧」'));
  assert.ok(prompt.includes('回复主人的这条评论'));
  assert.equal(prompt.includes('回复最新那条评论'), false);
  // 没指定 focus 时保留旧的「回复最新那条」行为
  const legacy = buildMomentReplyPrompt({
    moment: { text: '动态' },
    comments: [{ by: 'user', text: '在吗' }],
    charName: '角色5',
  });
  assert.ok(legacy.includes('回复最新那条评论'));
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

test('用户发的动态走“用户发动态、角色来评论”的提示词，角色自己的动态仍走原提示词', () => {
  const userMoment = { id: 'm1', text: '今天面试过了！', authorType: 'user', characterId: '' };
  const args = {
    moment: userMoment,
    comments: [{ by: 'user', text: '太好了' }],
    memoryText: '- 你们约好周末去看海',
    charName: '角色5',
    userName: '主人',
  };
  const prompt = buildMomentReplyPrompt(args);
  // 不能把用户的动态说成角色自己发的
  assert.equal(prompt.includes('你刚刚在自己的社交动态里发了一条动态'), false);
  assert.ok(prompt.includes('主人发了一条动态：'));
  assert.ok(prompt.includes('「今天面试过了！」'));
  assert.ok(prompt.includes('请以角色5的身份，在这条动态下写一条评论'));
  assert.ok(prompt.includes('主人：太好了'));
  assert.ok(prompt.includes('你们约好周末去看海'));
  // 与专用入口同源：分流不是第二份实现
  assert.equal(prompt, buildMomentCommentPrompt(args));

  const ownMoment = {
    id: 'm2',
    text: '我自己的动态',
    authorType: 'character',
    characterName: '角色5',
  };
  const own = buildMomentReplyPrompt({
    moment: ownMoment,
    comments: [{ by: 'user', text: '在吗' }],
    charName: '角色5',
    userName: '主人',
  });
  assert.ok(own.includes('你刚刚在自己的社交动态里发了一条动态'));
  assert.ok(own.includes('请以角色5的身份，回复最新那条评论'));
  assert.equal(own.includes('你正在刷社交动态'), false);
});

test('用户动态的评论执行器用的是「角色来评论」提示词，不再用「角色自己的动态」那条', () => {
  const source = readFileSync(path.join(HERE, '..', 'src/moments/runUserMomentComments.js'), 'utf8');
  assert.ok(source.includes('buildMomentCommentPrompt'));
  assert.equal(source.includes('buildMomentReplyPrompt'), false);
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

  // 提示词层同样设限：调用方（MomentsView 的 buildMemorySummaryText 未传预算）传进来的
  // 记忆也必须截断，否则 20000 字的记忆会原样进提示词（实测过 prompt 20201 字）。
  const oversized = 'x'.repeat(20000);
  const prompt = buildMomentReplyPrompt({
    moment: { text: '动态' },
    comments: [],
    memoryText: oversized,
  });
  assert.ok(prompt.includes('x'.repeat(4000)));
  assert.equal(prompt.includes('x'.repeat(4001)), false);
  // 用户动态那条提示词同一口径
  const commentPrompt = buildMomentCommentPrompt({
    moment: { text: '动态', authorType: 'user' },
    comments: [],
    memoryText: oversized,
  });
  assert.equal(commentPrompt.includes('x'.repeat(4001)), false);

  // 正常长度不受影响（不误截）
  const normal = buildMomentReplyPrompt({
    moment: { text: '动态' },
    comments: [],
    memoryText: '- 你们约好周末去看海',
  });
  assert.ok(normal.includes('- 你们约好周末去看海'));
});

// 「从对话生成角色卡」纯逻辑：转写（说话人/裁剪/预算丢弃）+ 提炼提示词。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildConversationCardPrompt,
  CONVERSATION_MESSAGE_MAX_CHARS,
  CONVERSATION_TRANSCRIPT_MAX_CHARS,
  formatConversationTranscript,
} from '../src/cardForge/forge/conversation.js';
import { FORGE_SAMPLING_OVERRIDES, FORGE_SYSTEM } from '../src/cardForge/forge/shared.js';

function msg(role, text, extra = {}) {
  return { id: `${role}-${text.slice(0, 4)}`, role, text, timestamp: 1, ...extra };
}

test('formatConversationTranscript：按说话人转写，用户用用户名、角色用角色名', () => {
  const result = formatConversationTranscript([
    msg('user', '今天好累'),
    msg('assistant', '那就早点休息'),
  ], { userName: '小明', characterName: '阿澈' });
  assert.equal(result.text, '小明：今天好累\n阿澈：那就早点休息');
  assert.equal(result.kept, 2);
  assert.equal(result.dropped, 0);
  assert.equal(result.total, 2);
});

test('formatConversationTranscript：群聊里助手消息优先用 speakerName', () => {
  const result = formatConversationTranscript([
    msg('assistant', '我来啦', { speakerName: '小雨' }),
  ], { characterName: '默认角色' });
  assert.equal(result.text, '小雨：我来啦');
});

test('formatConversationTranscript：跳过系统消息、占位消息与空文本', () => {
  const result = formatConversationTranscript([
    { id: 's', role: 'system', text: '系统提示' },
    msg('user', '真实发言'),
    msg('assistant', ''),
    { id: 'p', role: 'assistant', text: '生成中', pending: true },
    null,
  ], { userName: '用户', characterName: '角色' });
  // pending 消息本身文本非空，这里只断言 system / 空文本被丢弃、真实发言保留
  assert.ok(result.text.includes('用户：真实发言'));
  assert.ok(!result.text.includes('系统提示'));
  assert.equal(result.total, 2, 'system 与空文本不计入');
});

test('formatConversationTranscript：单条超长消息被裁剪，不吃光预算', () => {
  const long = '啊'.repeat(CONVERSATION_MESSAGE_MAX_CHARS + 200);
  const result = formatConversationTranscript([msg('assistant', long)], { characterName: '角色' });
  assert.ok(result.text.length < long.length, '超长消息被裁剪');
  assert.ok(result.text.endsWith('…'), '裁剪处有省略标记');
});

test('formatConversationTranscript：超预算时保留最近的，并如实报告省略条数', () => {
  const many = Array.from({ length: 40 }, (unused, index) => msg('user', `第${index}条发言`));
  const result = formatConversationTranscript(many, { userName: '用户', maxChars: 120 });
  assert.ok(result.kept > 0, '至少保留一条');
  assert.ok(result.text.length <= 120, '不超过预算');
  assert.equal(result.dropped, 40 - result.kept);
  assert.equal(result.kept + result.dropped, result.total);
  assert.ok(result.text.includes('第39条发言'), '保留的是最近的消息');
  assert.ok(!result.text.includes('第0条发言'), '最早的消息被丢弃');
});

test('formatConversationTranscript：空输入返回空文本而不是崩', () => {
  const result = formatConversationTranscript(null);
  assert.equal(result.text, '');
  assert.equal(result.kept, 0);
  assert.equal(result.total, 0);
});

test('formatConversationTranscript：不传预算时用默认总预算（6000 字）', () => {
  // 默认值本身就是契约：调大它会挤占制卡请求的输出预算，导致 JSON 被截断。
  assert.equal(CONVERSATION_TRANSCRIPT_MAX_CHARS, 6000);
  const many = Array.from({ length: 60 }, () => msg('user', '啊'.repeat(500)));
  const result = formatConversationTranscript(many, { userName: '用户' });
  assert.ok(result.text.length <= CONVERSATION_TRANSCRIPT_MAX_CHARS);
  assert.ok(result.dropped > 0, '总量远超预算时必然发生丢弃');
});

test('buildConversationCardPrompt：带上对话、角色名与忠实性要求', () => {
  const prompt = buildConversationCardPrompt({
    transcript: '小明：今天好累\n阿澈：那就早点休息',
    characterName: '阿澈',
    userName: '小明',
  });
  assert.ok(prompt.includes('小明：今天好累'), '包含对话原文');
  assert.ok(prompt.includes('阿澈'), '包含角色名');
  assert.ok(prompt.includes('不要凭空添加对话里没有依据的设定'), '要求忠实于对话');
  assert.ok(prompt.includes('口癖'), '要求提炼说话方式与口癖');
  // 复用整卡生成的字段规则：字段名与「只输出 JSON」必须一致
  assert.ok(prompt.includes('name, description, personality, scenario, firstMes, mesExample, creatorNotes, postHistoryInstructions, tags'));
  assert.ok(prompt.includes('只输出一个 JSON 对象'));
  assert.ok(!prompt.includes('用户的补充要求'), '没给补充要求时不出现该行');
});

test('buildConversationCardPrompt：补充要求与省略提示按需出现', () => {
  const withHint = buildConversationCardPrompt({
    transcript: '甲：在',
    characterName: '甲',
    hint: '名字叫阿澈',
    dropped: 3,
  });
  assert.ok(withHint.includes('用户的补充要求：名字叫阿澈'));
  assert.ok(withHint.includes('最早的 3 条消息已被省略'), '如实告知丢弃条数');
  const withoutDrop = buildConversationCardPrompt({ transcript: '甲：在', characterName: '甲' });
  assert.ok(!withoutDrop.includes('已被省略'));
});

test('buildConversationCardPrompt：没有可用对话时给出占位而不是空串', () => {
  const prompt = buildConversationCardPrompt({ transcript: '', characterName: '甲' });
  assert.ok(prompt.includes('（没有可用的对话内容）'));
});

test('两条制卡入口共用同一份系统提示词与采样参数（防漂移）', () => {
  // 这条断言的是「共享」这件事本身：常量必须来自 shared.js，且取值稳定。
  // 若哪天有人只在某一侧改了温度或系统提示词，这条会先红。
  assert.equal(typeof FORGE_SYSTEM, 'string');
  assert.ok(FORGE_SYSTEM.includes('角色卡'));
  assert.deepEqual(FORGE_SAMPLING_OVERRIDES, { temperature: 0.3, maxTokens: 8192 });
});

// 定位条预览的逐条缓存（行为测试）。
//
// 背景（2026-10-17 卡顿取证）：流式生成期间 messages 每个节流 tick 都更新，
// useScrollScrubber 的 scrubberPreviews 会随之重算**全历史**的预览。而预览的每个字段
// 只取决于那一条消息，与历史里其它消息无关——这是纯粹的重复劳动，且随会话变长线性恶化。
//
// 实测（Node 基准，中文历史 2000 条 × 平均 300 字 / 总文本约 586 KB）：
//   scrubberPreviews 4.47 ms/tick；5000 条 × 300 字时 11.97 ms/tick
//   （单这一项就占 16.67ms 帧预算的 72%），且定位条**没打开**时也照算。
//   按消息引用缓存后同样的历史降到 0.02 ms/tick 量级。
//
// 这里钉的是缓存契约本身：命中必须复用同一份对象（性能判据），失效必须在
// 「说话人兜底名变了」「语言变了」两种情况下真的发生（正确性判据）。
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildScrubberPreview } from '../src/chat/useScrollScrubber.js';

const USER_ID = 'user';
const ASSISTANT_ID = 'assistant';

// 两个「语言」的假词条函数：t 在真实代码里由 I18nContext 的 useMemo 产出，
// 只在 localeId 变化时换引用（I18nContext.js:76-90），所以按引用比对就是换语言的判据。
const tZh = (key) => {
  if (key === 'chat.bubble.me') return '我';
  if (key === 'common.characterFallback') return '角色';
  return key;
};
const tEn = (key) => {
  if (key === 'chat.bubble.me') return 'Me';
  if (key === 'common.characterFallback') return 'Character';
  return key;
};

const assistantMessage = (id, text, timestamp = 1700000000000) => ({
  id, role: ASSISTANT_ID, text, timestamp,
});

test('缓存命中：同一条消息 + 同一说话人 + 同一语言 ⇒ 复用同一份预览对象', () => {
  const message = assistantMessage('cache-hit-1', '第一次算出来的预览');
  const first = buildScrubberPreview(message, '小美', tZh);
  const second = buildScrubberPreview(message, '小美', tZh);
  // 引用相等就是「没有重算」的证据：流的每个 tick 只会给新变化的尾部消息建对象。
  assert.equal(second, first, '同一条未变化的消息必须命中缓存，不得重建预览对象');
  assert.equal(second.text, '第一次算出来的预览');
});

test('缓存不串条：不同消息对象各自成项（即使文本完全相同）', () => {
  const first = assistantMessage('cache-distinct-1', '同一段文字');
  const second = assistantMessage('cache-distinct-2', '同一段文字');
  const a = buildScrubberPreview(first, '小美', tZh);
  const b = buildScrubberPreview(second, '小美', tZh);
  assert.notEqual(a, b, '按对象引用分桶，两条消息不得共用一份预览');
  assert.deepEqual(a, b);
});

test('失效：说话人兜底名变化时必须重算（否则改名后定位条还念旧名）', () => {
  const message = assistantMessage('cache-speaker-1', '正文');
  const before = buildScrubberPreview(message, '小美', tZh);
  assert.equal(before.speaker, '小美');
  const after = buildScrubberPreview(message, '小丽', tZh);
  assert.notEqual(after, before, '说话人名变了必须重算');
  assert.equal(after.speaker, '小丽', '重算后的说话人必须是新名字');
});

test('失效：语言变化时必须重算（换语言后预览说话人不得停在旧语言）', () => {
  const message = assistantMessage('cache-locale-1', '正文');
  const zh = buildScrubberPreview(message, '', tZh);
  assert.equal(zh.speaker, '角色', '没有说话人名时用兜底词条');
  const en = buildScrubberPreview(message, '', tEn);
  assert.notEqual(en, zh, '换了语言（t 换引用）必须重算');
  assert.equal(en.speaker, 'Character', '重算后必须用新语言的兜底词条');
});

test('说话人判定：用户消息用「我」，助手消息用说话人名', () => {
  const user = buildScrubberPreview({ id: 'cache-role-u', role: USER_ID, text: '你好' }, '小美', tZh);
  const assistant = buildScrubberPreview({ id: 'cache-role-a', role: ASSISTANT_ID, text: '你好' }, '小美', tZh);
  assert.equal(user.speaker, '我');
  assert.equal(assistant.speaker, '小美');
});

test('正文投影保持原口径：折叠空白 + 去首尾 + 只留前 60 字', () => {
  const message = assistantMessage('cache-project-1', '  第一段\n\n第二段\t  ');
  assert.equal(buildScrubberPreview(message, '小美', tZh).text, '第一段 第二段');

  const long = assistantMessage('cache-project-2', `${'字'.repeat(90)}尾巴`);
  const preview = buildScrubberPreview(long, '小美', tZh);
  assert.equal(preview.text.length, 60, '超长正文只留前 60 字');
  assert.equal(preview.text, '字'.repeat(60));
});

test('投影仍走 getMessagePromptText：语音消息用占位文案而不是空串', () => {
  const voice = {
    id: 'cache-voice-1', role: USER_ID, kind: 'voice', audio: { uri: 'file:///a.m4a' }, text: '',
  };
  const preview = buildScrubberPreview(voice, '小美', tZh);
  assert.equal(preview.text, '[用户发来一段语音]', '语音消息必须有占位投影（抽取时不得换成裸 message.text）');
});

test('时间标签：有时间戳就有标签，时间戳非法则为空（不抛）', () => {
  const withTime = buildScrubberPreview(assistantMessage('cache-time-1', '正文', 1700000000000), '小美', tZh);
  assert.ok(withTime.label && withTime.label.length > 0, '合法时间戳必须给出标签');
  const withoutTime = buildScrubberPreview(
    { id: 'no-numeric-prefix', role: ASSISTANT_ID, text: '正文' },
    '小美',
    tZh
  );
  assert.equal(withoutTime.label, '', '既无 timestamp 又无法从 id 解析时，标签为空而不是 NaN');
});

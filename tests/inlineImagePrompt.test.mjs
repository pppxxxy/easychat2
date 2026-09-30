import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  buildScenePrompt,
  DEFAULT_INLINE_IMAGE_POSITION,
  INLINE_IMAGE_POSITIONS,
  normalizeImagePosition,
  normalizeScenePrompt,
  selectReplySegment,
  splitReplyParagraphs,
} from '../src/inlineImagePrompt.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHAT_SCREEN_SOURCE = readFileSync(path.join(HERE, '..', 'src', 'ChatScreen.js'), 'utf8');

test('配图挂载到替换后的文字消息 id，而非 pending 占位符 id', () => {
  // 回归：pending 占位符会被 replyParts 替换、id 改变；继续用 pendingAssistantMessage.id
  // 调 generateInlineImage 会永久匹配失败（图静默不出现）。
  assert.equal(
    CHAT_SCREEN_SOURCE.includes('generateInlineImageRef.current?.(pendingAssistantMessage.id'),
    false,
    '不得再用 pending id 调配图'
  );
  const call = CHAT_SCREEN_SOURCE.match(/generateInlineImageRef\.current\?\.\(([^)]*)\)/);
  assert.ok(call, '未找到配图调用');
  assert.ok(call[1].includes('inlineTarget.id'), '应使用替换后文字消息的 id');
});

test('配图位置规范化：非法值与空值回退默认结尾', () => {
  assert.deepEqual(INLINE_IMAGE_POSITIONS, ['start', 'middle', 'end']);
  assert.equal(DEFAULT_INLINE_IMAGE_POSITION, 'end');
  assert.equal(normalizeImagePosition('start'), 'start');
  assert.equal(normalizeImagePosition('middle'), 'middle');
  assert.equal(normalizeImagePosition('end'), 'end');
  assert.equal(normalizeImagePosition(''), 'end');
  assert.equal(normalizeImagePosition('高潮'), 'end');
  assert.equal(normalizeImagePosition(undefined), 'end');
});

test('回复分段：优先空行，其次换行，空文本为空数组', () => {
  assert.deepEqual(splitReplyParagraphs('甲\n\n乙\n\n丙'), ['甲', '乙', '丙']);
  assert.deepEqual(splitReplyParagraphs('甲\n乙\n丙'), ['甲', '乙', '丙']);
  assert.deepEqual(splitReplyParagraphs('只有一段'), ['只有一段']);
  assert.deepEqual(splitReplyParagraphs('   '), []);
});

test('按位置取段落：开头首段、高潮正中、结尾末段', () => {
  const reply = '第一段\n\n第二段\n\n第三段\n\n第四段\n\n第五段';
  assert.equal(selectReplySegment(reply, 'start'), '第一段');
  assert.equal(selectReplySegment(reply, 'middle'), '第三段');
  assert.equal(selectReplySegment(reply, 'end'), '第五段');
  // 偶数段时“正中”取下偏中（floor((n-1)/2)）
  assert.equal(selectReplySegment('A\n\nB', 'middle'), 'A');
  assert.equal(selectReplySegment('A\n\nB\n\nC\n\nD', 'middle'), 'B');
  assert.equal(selectReplySegment('', 'end'), '');
});

test('场景转写提示词：包含双方、片段与画面要求', () => {
  const prompt = buildScenePrompt({
    segment: '火车缓缓开动，她隔着车窗看着站台上的我。',
    userText: '我送你上火车吧。',
    charName: '晚星',
    userName: '小明',
  });
  assert.ok(prompt.includes('小明'));
  assert.ok(prompt.includes('晚星'));
  assert.ok(prompt.includes('我送你上火车吧。'));
  assert.ok(prompt.includes('火车缓缓开动'));
  assert.ok(prompt.includes('画面状态'));
  assert.ok(prompt.includes('不要复述台词'));
});

test('场景输出清洗：剥前缀/引号、压缩换行、超长截断', () => {
  assert.equal(normalizeScenePrompt('画面：晚星在火车上望着窗外流泪'), '晚星在火车上望着窗外流泪');
  assert.equal(normalizeScenePrompt('「她靠着车窗流泪」'), '她靠着车窗流泪');
  assert.equal(normalizeScenePrompt('晚星\n在火车上\n流泪'), '晚星 在火车上 流泪');
  assert.equal(normalizeScenePrompt('   '), '');
  const long = normalizeScenePrompt('啊'.repeat(500), 100);
  assert.ok(long.length <= 100);
});

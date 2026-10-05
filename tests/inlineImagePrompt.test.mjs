import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { zhCN } from '../src/i18n/locales/zh-CN.js';

import {
  buildScenePrompt,
  DEFAULT_INLINE_IMAGE_POSITION,
  INLINE_IMAGE_POSITIONS,
  normalizeImagePosition,
  normalizeScenePrompt,
  selectReplySegment,
  splitReplyParagraphs,
} from '../src/imageGen/inlineImagePrompt.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SESSION_MESSAGES_SOURCE = readFileSync(path.join(HERE, '..', 'src', 'chat', 'useSessionMessages.js'), 'utf8');
const CHAT_SEND_SOURCE = readFileSync(path.join(HERE, '..', 'src', 'chat', 'useChatSend.js'), 'utf8');
const MESSAGE_LIST_SOURCE = readFileSync(path.join(HERE, '..', 'src', 'chat', 'MessageList.js'), 'utf8');

test('配图挂载到替换后的文字消息 id，而非 pending 占位符 id', () => {
  // 回归：pending 占位符会被 replyParts 替换、id 改变；继续用 pendingAssistantMessage.id
  // 调 generateInlineImage 会永久匹配失败（图静默不出现）。
  assert.equal(
    CHAT_SEND_SOURCE.includes('generateInlineImageRef.current?.(pendingAssistantMessage.id'),
    false,
    '不得再用 pending id 调配图'
  );
  const call = CHAT_SEND_SOURCE.match(/generateInlineImageRef\.current\?\.\(([^)]*)\)/);
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

test('有背景图时空会话不再叠加「开始聊天」引导块', () => {
  // 背景图（bgUri）之上再压一段「开始聊天/当前角色/请先填写 API」会显得像第二层背景。
  // 现在空状态按 bgUri 分支：有背景时只留「选择开场白」入口，无背景时才显示完整引导块。
  const start = MESSAGE_LIST_SOURCE.indexOf('messages.length === 0 ? (');
  const end = MESSAGE_LIST_SOURCE.indexOf('visibleMessages.map', start);
  assert.ok(start > 0 && end > start, '未找到空状态渲染块');
  const block = MESSAGE_LIST_SOURCE.slice(start, end);
  assert.ok(block.includes('bgUri ? ('), '空状态应按 bgUri 分支');
  const bgBranchStart = block.indexOf('bgUri ? (');
  const emptyTitleAt = block.indexOf('emptyTitle');
  const apiHintAt = block.indexOf("t('chat.list.hintApiKey')");
  const greetingAt = block.indexOf("t('chat.list.chooseGreeting')");
  assert.ok(emptyTitleAt > 0 && apiHintAt > 0 && greetingAt > 0, '块内应同时存在引导与入口');
  // 引导文案（标题/API 提示）必须都排在「选择开场白」之后的主分支里，
  // 即位于有背景分支之外——有背景分支内只允许出现「选择开场白」这一个入口。
  assert.ok(greetingAt < emptyTitleAt, '有背景分支的选择开场白入口应在引导标题之前');
  assert.ok(greetingAt < apiHintAt, '有背景分支的选择开场白入口应在 API 引导之前');
  // 有背景分支（bgUri 到第一个选择开场白入口）内不得出现引导标题
  const bgBranch = block.slice(bgBranchStart, greetingAt);
  assert.equal(bgBranch.includes('emptyTitle'), false, '有背景分支不得含引导标题');
  assert.equal(bgBranch.includes("t('chat.list.hintApiKey')"), false, '有背景分支不得含 API 引导');
  assert.ok(zhCN['chat.list.hintApiKey'].includes('请先在“设置”里填写'), '语言包中文值正确');
  assert.equal(zhCN['chat.list.chooseGreeting'], '选择开场白', '语言包中文值正确');
});

test('默认角色空会话首次进入自动显示教学开场白（仅内置角色、仅一次）', () => {
  // 仅内置默认角色、仅空会话、且从未自动展示过时才注入。（已外提至 useSessionMessages）
  const autoStart = SESSION_MESSAGES_SOURCE.indexOf('默认角色（内置助手）的空会话');
  // 取自动展示分支的固定窗口：从注释/条件判断到该分支结束（含打标记与 return）
  const block = SESSION_MESSAGES_SOURCE.slice(autoStart, autoStart + 1200);
  assert.ok(block, '未找到默认角色自动开场白分支');
  assert.ok(block.includes('hasShownDefaultGreeting'), '应检查是否已展示过');
  assert.ok(block.includes('markDefaultGreetingShown'), '展示后应打标记');
  assert.ok(block.includes('buildGreetingMessage'), '应构造开场白消息');
  assert.ok(block.includes('setSessionGreetingSelected'), '应标记会话已选择开场白');
  assert.ok(block.includes('initial.length === 0'), '应仅在空会话时触发');
  assert.ok(block.includes('!sessionOwnerMissing'), '角色资料缺失时不得注入');
});

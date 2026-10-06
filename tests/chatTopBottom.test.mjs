// 聊天页顶栏/底栏排版收敛（指令书 2026-10-05）接线与守卫测试。
// 用户裁决：免责声明常驻不动（Phase 1.1 明确否决）；本文件不为其写任何用例。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { shouldOpenMentionAtCursor } from '../src/chat/groupMentions.js';

function readSource(relativePath) {
  return fs.readFileSync(path.resolve(relativePath), 'utf8');
}

const TOP_BAR = readSource('src/chat/ChatTopBar.js');
const COMPOSER = readSource('src/chat/ChatComposer.js');
const MORE_MENU = readSource('src/chat/MoreMenuModal.js');
const VOICE_MODAL = readSource('src/chat/VoiceSettingsModal.js');
const CONTEXT_BAR = readSource('src/chat/ContextBar.js');
const CHAT_SCREEN = readSource('src/ChatScreen.js');
const STYLES = readSource('src/chat/chatStyles.js');

test('顶栏常规态只剩 角色chip + ⋯（新对话/广播已迁出）', () => {
  assert.ok(!TOP_BAR.includes('onNewChat'), '顶栏不得再渲染新对话按钮');
  assert.ok(!TOP_BAR.includes('onToggleBroadcast'), '顶栏不得再渲染广播按钮');
  assert.ok(!TOP_BAR.includes('autoBroadcast'), '广播状态不再进顶栏');
  assert.ok(TOP_BAR.includes('styles.characterChip'), '角色 chip 保留');
  assert.ok(TOP_BAR.includes('styles.characterCaret'), '角色 chip 下拉箭头保留');
  // 多选态完全不动
  assert.ok(TOP_BAR.includes('chat.topBar.selection.delete'), '多选态保留');
});

test('ChatScreen 接线：新对话进菜单（红色 + 确认），广播进语音设置', () => {
  assert.ok(CHAT_SCREEN.includes("key: 'new-chat'"), '菜单有新对话入口');
  assert.ok(CHAT_SCREEN.includes('danger: true'), '破坏性操作标红');
  assert.match(CHAT_SCREEN, /onPress: onNewChatFromMenu/, '菜单入口走确认处理器');
  assert.match(CHAT_SCREEN, /isGroupRef\.current\) \{\s*onNewChat\(\);/, '群聊直接走其内部确认');
  assert.ok(CHAT_SCREEN.includes('autoBroadcast={ttsSettings.autoBroadcast}'), '广播值进语音设置');
  assert.ok(CHAT_SCREEN.includes('onToggleBroadcast={toggleBroadcast}'), '广播开关回调进语音设置');
  // 顶栏调用点不再传这三个（截取 <ChatTopBar…/> 块内判断，避免误伤语音弹层调用点）
  const topBarCall = CHAT_SCREEN.slice(CHAT_SCREEN.indexOf('<ChatTopBar'), CHAT_SCREEN.indexOf('/>', CHAT_SCREEN.indexOf('<ChatTopBar')) + 2);
  assert.ok(topBarCall.length > 0 && !topBarCall.includes('onNewChat'), '顶栏不再接新对话');
  assert.ok(!topBarCall.includes('autoBroadcast') && !topBarCall.includes('onToggleBroadcast'), '顶栏不再接广播');
});

test('语音设置弹层：广播开关迁入（保留全语音模式与转写入口）', () => {
  assert.ok(VOICE_MODAL.includes("t('chat.voice.broadcast.label')"), '广播行存在');
  assert.ok(VOICE_MODAL.includes('onValueChange={onToggleBroadcast}'), '广播开关接回调');
  assert.ok(VOICE_MODAL.includes('onToggleVoiceMode'), '全语音模式保留');
  assert.ok(VOICE_MODAL.includes('onOpenTranscription'), '转写入口保留');
});

test('输入区：@ 与全屏按钮移除，自动提及与长按接线', () => {
  assert.ok(!COMPOSER.includes('a11y.mention'), '提及按钮已移除');
  assert.ok(!COMPOSER.includes('MENTION_PREFIX'), 'Composer 不再依赖提及前缀常量');
  assert.ok(!COMPOSER.includes('fullScreenButton'), '全屏按钮已移除');
  assert.ok(COMPOSER.includes('onLongPress'), '输入框长按开全屏');
  assert.ok(COMPOSER.includes('if (!fullScreenDisabled) onOpenFullScreen()'), '长按遵守禁用条件');
  assert.match(CHAT_SCREEN, /shouldOpenMentionAtCursor\(\{ text: input, cursor, isGroup: isGroupRef\.current \}\)/, '光标检测接线');
  assert.ok(CHAT_SCREEN.includes('setMentionPickerOpen(true)'), '命中即弹提及面板');
});

test('shouldOpenMentionAtCursor：光标前紧邻 @ 且仅群聊触发', () => {
  assert.equal(shouldOpenMentionAtCursor({ text: 'hello@', cursor: 6, isGroup: true }), true);
  assert.equal(shouldOpenMentionAtCursor({ text: 'hello@', cursor: 6, isGroup: false }), false, '单聊不触发');
  assert.equal(shouldOpenMentionAtCursor({ text: 'hello@', cursor: 5, isGroup: true }), false, '光标不在 @ 后不触发');
  assert.equal(shouldOpenMentionAtCursor({ text: 'hello', cursor: 5, isGroup: true }), false);
  assert.equal(shouldOpenMentionAtCursor({ text: '', cursor: 0, isGroup: true }), false);
  assert.equal(shouldOpenMentionAtCursor({ text: '@', cursor: 1, isGroup: true }), true, '单独一个 @ 即触发');
});

test('三条件条统一为 ContextBar，附件条横向滚动', () => {
  const uses = (COMPOSER.match(/<ContextBar/g) || []).length;
  assert.equal(uses, 3, '引用/附件/录音三条全部走 ContextBar');
  assert.ok(COMPOSER.includes('horizontal showsHorizontalScrollIndicator={false}'), '附件条横向滚动');
  assert.ok(CONTEXT_BAR.includes('styles.contextBar'), 'ContextBar 用统一容器样式');
  assert.ok(CONTEXT_BAR.includes("typeof onAction === 'function'"), '动作位可选（附件条无整组动作）');
  // 旧三条容器样式已退役
  for (const dead of ['attachmentBar:', 'voiceRecordingBar:', 'quoteBar:']) {
    assert.ok(!STYLES.includes(dead), `旧样式 ${dead} 应已退役`);
  }
  assert.ok(STYLES.includes('contextBar:') && STYLES.includes('contextBarBody:'), '统一样式在位');
  // 废弃的按钮样式一并退役
  assert.ok(!STYLES.includes('mentionButtonText:'), '提及按钮样式退役');
  assert.ok(!STYLES.includes('fullScreenButton:'), '全屏按钮样式退役');
});

test('⋯ 菜单分组：会话 / 角色与模型 / 其他，编辑角色一等公民', () => {
  assert.ok(MORE_MENU.includes('item.section'), '菜单支持分组字段');
  assert.ok(MORE_MENU.includes('moreSectionTitle'), '分组标题样式');
  // 钉住切换判定本身：只查 item.section 存在会被「删除判定逻辑」骗过（注入验证抓出）。
  assert.ok(
    MORE_MENU.includes('items[index - 1].section !== item.section'),
    '分组标题只在段落切换处渲染'
  );
  for (const key of ["key: 'new-chat'", "key: 'search'", "key: 'summary'", "key: 'scrubber'", "key: 'fullscreen'"]) {
    assert.ok(CHAT_SCREEN.includes(key), `菜单有 ${key}`);
  }
  assert.ok(CHAT_SCREEN.includes("section: t('chat.menu.section.chat')"), '会话分组');
  assert.ok(CHAT_SCREEN.includes("section: t('chat.menu.section.roleModel')"), '角色与模型分组');
  assert.ok(CHAT_SCREEN.includes("section: t('chat.menu.section.other')"), '其他分组');
  assert.ok(CHAT_SCREEN.includes("key: 'edit-role'"), '编辑角色提为菜单一等公民');
  assert.ok(CHAT_SCREEN.includes("label: isGroup ? t('chat.editGroup') : t('chat.editCharacter')"), '按会话类型出对应文案');
});

test('免责声明常驻不动（用户裁决：Phase 1.1 否决，钉死防回归）', () => {
  assert.ok(CHAT_SCREEN.includes('styles.aiNoticeBar'), '免责条保留在顶栏');
  assert.ok(CHAT_SCREEN.includes('AI_DISCLAIMER_TEXT'), '免责文案常量保留');
  assert.ok(!CHAT_SCREEN.includes('disclaimerDismissed'), '不得引入一次性消失开关');
});

test('退役键双 locale 已清理，新键双语齐备', async () => {
  const { zhCN } = await import('../src/i18n/locales/zh-CN.js');
  const { en } = await import('../src/i18n/locales/en.js');
  for (const dead of [
    'chat.topBar.broadcast.on', 'chat.topBar.broadcast.off',
    'chat.topBar.a11y.broadcastOn', 'chat.topBar.a11y.broadcastOff',
    'chat.topBar.a11y.newChat',
    'chat.composer.a11y.mention', 'chat.composer.a11y.fullScreen',
  ]) {
    assert.equal(dead in zhCN, false, `zh 仍残留 ${dead}`);
    assert.equal(dead in en, false, `en 仍残留 ${dead}`);
  }
  for (const key of ['chat.voice.broadcast.label', 'chat.voice.broadcast.hint']) {
    assert.ok(zhCN[key] && en[key], `双语缺 ${key}`);
  }
});

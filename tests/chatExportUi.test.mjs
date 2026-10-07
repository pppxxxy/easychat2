// 对话导出 UI 接线结构守卫。项目无 React 渲染器，按既有约定用源码锚点验证。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = rel => readFileSync(path.join(HERE, '..', rel), 'utf8');

const CHAT_SCREEN = read('src/ChatScreen.js');
const MODAL = read('src/chat/ConversationExportModal.js');
const CARD = read('src/chat/ShareCard.js');
const ZH = read('src/i18n/locales/zh-CN/chat.js');
const EN = read('src/i18n/locales/en/chat.js');

test('聊天页「⋯」菜单有导出入口并打开导出面板', () => {
  assert.ok(CHAT_SCREEN.includes("import ConversationExportModal from './chat/ConversationExportModal.js';"));
  assert.ok(CHAT_SCREEN.includes("key: 'export'"));
  assert.ok(CHAT_SCREEN.includes("label: t('chat.menu.export')"));
  assert.ok(CHAT_SCREEN.includes('onPress: () => setExportOpen(true)'));
  assert.ok(CHAT_SCREEN.includes('<ConversationExportModal'));
  assert.ok(CHAT_SCREEN.includes('visible={exportOpen}'));
  assert.ok(CHAT_SCREEN.includes('messages={messages}'));
});

test('导出面板：三种格式 + 长图截图 + 文本写出 + 分享', () => {
  assert.ok(MODAL.includes("const FORMATS = ['image', 'markdown', 'html'];"));
  assert.ok(MODAL.includes('captureRef(scrollRef'), '长图用 view-shot 截图');
  assert.ok(MODAL.includes('snapshotContentContainer: true'), '截取整段内容');
  assert.ok(MODAL.includes('persistChatExportImage('), '截图落盘走存储封装');
  assert.ok(MODAL.includes('writeChatExportText('), '文本落盘走存储封装');
  assert.ok(MODAL.includes('Sharing.shareAsync('), '经系统分享面板');
  assert.ok(MODAL.includes('collectExportMessages(messages)'));
  assert.ok(MODAL.includes('buildExportEntries('));
  assert.ok(MODAL.includes("toMarkdown(meta.entries, meta.header)"));
  assert.ok(MODAL.includes("toHtml(meta.entries, meta.header)"));
});

test('ShareCard：标题头 + 用户/角色气泡', () => {
  assert.ok(CARD.includes('shareCardBubbleUser'));
  assert.ok(CARD.includes('shareCardBubbleAssistant'));
  assert.ok(CARD.includes('entry.role === \'user\''));
  assert.ok(CARD.includes('info.truncated'));
});

test('导出词条中英齐备', () => {
  const keys = [
    'chat.menu.export',
    'chat.export.title',
    'chat.export.defaultTitle',
    'chat.export.format.image',
    'chat.export.format.markdown',
    'chat.export.format.html',
    'chat.export.shareImage',
    'chat.export.shareText',
    'chat.export.failed.title',
    'chat.export.empty',
    'chat.export.meta',
    'chat.export.truncated',
  ];
  keys.forEach(key => {
    assert.ok(ZH.includes(`'${key}'`), `zh-CN 缺 ${key}`);
    assert.ok(EN.includes(`'${key}'`), `en 缺 ${key}`);
  });
});

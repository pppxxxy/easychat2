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
const STYLES = read('src/chat/exportStyles.js');
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

test('长图预览：卡片按预览区实测宽度渲染，不再写死 360 被两侧裁掉', () => {
  // 卡片宽度由调用方传入（预览区 onLayout 实测），预览与导出的长图同宽
  assert.ok(CARD.includes('width }'), 'ShareCard 应接受 width prop');
  assert.ok(CARD.includes('styles.shareCard, widthStyle'), 'width 应覆盖兜底样式');
  assert.ok(MODAL.includes('onLayout='), '预览区应实测宽度');
  assert.ok(MODAL.includes('setPreviewWidth'), '实测宽度应存进状态');
  assert.ok(MODAL.includes('width={cardWidth}'), '卡片应用实测宽度渲染');
  assert.ok(MODAL.includes('MAX_CARD_WIDTH'), '宽度应夹上限，平板不拉成一条');
  // 兜底样式里仍有宽度，但不再是唯一来源
  assert.ok(STYLES.includes('兜底宽度'), 'exportStyles 应注明 360 只是兜底');
});

test('三种格式都有预览：Markdown 渲染、HTML 内嵌 WebView、缺组件时退回提示', () => {
  // Markdown：真的渲染，而不是只给一行说明
  assert.ok(MODAL.includes("import Markdown from 'react-native-markdown-display'"), '应引入 Markdown 渲染');
  assert.ok(MODAL.includes('<Markdown style={markdownStyles}>'), '应渲染 Markdown 预览');
  assert.ok(MODAL.includes('clampMarkdownText('), 'Markdown 预览要走长度防护');
  assert.ok(MODAL.includes('createMarkdownStyles('), '复用聊天页的 Markdown 样式');
  // HTML：内嵌 WebView 渲染导出页本身
  assert.ok(MODAL.includes("require('react-native-webview')"), 'WebView 应惰性取（与 DiffView 同款）');
  assert.ok(MODAL.includes('<WebViewComponent'), '应渲染 HTML 预览');
  assert.ok(MODAL.includes('source={{ html: htmlPreview }}'), 'WebView 源应是导出用同一份 HTML');
  assert.ok(MODAL.includes("t('chat.export.preview.webviewMissing')"), '缺 WebView 要有兜底提示');
  // 预览文本与实际导出同源
  assert.ok(MODAL.includes('toMarkdown(meta.entries, meta.header)'));
  assert.ok(MODAL.includes('toHtml(meta.entries, meta.header)'));
  // 预览区高度夹上下限，弹层里放得下
  assert.ok(MODAL.includes('previewHeight'), '应有预览高度');
  assert.ok(MODAL.includes('exportPreviewCaption'), '应有预览说明行（可上下滚动）');
  assert.ok(MODAL.includes("t('chat.export.preview.caption', { count: meta.header.count })"));
});

test('导出弹层不被 Touchable 包住：关闭层铺满整屏、弹层是同级 View', () => {
  // Android 上 WebView 被 Touchable 包住会滚不动，HTML 预览就看不全。
  assert.ok(MODAL.includes('styles.exportBackdrop'), '应使用自带背板');
  assert.ok(MODAL.includes('StyleSheet.absoluteFill'), '关闭层应铺满整屏');
  assert.equal(MODAL.includes('styles.modalBackdrop'), false, '不得复用把弹层包进 Touchable 的通用背板');
  // 弹层是普通 View；限宽/居中走共享的 sheetWidth + box-none 的居中层
  assert.ok(MODAL.includes('style={[styles.exportSheet, styles.sheetWidth]}'), '弹层应复用共享限宽样式');
  assert.equal(/<TouchableOpacity[^>]*styles\.exportSheet/.test(MODAL), false, '弹层不得是 Touchable');
  assert.ok(MODAL.includes('pointerEvents="box-none"'), '居中层要 box-none，否则 padding 环挡住关闭层');
  assert.ok(MODAL.includes('accessibilityViewIsModal'), '弹层要标模态（D 线 a11y 口径）');
  assert.ok(STYLES.includes('exportBackdrop'), 'exportStyles 应有 exportBackdrop');
  assert.ok(STYLES.includes('exportSheetLayer'), 'exportStyles 应有居中/内缩层');
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
    'chat.export.preview.caption',
    'chat.export.preview.webviewMissing',
  ];
  keys.forEach(key => {
    assert.ok(ZH.includes(`'${key}'`), `zh-CN 缺 ${key}`);
    assert.ok(EN.includes(`'${key}'`), `en 缺 ${key}`);
  });
});

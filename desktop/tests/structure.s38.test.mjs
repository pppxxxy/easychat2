// 桌面外壳结构守卫（S38）：逐项核对 12 项「平台差异」时查出的 4 个真缺口。
//
// 背景：矩阵把 12 项标成「平台差异」时，其中 4 项其实是**没做完**被写成了「形态不同」。
// 逐项去读手机实现才分清：
//   · 陪读评论：手机按当前章生成并锚定；桌面 chapterTitle/anchor 写死为空 → 真缺口。
//   · 画面识别来源：共享 hook 一直支持 main/ocr 两种，桌面缺切换入口 → 用户改不了。
//   · 图片「保存到相册」：桌面没有相册，但系统另存为是等价物 → 可移植，不是缺失。
//   · 聊天菜单「公告」：手机有入口，桌面只有设置→关于 → 可移植。
//   · 记忆页「展开/折叠全部」：手机 ⋯ 菜单第三项，桌面缺 → 可移植。
// 这五项现在都补上了；本文件钉住「补上之后别再退回去」。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(HERE, '..');
const ROOT = path.resolve(DESKTOP, '..');
const read = (...parts) => readFileSync(path.join(DESKTOP, ...parts), 'utf8');
const readRoot = (...parts) => readFileSync(path.join(ROOT, ...parts), 'utf8');

test('陪读评论：锚定到读者当前章，而不是写死第 0 章', () => {
  const reader = read('src', 'extension', 'screens', 'BookReader.jsx');
  assert.ok(reader.includes('onChapterChange'), '阅读器应上报当前章');
  const screen = read('src', 'extension', 'screens', 'BooksScreen.jsx');
  assert.ok(screen.includes('onChapterChange={setReaderChapter}'), '宿主应接住当前章');
  assert.ok(screen.includes('chapterTitle={readerChapter.title}'), '应传给评论面板');
  const panel = read('src', 'extension', 'screens', 'RoleCommentPanel.jsx');
  assert.ok(panel.includes('chapterTitle'), '面板应接受章节标题');
  assert.ok(panel.includes('chapterBlockIndex'), '面板应接受章节块索引');
  // 提示词与落库都不能再是空串/0。
  assert.ok(!/chapterTitle: ''/.test(panel), '提示词不得再写死空章节名');
  assert.ok(/blockIndex: Number\(chapterBlockIndex\)/.test(panel), '锚点应用当前章索引');
});

test('画面识别来源：设置页可切换 main / ocr', () => {
  const card = read('src', 'settings', 'ImageRecognitionCard.jsx');
  assert.ok(card.includes('screenWatchSource'), '应有来源设置项');
  assert.ok(card.includes("'main'") && card.includes("'ocr'"), '两个来源都应可选');
  assert.ok(card.includes('settings.imageRecognition.screenWatch.label'), '应复用手机词条');
  // 共享 hook 确实读这个设置（否则切了也不生效）。
  const shared = readRoot('src', 'screenWatch', 'frameRecognition.js');
  assert.ok(shared.includes('screenWatchSource'), '共享层应读取该设置');
});

test('图片「另存为」：相册的桌面等价物，且源要先进 cache', () => {
  const menu = read('src', 'render', 'MessageActionsMenu.jsx');
  assert.ok(menu.includes('onSaveImage'), '菜单应有另存为项');
  assert.ok(menu.includes('chat.saveImage.dialogTitle'), '应复用手机词条');
  const saver = read('src', 'chat', 'saveImageAs.js');
  assert.ok(saver.includes('backup.saveAs'), '应走系统另存为对话框');
  // 主进程只接受 documents/cache 内的源（安全约束），所以必须先复制。
  assert.ok(/cache\//.test(saver), '源应先复制进 cache');
  assert.ok(/fs\.delete\(tempUri/.test(saver), '临时副本应清理');
  const pane = read('src', 'provider', 'ChatPane.jsx');
  assert.ok(pane.includes('onSaveImage'), '聊天页应传入该回调');
});

test('聊天菜单公告 + 记忆页展开折叠全部', () => {
  const menu = read('src', 'chat', 'ChatMoreMenu.jsx');
  assert.ok(menu.includes('chat.menu.notice'), '更多菜单应有公告');
  assert.ok(menu.includes('onOpenNotice'), '应接公告回调');
  const memory = read('src', 'memory', 'MemoryListScreen.jsx');
  assert.ok(memory.includes('memory.expandAll'), '记忆页应有展开全部');
  assert.ok(memory.includes('memory.collapseAll'), '记忆页应有折叠全部');
});

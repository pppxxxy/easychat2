// 桌面外壳结构守卫（S23）：第四轮页内比对 —— 书籍阅读器、消息操作、角色详情、记忆面板。
//
// 本轮查出的都是「整块功能缺失」或「数据安全差异」，不是措辞差异：
//   1. 书籍只有整本滚动，没有分章（共享层 blocks.js 早就提供了切章纯函数）；
//   2. 消息图片不能「存为表情包」（桌面已有完整的表情包处理链路，只缺入口）；
//   3. 角色编辑保存**没有并发冲突检测**（手机有 CHARACTER_CONFLICT），
//      两处同时编辑时后保存的会静默覆盖前者；
//   4. 记忆页删除会话**没有「连带删除关联动态」**选项，直接删会留下孤儿动态。
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

const BOOK_READER = read('src', 'extension', 'screens', 'BookReader.jsx');
const BOOKS = read('src', 'extension', 'screens', 'BooksScreen.jsx');
const ACTIONS = read('src', 'render', 'MessageActionsMenu.jsx');
const PANE = read('src', 'provider', 'ChatPane.jsx');
const STICKERS = read('src', 'stickers', 'useDesktopStickers.js');
const EDIT = read('src', 'character', 'CharacterEditScreen.jsx');
const MEMORY = read('src', 'memory', 'MemoryListScreen.jsx');

test('书籍：分章走共享 blocks（切块 + 目录），不自己写切章规则', () => {
  assert.ok(BOOK_READER.includes('splitBookIntoBlocks'), '未复用共享切块');
  assert.ok(BOOK_READER.includes('buildChapterList'), '未复用共享目录构造');
  assert.ok(BOOKS.includes('BookReader'), '书籍页未挂分章阅读器');
  // 进度口径必须与手机同一函数（否则同一本书两端百分比不同）。
  assert.ok(BOOK_READER.includes('computeChapterPercent'), '未复用共享进度计算');
  assert.ok(BOOK_READER.includes('normalizeChapterProgress'), '未复用共享进度归一');
  assert.ok(BOOK_READER.includes('saveBookProgress'), '进度未写回共享存储');
  // computeChapterPercent 的 chapterEntries 必须是章节数组：传数字会返回 null，
  // 进度就永远不落盘（本轮真实踩过的坑）。
  assert.ok(/chapterEntries:\s*chapters/.test(BOOK_READER), 'chapterEntries 应为章节数组');
  // 没有可识别章节时要如实告知，而不是显示空白。
  assert.ok(BOOK_READER.includes('books.reader.noChapters.body'), '缺「无可识别章节」提示');
});

test('书籍：角色评论仍在（本轮误判过，留痕防重复实现）', () => {
  assert.ok(BOOKS.includes('RoleCommentPanel'), '书籍角色评论不应丢失');
  // 评论落库走共享 books/comments（损坏保护 + 串行队列）。
  const panel = read('src', 'extension', 'screens', 'RoleCommentPanel.jsx');
  assert.ok(panel.includes('appendBookComment'), '书籍评论未走共享落库');
  assert.ok(panel.includes('getBookComments'), '书籍评论未走共享读取');
});

test('消息图片：可「存为表情包」，且复用既有处理链路', () => {
  assert.ok(ACTIONS.includes('chat.bubble.saveAsSticker'), '缺存为表情包入口');
  // 已经是表情包的图不再提供（与手机同判据）。
  assert.ok(/!\(message\.image && message\.image\.stickerId\)/.test(ACTIONS),
    '表情包消息不应重复提供「存为表情包」');
  // 处理（缩放/压缩/落盘/媒体保护）必须复用已有函数，不另写一份。
  assert.ok(STICKERS.includes('prepareFromUri'), '缺可复用的图片处理入口');
  assert.ok(STICKERS.includes('createStickerJpeg'), '应复用共享缩放/压缩口径');
  assert.ok(PANE.includes('prepareFromUri'), '聊天页未把消息图片接到处理链路');
});

test('角色编辑：保存前做并发冲突检测（手机 CHARACTER_CONFLICT 同款）', () => {
  assert.ok(EDIT.includes('characterFormSignature'), '缺表单签名比对');
  assert.ok(EDIT.includes('CHARACTER_CONFLICT'), '缺冲突错误码');
  assert.ok(EDIT.includes('character.detail.conflict.title'), '缺冲突提示');
  // 必须是「落库那一刻」再比一次：函数式 patch 让校验与写入在同一次加锁里发生。
  assert.ok(/guarded\.id = character\.id/.test(EDIT), '函数式 patch 必须带 id（updateCharacter 据此定位）');
  // 共享层确实支持函数式 patch（否则这条保护是空的）。
  const lib = readRoot('src', 'context', 'characterLibrary.js');
  assert.ok(/typeof patch === 'function'/.test(lib), 'updateCharacter 应支持函数式 patch');
});

test('记忆页：删除会话可选「连带删除关联动态」（避免孤儿动态）', () => {
  assert.ok(MEMORY.includes('countMomentsBySessionIds'), '缺关联动态计数');
  assert.ok(MEMORY.includes('deleteMomentsBySessionIds'), '缺动态删除');
  assert.ok(MEMORY.includes('memory.deleteMemory.onlyMemory'), '缺「只删对话」选项');
  assert.ok(MEMORY.includes('memory.deleteMemory.deleteAll'), '缺「一起删除」选项');
  // 批量删除同样处理。
  assert.ok(MEMORY.includes('memory.deleteBatch.bodyLinked'), '批量删除缺关联计数文案');
  // 先删动态再删会话；动态删失败要明确告知（不能只说「删除失败」）。
  assert.ok(MEMORY.includes('memory.delete.momentsDeletedFail.body'), '单个删除缺「动态已删」告知');
  assert.ok(MEMORY.includes('memory.delete.momentsDeletedFailBatch.body'), '批量删除缺告知');
  // 读不出动态时必须中止（否则在未知状态下删会话）。
  assert.ok(/moments\.readFail/.test(MEMORY), '动态读取失败应中止删除');
});

test('记忆页其余能力：克隆/体检/孤儿回收/全局搜索都已在', () => {
  for (const marker of ['memory.clone.title', 'MemoryCheckupPanel', 'OrphanRecoveryPanel', 'GlobalSearchPanel']) {
    assert.ok(MEMORY.includes(marker), `记忆页缺 ${marker}`);
  }
});
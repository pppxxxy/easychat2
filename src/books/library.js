// 书架存储领域：「索引 + 单条分键」（与音乐库同一惯例）。
// 书正文是超大文本，**恒走文件** documentDirectory/books/<id>.txt（沿用角色大字段
// 的落文件惯例，不走 AsyncStorage 内联）；条目记录 uri 与元数据、阅读进度与目录。
// 段落陪伴评论按书分键，见 ./comments.js。

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';

import { backupCorruptValue, createMutationQueue, readJsonStatus } from '../storage/io.js';
import { mergeChapterProgress, normalizeChapterProgress } from './chapterProgress.js';
import { tActive } from '../i18n/index.js';

export const BOOKS_INDEX_KEY = '@easychat2_books_index';
export const BOOK_ITEM_PREFIX = '@easychat2_books_item';
export const BOOKS_DIR_NAME = 'books';

const booksMutation = createMutationQueue();

export function bookItemKey(id) {
  return `${BOOK_ITEM_PREFIX}::${String(id || '')}`;
}

export function booksDirectory(documentDirectory = null) {
  const base = documentDirectory === null ? FileSystem.documentDirectory : documentDirectory;
  return `${base || ''}${BOOKS_DIR_NAME}/`;
}

const MAX_CHAPTERS = 2000;

function normalizeChapters(list) {
  const seen = new Set();
  const result = [];
  (Array.isArray(list) ? list : []).forEach(chapter => {
    const source = chapter && typeof chapter === 'object' ? chapter : {};
    const title = String(source.title || '').trim().slice(0, 60);
    const blockIndex = Math.max(0, Math.floor(Number(source.blockIndex)) || 0);
    if (!title || seen.has(title)) return;
    seen.add(title);
    result.push({ title, blockIndex });
    if (result.length >= MAX_CHAPTERS) return result;
  });
  return result;
}

function normalizeProgress(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    blockIndex: Math.max(0, Math.floor(Number(source.blockIndex)) || 0),
    pageIndex: Math.max(0, Math.floor(Number(source.pageIndex)) || 0),
    anchorText: String(source.anchorText || '').slice(0, 60),
  };
}

export function normalizeBookItem(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    id: String(source.id || ''),
    name: String(source.name || '').trim(),
    uri: String(source.uri || ''),
    // size 字节数（导入时事实）；chars 全文字符数（导入时统计，供展示与分块预估）。
    size: Math.max(0, Math.floor(Number(source.size)) || 0),
    chars: Math.max(0, Math.floor(Number(source.chars)) || 0),
    addedAt: Math.floor(Number(source.addedAt)) || 0,
    // 导入时探测到的源编码（utf-8/gb18030/big5/utf-16le/docx 等），仅供排查展示。
    encoding: String(source.encoding || '').trim(),
    // 源格式（txt/md/markdown/docx/html），决定阅读器是否走 Markdown 渲染；旧条目为空。
    format: String(source.format || '').trim().toLowerCase(),
    progress: normalizeProgress(source.progress),
    // 按章阅读进度（chapterIndex → 0-100 取整）：只有真的读到的章才有值，
    // 其余视为未读。旧数据无该字段迁移为 {}，且不从旧位置反推历史章进度。
    chapterProgress: normalizeChapterProgress(source.chapterProgress),
    chapters: normalizeChapters(source.chapters),
  };
}

function normalizeBookItemList(list) {
  const seen = new Set();
  const result = [];
  (Array.isArray(list) ? list : []).forEach(item => {
    const normalized = normalizeBookItem(item);
    if (!normalized.id || !normalized.name || !normalized.uri) return;
    if (seen.has(normalized.id)) return;
    seen.add(normalized.id);
    result.push(normalized);
  });
  return result;
}

async function readBooksIndexStatus() {
  const stored = await readJsonStatus(BOOKS_INDEX_KEY);
  if (stored.status === 'corrupt' || (stored.status === 'ok' && !Array.isArray(stored.value))) {
    await backupCorruptValue(BOOKS_INDEX_KEY);
    return { status: 'corrupt', ids: [] };
  }
  if (stored.status === 'missing') return { status: 'missing', ids: [] };
  return {
    status: 'ok',
    ids: [...new Set((stored.value || []).map(id => String(id || '')).filter(Boolean))],
  };
}

async function readBookCollectionStatus() {
  const index = await readBooksIndexStatus();
  if (index.status !== 'ok') return { status: index.status, items: [] };
  const items = [];
  for (const id of index.ids) {
    const stored = await readJsonStatus(bookItemKey(id));
    if (stored.status === 'missing' || stored.status === 'corrupt'
      || !stored.value || typeof stored.value !== 'object' || Array.isArray(stored.value)) {
      await backupCorruptValue(bookItemKey(id));
      return { status: 'corrupt', items: [] };
    }
    const normalized = normalizeBookItem(stored.value);
    if (!normalized.id || !normalized.name || !normalized.uri) {
      await backupCorruptValue(bookItemKey(id));
      return { status: 'corrupt', items: [] };
    }
    items.push(normalized);
  }
  return { status: 'ok', items };
}

async function writeBookCollection(items) {
  const list = normalizeBookItemList(items);
  const ids = list.map(item => item.id);
  if (list.length > 0) {
    await AsyncStorage.multiSet(list.map(item => [bookItemKey(item.id), JSON.stringify(item)]));
  }
  await AsyncStorage.setItem(BOOKS_INDEX_KEY, JSON.stringify(ids));
  try {
    const keys = await AsyncStorage.getAllKeys();
    const activeIds = new Set(ids);
    const staleKeys = keys.filter(key => (
      String(key).startsWith(`${BOOK_ITEM_PREFIX}::`)
      && !activeIds.has(String(key).slice(`${BOOK_ITEM_PREFIX}::`.length))
    ));
    if (staleKeys.length > 0) await AsyncStorage.multiRemove(staleKeys);
  } catch (error) {}
}

export function getBooks() {
  return booksMutation.enqueue(async () => {
    const result = await readBookCollectionStatus();
    if (result.status === 'corrupt') throw new Error(tActive('error.books.shelfReadFailed'));
    return result.items;
  });
}

export function saveBookItem(item) {
  return booksMutation.enqueue(async () => {
    const normalized = normalizeBookItem(item);
    if (!normalized.id || !normalized.name || !normalized.uri) {
      throw new Error(tActive('error.books.infoIncomplete'));
    }
    const result = await readBookCollectionStatus();
    if (result.status === 'corrupt') throw new Error(tActive('error.books.shelfReadFailed'));
    const exists = result.items.some(entry => entry.id === normalized.id);
    await writeBookCollection(
      exists
        ? result.items.map(entry => (entry.id === normalized.id ? normalized : entry))
        : [normalized, ...result.items]
    );
    return normalized;
  });
}

// 进度只存 { blockIndex, pageIndex, anchorText }：字号/主题变化会改变总页数，
// 百分比是显示期计算值，不持久化。
// chapterProgressPatch（可选）：按章进度补丁，与已存映射合并（同章取历史最大，
// 不回退）。progress 传 null 时不动阅读位置、只合并补丁。
export function saveBookProgress(id, progress, chapterProgressPatch = null) {
  return booksMutation.enqueue(async () => {
    const targetId = String(id || '');
    if (!targetId) throw new Error(tActive('error.books.infoIncomplete'));
    const result = await readBookCollectionStatus();
    if (result.status === 'corrupt') throw new Error(tActive('error.books.shelfReadFailed'));
    const target = result.items.find(entry => entry.id === targetId);
    if (!target) return null;
    const updated = normalizeBookItem({
      ...target,
      ...(progress ? { progress } : {}),
      chapterProgress: chapterProgressPatch
        ? mergeChapterProgress(target.chapterProgress, chapterProgressPatch)
        : (target.chapterProgress || {}),
    });
    await writeBookCollection(result.items.map(entry => (entry.id === targetId ? updated : entry)));
    return updated;
  });
}

// 读正文（UTF-8 专用）。编码不是 UTF-8 的文件由导入方在导入时检测并拒绝，
// 这里不做转码（不引入 GBK 表依赖）。
export function readBookContent(item) {
  const uri = item && item.uri;
  if (!uri) return Promise.reject(new Error('书籍文件缺失'));
  return FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.UTF8 });
}

// 批量删除记录，返回被删条目（含 uri）；正文文件与评论键由调用方清理。
export async function deleteBooks(ids) {
  const targetIds = new Set((Array.isArray(ids) ? ids : [ids]).map(id => String(id || '')).filter(Boolean));
  return booksMutation.enqueue(async () => {
    const result = await readBookCollectionStatus();
    if (result.status === 'corrupt') throw new Error(tActive('error.books.shelfReadFailed'));
    if (targetIds.size === 0) return { remaining: result.items, removed: [] };
    const removed = result.items.filter(item => targetIds.has(item.id));
    const remaining = result.items.filter(item => !targetIds.has(item.id));
    await writeBookCollection(remaining);
    return { remaining, removed };
  });
}

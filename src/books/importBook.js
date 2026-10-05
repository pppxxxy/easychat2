// 本地书籍导入：DocumentPicker（SAF）选文件 → 扩展名校验 → 复制到
// documentDirectory/books/<id>.txt → 按格式提取纯文本（多编码自动识别）→
// 以 UTF-8 写回 → 分块建目录 → 落库。
//
// 支持格式与编码见 ./extractText.js、./decodeText.js。零新增权限（SAF 选文件器）；
// type 用 '*/*'：部分厂商文件管理器把文本文件标成 application/octet-stream。

import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';

import { getPickedAsset } from '../character/cardHelpers.js';

import { buildChapterList, splitBookIntoBlocks } from './blocks.js';
import { extractPlainText } from './extractText.js';
import { booksDirectory, saveBookItem } from './library.js';
import { MARKDOWN_FORMATS } from './markdownBook.js';
import { tActive } from '../i18n/index.js';

export { BOOK_EXTENSIONS, isSupportedBookFile } from './extractText.js';

export function makeBookId(now = Date.now()) {
  return `bk-${now}-${Math.random().toString(36).slice(2, 8)}`;
}

export function bookDisplayName(fileName) {
  const name = String(fileName || '').replace(/\.[a-z0-9]{1,8}$/i, '').trim();
  return name || '未命名书籍';
}

// 返回 { canceled: true } 或 { item, blocks }；任何失败都清理半成品文件。
// blocks 随返回值交给阅读器热启动，不落库（分块可由正文确定性重算）。
export async function importBookFromPicker({ now = Date.now() } = {}) {
  const result = await DocumentPicker.getDocumentAsync({
    type: '*/*',
    copyToCacheDirectory: true,
    multiple: false,
  });
  const asset = getPickedAsset(result);
  if (!asset || !asset.uri) return { canceled: true };
  const fileName = String(asset.name || '');

  const id = makeBookId(now);
  const dest = `${booksDirectory()}${id}.txt`;
  await FileSystem.makeDirectoryAsync(booksDirectory(), { intermediates: true });
  try {
    await FileSystem.copyAsync({ from: asset.uri, to: dest });
  } catch (error) {
    await FileSystem.deleteAsync(dest, { idempotent: true }).catch(() => {});
    throw error;
  }
  try {
    // 以 base64 读原始字节，再按格式/编码提取（字节是编码探测与 zip 解包的前提）。
    const base64 = await FileSystem.readAsStringAsync(dest, { encoding: FileSystem.EncodingType.Base64 });
    const bytes = Buffer.from(base64, 'base64');
    const { text, encoding, format } = extractPlainText({ fileName, bytes });
    if (!text || !text.trim()) {
      const error = new Error(tActive('error.books.noImportableText'));
      error.code = 'EMPTY_BOOK';
      throw error;
    }
    await FileSystem.writeAsStringAsync(dest, text);
    const blocks = splitBookIntoBlocks(text, { markdown: MARKDOWN_FORMATS.includes(format) });
    const item = await saveBookItem({
      id,
      name: bookDisplayName(fileName),
      uri: dest,
      size: Math.max(0, Math.floor(Number(asset.size)) || 0),
      chars: text.length,
      addedAt: now,
      chapters: buildChapterList(blocks),
      encoding,
      format,
    });
    return { item, blocks };
  } catch (error) {
    await FileSystem.deleteAsync(dest, { idempotent: true }).catch(() => {});
    throw error;
  }
}

// 本地书籍导入：DocumentPicker（SAF）选文件 → 扩展名校验（.txt/.md/.markdown）→
// 复制到 documentDirectory/books/<id>.txt → 读回检测解码质量（拒绝非 UTF-8）→
// 分块建目录 → 落库。
// 零新增权限（SAF 选文件器）；**type 用 '*/*'**：部分厂商文件管理器把 .txt/.md
// 标成 application/octet-stream，用 text/* 过滤会让书在选文件器里根本选不中，
// 因此选后由扩展名校验兜底。
// 编码 v1 边界：只支持 UTF-8（含 BOM）。GBK/GB18030 是历史遗留重灾区，纯 JS 转码表
// 体积与正确性都不划算；读回的文本里 U+FFFD 比例超阈值即判为解码失败并明确告知用户。

import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';

import { getPickedAsset } from '../character/cardHelpers.js';

import { buildChapterList, splitBookIntoBlocks } from './blocks.js';
import { booksDirectory, saveBookItem } from './library.js';

export function makeBookId(now = Date.now()) {
  return `bk-${now}-${Math.random().toString(36).slice(2, 8)}`;
}

export const BOOK_EXTENSIONS = ['.txt', '.md', '.markdown'];

export function isBookFileName(fileName) {
  const name = String(fileName || '').toLowerCase();
  return BOOK_EXTENSIONS.some(extension => name.endsWith(extension));
}

export function bookDisplayName(fileName) {
  const name = String(fileName || '').replace(/\.[a-z0-9]{1,8}$/i, '').trim();
  return name || '未命名书籍';
}

// 非 UTF-8 文件被强行按 UTF-8 解码时会产生替换符 U+FFFD；正常中文文本里
// 它几乎不该出现，比例超 0.5% 即判定编码不符。
export function looksLikeBrokenDecoding(text, { threshold = 0.005 } = {}) {
  const source = String(text || '');
  if (!source) return false;
  let bad = 0;
  for (let index = 0; index < source.length; index += 1) {
    if (source.charCodeAt(index) === 0xfffd) bad += 1;
  }
  return bad / source.length > threshold;
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
  if (!isBookFileName(fileName)) {
    throw Object.assign(new Error('目前只支持 txt 与 Markdown 文本文件'), { code: 'UNSUPPORTED_FORMAT' });
  }
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
    const content = await FileSystem.readAsStringAsync(dest, { encoding: FileSystem.EncodingType.UTF8 });
    if (looksLikeBrokenDecoding(content)) {
      throw Object.assign(
        new Error('文件不是 UTF-8 编码，请先转存为 UTF-8 再导入（常见于网上下载的 GBK txt）'),
        { code: 'ENCODING' }
      );
    }
    const blocks = splitBookIntoBlocks(content);
    const item = await saveBookItem({
      id,
      name: bookDisplayName(fileName),
      uri: dest,
      size: Math.max(0, Math.floor(Number(asset.size)) || 0),
      chars: content.length,
      addedAt: now,
      chapters: buildChapterList(blocks),
    });
    return { item, blocks };
  } catch (error) {
    await FileSystem.deleteAsync(dest, { idempotent: true }).catch(() => {});
    throw error;
  }
}

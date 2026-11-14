// DOCX 正文提取（主进程）：解 zip 取 word/document.xml，交给共享纯函数抽文本。
//
// 为什么必须在主进程：zip 解压要用 node:zlib 的 inflateRawSync，渲染进程（沙箱 +
// contextIsolation）没有 Node 内置模块。这与仓库既有的分工一致——主进程管字节
// （fs / http / 截图），渲染层管界面。
//
// 安全：只接受渲染层传来的 base64 字节，**不接受任意路径**；解出来的 XML 有大小上限，
// 超限直接拒绝（避免一个超大 docx 把主进程内存吃满）。
import { inflateRawSync } from 'node:zlib';

import { DOCX_DOCUMENT_ENTRY, extractDocxText } from '../../../src/books/docxText.js';

// 单个 docx 的上限与角色卡一致（32MB 原始字节）。
export const MAX_DOCX_BYTES = 32 * 1024 * 1024;
// 解出来的 XML 上限：正文再长也不会到 128MB，超了就是异常文件。
const MAX_XML_BYTES = 128 * 1024 * 1024;

// 在 zip 字节流里找目标条目并解压。
// 用「本地文件头」顺序扫描：每个头以 PK\x03\x04 开头，字段布局固定。
// 只支持 stored(0) 与 deflate(8) 两种压缩方式——DOCX 实际只用这两种。
export function extractZipEntry(buffer, entryName) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 30) return null;
  const target = String(entryName || '');
  if (!target) return null;
  let offset = 0;
  while (offset + 30 <= buffer.length) {
    // 本地文件头签名 PK\x03\x04
    if (buffer.readUInt32LE(offset) !== 0x04034b50) {
      // 不是头就往后找下一个签名（有些文件带前缀数据）。
      const next = buffer.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]), offset + 1);
      if (next < 0) return null;
      offset = next;
      continue;
    }
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > buffer.length) return null;
    const name = buffer.slice(nameStart, nameEnd).toString('utf8');
    const dataStart = nameEnd + extraLength;
    const dataEnd = dataStart + compressedSize;
    if (name === target) {
      if (dataEnd > buffer.length) return null;
      const raw = buffer.slice(dataStart, dataEnd);
      if (method === 0) return raw;
      if (method === 8) return inflateRawSync(raw);
      return null;
    }
    // compressedSize 为 0 时（流式写入的 zip 会把大小放在数据描述符里）无法跳过，
    // 这种情况直接放弃——Word 生成的 docx 都写真实大小。
    if (compressedSize === 0) return null;
    offset = dataEnd;
  }
  return null;
}

export function extractDocxTextFromBuffer(buffer) {
  const xml = extractZipEntry(buffer, DOCX_DOCUMENT_ENTRY);
  if (!xml) return null;
  if (xml.length > MAX_XML_BYTES) return null;
  const text = extractDocxText(xml.toString('utf8'));
  return text && text.trim() ? text : null;
}

export function registerDocxIpc(ipcMain) {
  ipcMain.handle('books:docxText', async (event, payload) => {
    const source = payload && typeof payload === 'object' ? payload : {};
    const base64 = String(source.base64 || '');
    if (!base64) return { ok: false, reason: 'empty' };
    let buffer;
    try {
      buffer = Buffer.from(base64, 'base64');
    } catch (error) {
      return { ok: false, reason: 'bad-base64' };
    }
    if (buffer.length === 0) return { ok: false, reason: 'empty' };
    if (buffer.length > MAX_DOCX_BYTES) return { ok: false, reason: 'too-large' };
    try {
      const text = extractDocxTextFromBuffer(buffer);
      if (!text) return { ok: false, reason: 'no-text' };
      return { ok: true, text };
    } catch (error) {
      return { ok: false, reason: String((error && error.message) || error) };
    }
  });
}

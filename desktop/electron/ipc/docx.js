// DOCX 解包（主进程）：只负责「从 zip 里取出 word/document.xml 的字节」。
//
// 为什么文本抽取不在这里：主进程的打包白名单只含 dist/、electron/、package.json，
// **不含共享层 src/**（渲染层经 vite 打进 dist，主进程从不 require 共享代码）。
// 因此在主进程里 import '../../../src/books/docxText.js' 在打包版会解析失败——
// 这是这轮踩到的真实故障：开发模式（npx electron .）能跑，打包版启动即失败、
// 连 SMOKE_RESULT 都打不出来。
//
// 现在的分层：
//   主进程  zip 解包（需要 node:zlib，渲染层没有）→ 返回 XML 文本
//   渲染层  src/books/docxText.js 的 extractDocxText 抽正文（共享纯函数，可 Node 直测）
// 这样既不用把共享层塞进 asar，也不会出现两份抽取实现。
import { inflateRawSync } from 'node:zlib';

// 单个 docx 的上限与角色卡一致（32MB 原始字节）。
export const MAX_DOCX_BYTES = 32 * 1024 * 1024;
// 解出来的 XML 上限：正文再长也不会到 128MB，超了就是异常文件。
const MAX_XML_BYTES = 128 * 1024 * 1024;
// DOCX 的正文固定在这个条目。
export const DOCX_DOCUMENT_ENTRY = 'word/document.xml';

// 在 zip 字节流里找目标条目并解压。
// 用「本地文件头」顺序扫描：每个头以 PK\x03\x04 开头，字段布局固定。
// 只支持 stored(0) 与 deflate(8) 两种压缩方式——DOCX 实际只用这两种。
export function extractZipEntry(buffer, entryName) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 30) return null;
  const target = String(entryName || '');
  if (!target) return null;
  let offset = 0;
  while (offset + 30 <= buffer.length) {
    if (buffer.readUInt32LE(offset) !== 0x04034b50) {
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
    // compressedSize 为 0 时无法跳过（流式 zip 把大小放数据描述符里），直接放弃。
    if (compressedSize === 0) return null;
    offset = dataEnd;
  }
  return null;
}

export function registerDocxIpc(ipcMain) {
  ipcMain.handle('books:docxXml', async (event, payload) => {
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
      const xml = extractZipEntry(buffer, DOCX_DOCUMENT_ENTRY);
      if (!xml) return { ok: false, reason: 'no-document' };
      if (xml.length > MAX_XML_BYTES) return { ok: false, reason: 'xml-too-large' };
      // 交给渲染层抽文本：共享纯函数 extractDocxText（src/books/docxText.js）。
      return { ok: true, xml: xml.toString('utf8') };
    } catch (error) {
      return { ok: false, reason: String((error && error.message) || error) };
    }
  });
}

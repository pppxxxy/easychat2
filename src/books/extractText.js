// 多格式纯文本提取（纯函数，可 Node 直测）：.txt/.md/.markdown/.docx/.html/.htm。
//
// - 文本格式 → decodeText 编码探测解码；
// - .docx → fflate 解压取 word/document.xml，剥标签、解实体、还原段落；
// - .html/.htm → 解码后去 script/style、块级标签转换行、剥标签、解实体。
// 结果统一为 UTF-8 文本（换行已归一）。

import { strFromU8, unzipSync } from 'fflate';

import { decodeBytes } from './decodeText.js';

export const BOOK_EXTENSIONS = ['.txt', '.md', '.markdown', '.docx', '.html', '.htm'];

const DOCX_DOCUMENT_PATH = 'word/document.xml';

export function fileExtension(fileName) {
  const match = /\.([a-z0-9]+)$/i.exec(String(fileName || '').trim());
  return match ? `.${match[1].toLowerCase()}` : '';
}

export function isSupportedBookFile(fileName) {
  return BOOK_EXTENSIONS.includes(fileExtension(fileName));
}

function unsupported(message) {
  const error = new Error(message);
  error.code = 'UNSUPPORTED_FORMAT';
  return error;
}

// 解码 XML/HTML 命名与数字实体；&amp; 最后解，避免二次解码。
export function decodeEntities(text) {
  const source = String(text || '');
  return source
    .replace(/&#x([0-9a-f]+);/gi, (match, hex) => {
      const code = parseInt(hex, 16);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    })
    .replace(/&#(\d+);/g, (match, dec) => {
      const code = parseInt(dec, 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    })
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&mdash;/gi, '—')
    .replace(/&hellip;/gi, '…')
    .replace(/&amp;/gi, '&');
}

function tidyParagraphs(text) {
  return String(text || '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '');
}

// OOXML：w:tab→\t、w:br→\n、段落 →\n，其余标签剥离，最后解实体。
export function documentXmlToText(xml) {
  let source = String(xml || '');
  source = source.replace(/<\?xml[^>]*\?>/gi, '');
  source = source.replace(/<w:tab\b[^>]*\/>/gi, '\t');
  source = source.replace(/<w:br\b[^>]*\/>/gi, '\n');
  source = source.replace(/<w:p\b[^>]*\/>/gi, '\n'); // 空段落
  source = source.replace(/<\/w:p>/gi, '\n');
  source = source.replace(/<[^>]*>/g, '');
  return tidyParagraphs(decodeEntities(source));
}

export function htmlToText(html) {
  let source = String(html || '');
  source = source.replace(/<!--[\s\S]*?-->/g, '');
  source = source.replace(/<script\b[\s\S]*?<\/script>/gi, '');
  source = source.replace(/<style\b[\s\S]*?<\/style>/gi, '');
  source = source.replace(/<br\s*\/?>/gi, '\n');
  source = source.replace(/<\/(p|div|h[1-6]|li|tr|table|section|article|blockquote|pre)>/gi, '\n');
  source = source.replace(/<[^>]*>/g, '');
  return tidyParagraphs(decodeEntities(source));
}

function extractDocx(bytes) {
  let files;
  try {
    files = unzipSync(bytes);
  } catch (error) {
    throw unsupported('.docx 文件无法解压，请确认文件有效');
  }
  const entry = files[DOCX_DOCUMENT_PATH];
  if (!entry) throw unsupported('.docx 缺少正文（word/document.xml）');
  return documentXmlToText(strFromU8(entry));
}

// 返回 { text, encoding, format }；不支持/解压失败按 code 抛错。
export function extractPlainText({ fileName, bytes } = {}) {
  const extension = fileExtension(fileName);
  if (!BOOK_EXTENSIONS.includes(extension)) {
    throw unsupported('目前只支持 txt / Markdown / Word(.docx) / HTML 文本文件');
  }
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);

  if (extension === '.docx') {
    return { text: extractDocx(data), encoding: 'docx', format: 'docx' };
  }

  const decoded = decodeBytes(data);
  const text = extension === '.html' || extension === '.htm' ? htmlToText(decoded.text) : decoded.text;
  return { text, encoding: decoded.encoding, format: extension.slice(1) };
}

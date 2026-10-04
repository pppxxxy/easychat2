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

// word/document.xml 解压后的字节上限。docx 是用户任选的外部文件，解压前无从知道真实
// 大小；不封顶的话，一个压缩比极高的包（zip「炸弹」形态）就能把内存吃光。
export const DOCX_INFLATE_LIMIT_BYTES = 32 * 1024 * 1024;

function docxTooLarge() {
  const error = new Error('.docx 正文超过解压上限');
  error.code = 'DOCX_TOO_LARGE';
  return error;
}

// 只取正文条目，且两步都不碰无关数据：
// 1) 先按 zip 目录元数据判断声明大小（filter 全假 → 只读目录，不解压任何条目）——
//    包里另有大文件时，不会因为它去 inflate；
// 2) 再只解压正文这一条，并按实际解出的长度复核（目录里声明的大小可以伪造）。
// 正文条目不存在返回 null（由调用方转成「缺少正文」）。
function extractDocxDocument(bytes, inflateLimit) {
  const bounded = Number.isFinite(inflateLimit) && inflateLimit > 0;
  const declared = [];
  unzipSync(bytes, {
    filter: file => {
      declared.push(file);
      return false;
    },
  });
  const target = declared.find(file => file.name === DOCX_DOCUMENT_PATH);
  if (!target) return null;
  if (bounded && target.originalSize > inflateLimit) throw docxTooLarge();

  const extracted = unzipSync(bytes, { filter: file => file.name === DOCX_DOCUMENT_PATH });
  const entry = extracted[DOCX_DOCUMENT_PATH];
  if (!entry) return null;
  if (bounded && entry.length > inflateLimit) throw docxTooLarge();
  return entry;
}

function extractDocx(bytes, inflateLimit = DOCX_INFLATE_LIMIT_BYTES) {
  let entry;
  try {
    entry = extractDocxDocument(bytes, inflateLimit);
  } catch (error) {
    if (error && error.code === 'DOCX_TOO_LARGE') throw error;
    throw unsupported('.docx 文件无法解压，请确认文件有效');
  }
  if (!entry) throw unsupported('.docx 缺少正文（word/document.xml）');
  return documentXmlToText(strFromU8(entry));
}

// 返回 { text, encoding, format }；不支持/解压失败按 code 抛错。
// `docxInflateLimitBytes` 仅测试/特殊场景需要收窄，默认见 DOCX_INFLATE_LIMIT_BYTES。
export function extractPlainText({ fileName, bytes, docxInflateLimitBytes } = {}) {
  const extension = fileExtension(fileName);
  if (!BOOK_EXTENSIONS.includes(extension)) {
    throw unsupported('目前只支持 txt / Markdown / Word(.docx) / HTML 文本文件');
  }
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);

  if (extension === '.docx') {
    const limit = docxInflateLimitBytes === undefined ? DOCX_INFLATE_LIMIT_BYTES : docxInflateLimitBytes;
    return { text: extractDocx(data, limit), encoding: 'docx', format: 'docx' };
  }

  const decoded = decodeBytes(data);
  const text = extension === '.html' || extension === '.htm' ? htmlToText(decoded.text) : decoded.text;
  return { text, encoding: decoded.encoding, format: extension.slice(1) };
}

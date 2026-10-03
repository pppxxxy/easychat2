// Word（.docx）导出：用 fflate 自拼最小 OOXML 包。
//
// 纯函数、零原生依赖，可 Node 直测。边界：只做「生成新 .docx」，
// 不做保格式编辑现有文档（见审查待办第 7 项）。

import { strToU8, zipSync } from 'fflate';

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

function escapeXml(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function splitDocxParagraphs(text) {
  return String(text === undefined || text === null ? '' : text)
    .replace(/\r\n?/g, '\n')
    .split('\n');
}

function paragraphXml(text, style) {
  const pPr = style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : '';
  return `<w:p>${pPr}<w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
}

export function buildDocumentXml({ title = '', paragraphs = [] } = {}) {
  const body = [];
  if (String(title || '').trim()) body.push(paragraphXml(title, 'Heading1'));
  for (const paragraph of paragraphs) body.push(paragraphXml(paragraph));
  if (body.length === 0) body.push(paragraphXml(''));
  const sectPr = '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>'
    + '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>';
  return `${XML_DECL}\n<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">`
    + `<w:body>${body.join('')}${sectPr}</w:body></w:document>`;
}

const CONTENT_TYPES = `${XML_DECL}\n`
  + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
  + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
  + '<Default Extension="xml" ContentType="application/xml"/>'
  + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
  + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
  + '</Types>';

const ROOT_RELS = `${XML_DECL}\n`
  + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
  + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
  + '</Relationships>';

const DOCUMENT_RELS = `${XML_DECL}\n`
  + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
  + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
  + '</Relationships>';

const STYLES = `${XML_DECL}\n`
  + '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
  + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>'
  + '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/>'
  + '<w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>'
  + '</w:styles>';

export function buildDocxBytes({ title = '', paragraphs = [] } = {}) {
  return zipSync({
    '[Content_Types].xml': strToU8(CONTENT_TYPES),
    '_rels/.rels': strToU8(ROOT_RELS),
    'word/document.xml': strToU8(buildDocumentXml({ title, paragraphs })),
    'word/_rels/document.xml.rels': strToU8(DOCUMENT_RELS),
    'word/styles.xml': strToU8(STYLES),
  }, { level: 6 });
}

export function bytesToBase64(bytes) {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let binary = '';
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  const encode = globalThis.btoa;
  if (typeof encode === 'function') return encode(binary);
  throw new Error('当前环境缺少 base64 编码能力。');
}

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
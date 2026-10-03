import test from 'node:test';
import assert from 'node:assert/strict';
import { strFromU8, unzipSync } from 'fflate';

import {
  buildDocxBytes,
  buildDocumentXml,
  bytesToBase64,
  splitDocxParagraphs,
} from '../src/workspace/docx.js';

test('splitDocxParagraphs 统一换行并分段', () => {
  assert.deepEqual(splitDocxParagraphs('a\r\nb\rc\nd'), ['a', 'b', 'c', 'd']);
  assert.deepEqual(splitDocxParagraphs(''), ['']);
  assert.deepEqual(splitDocxParagraphs(null), ['']);
});

test('buildDocumentXml 转义 XML 特殊字符并加标题样式', () => {
  const xml = buildDocumentXml({ title: '标题 & <x>', paragraphs: ['a < b', '换行'] });
  assert.match(xml, /<w:pStyle w:val="Heading1"\/>/);
  assert.match(xml, /标题 &amp; &lt;x&gt;/);
  assert.match(xml, /a &lt; b/);
  assert.match(xml, /<w:sectPr>/);
});

test('buildDocumentXml 空内容也生成一个段落与节属性', () => {
  const xml = buildDocumentXml();
  assert.equal((xml.match(/<w:p>/g) || []).length, 1);
  assert.match(xml, /<w:sectPr>/);
});

test('buildDocxBytes 产出合法 ZIP 且含所需 OOXML 部件', () => {
  const bytes = buildDocxBytes({ title: '报告', paragraphs: ['第一段', '第二段'] });
  assert.ok(bytes instanceof Uint8Array);
  assert.equal(bytes[0], 0x50);
  assert.equal(bytes[1], 0x4b);

  const files = unzipSync(bytes);
  assert.deepEqual(
    Object.keys(files).sort(),
    ['[Content_Types].xml', '_rels/.rels', 'word/_rels/document.xml.rels', 'word/document.xml', 'word/styles.xml'].sort(),
  );
  const documentXml = strFromU8(files['word/document.xml']);
  assert.match(documentXml, /报告/);
  assert.match(documentXml, /第一段/);
  assert.match(documentXml, /第二段/);
  assert.match(strFromU8(files['[Content_Types].xml']), /wordprocessingml\.document\.main\+xml/);
});

test('bytesToBase64 与 Buffer 解码逐字节一致', () => {
  const bytes = buildDocxBytes({ paragraphs: ['内容'] });
  const base64 = bytesToBase64(bytes);
  assert.equal(typeof base64, 'string');
  assert.deepEqual(new Uint8Array(Buffer.from(base64, 'base64')), bytes);
});
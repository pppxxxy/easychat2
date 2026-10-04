import test from 'node:test';
import assert from 'node:assert/strict';
import { strToU8, zipSync } from 'fflate';

import {
  decodeEntities,
  documentXmlToText,
  extractPlainText,
  fileExtension,
  htmlToText,
  isSupportedBookFile,
} from '../src/books/extractText.js';

test('扩展名判定', () => {
  assert.equal(fileExtension('小说.TXT'), '.txt');
  assert.equal(isSupportedBookFile('a.docx'), true);
  assert.equal(isSupportedBookFile('a.html'), true);
  assert.equal(isSupportedBookFile('a.epub'), false);
  assert.equal(isSupportedBookFile('无扩展名'), false);
});

test('实体解码：命名 + 数字 + 十六进制，&amp; 不二次展开', () => {
  assert.equal(decodeEntities('&lt;a&gt; &amp; &quot;b&quot; &nbsp;&#20013;&#x6587;'), '<a> & "b"  中文');
  assert.equal(decodeEntities('&amp;lt;'), '&lt;', '字面 &lt; 不被二次解码成 <');
});

test('docx 文本提取：段落边界、去标签、解实体', () => {
  const documentXml = '<?xml version="1.0" encoding="UTF-8"?>'
    + '<w:document xmlns:w="http://x"><w:body>'
    + '<w:p><w:r><w:t>第一章 起点</w:t></w:r></w:p>'
    + '<w:p/>'
    + '<w:p><w:r><w:t>正文 </w:t></w:r><w:r><w:t>&amp; 更多</w:t></w:r></w:p>'
    + '<w:p><w:r><w:tab/><w:t>缩进行</w:t></w:r></w:p>'
    + '</w:body></w:document>';
  const bytes = zipSync({ 'word/document.xml': strToU8(documentXml) });
  const result = extractPlainText({ fileName: '书.docx', bytes });
  assert.equal(result.format, 'docx');
  assert.equal(result.encoding, 'docx');
  assert.match(result.text, /第一章 起点/);
  assert.match(result.text, /正文 & 更多/);
  assert.match(result.text, /\n\t缩进行/, 'w:tab 转为制表符');
  assert.ok(result.text.split('\n').length >= 3, '段落以换行分隔');
});

test('docx 缺 document.xml 报 UNSUPPORTED_FORMAT', () => {
  const bytes = zipSync({ 'word/styles.xml': strToU8('<x/>') });
  assert.throws(
    () => extractPlainText({ fileName: 'a.docx', bytes }),
    (error) => error && error.code === 'UNSUPPORTED_FORMAT',
  );
});

test('docx 解压上限：按正文实际字节判定，且不受包里其他大条目影响', () => {
  // 正文超限 → 拒绝（用显式的小上限触发，便于构造小样本）
  const bigBody = zipSync({ 'word/document.xml': strToU8('a'.repeat(4096)) });
  assert.throws(
    () => extractPlainText({ fileName: 'big.docx', bytes: bigBody, docxInflateLimitBytes: 1024 }),
    (error) => error && error.code === 'DOCX_TOO_LARGE',
    '正文解压后超过上限必须报 DOCX_TOO_LARGE',
  );

  // 正文很小、但包里另有一个 4MB 条目（zip 炸弹形态）：不该因无关条目被判超限，
  // 也不该去解压它（实现只读目录元数据 + 只解压正文这一条）。
  const bomb = zipSync({
    'word/document.xml': strToU8('<w:p/>'),
    'word/media/blob.bin': new Uint8Array(4 * 1024 * 1024),
  });
  assert.doesNotThrow(
    () => extractPlainText({ fileName: 'bomb.docx', bytes: bomb, docxInflateLimitBytes: 1024 }),
    '上限只约束正文条目，包里其他条目既不参与判定也不被解压',
  );

  // 同一 zip：把上限降到正文之下仍必须被拒（证明判定确实发生在正文上）
  const smallBody = zipSync({ 'word/document.xml': strToU8('b'.repeat(256)) });
  assert.throws(
    () => extractPlainText({ fileName: 'small.docx', bytes: smallBody, docxInflateLimitBytes: 64 }),
    (error) => error && error.code === 'DOCX_TOO_LARGE',
  );
});

test('html 提取：去 script/style，块级标签转换行', () => {
  const html = '<html><head><style>.a{color:red}</style><script>var secret=1;</script></head>'
    + '<body><h1>标题</h1><p>第一段<br>换行</p><div>第二段</div></body></html>';
  assert.equal(htmlToText(html).includes('secret'), false);
  assert.equal(htmlToText(html).includes('color:red'), false);
  const text = htmlToText(html);
  assert.match(text, /标题/);
  assert.match(text, /第一段\n换行/);
  assert.match(text, /第二段/);
});

test('扩展名分发：txt 走编码识别，不支持报错', () => {
  const gbk = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]);
  const result = extractPlainText({ fileName: 'a.txt', bytes: gbk });
  assert.equal(result.text, '中文');
  assert.equal(result.format, 'txt');
  assert.throws(
    () => extractPlainText({ fileName: 'a.epub', bytes: gbk }),
    (error) => error && error.code === 'UNSUPPORTED_FORMAT',
  );
});

test('documentXmlToText 归一多余空行', () => {
  const xml = '<w:p><w:r><w:t>a</w:t></w:r></w:p><w:p/><w:p/><w:p/><w:p><w:r><w:t>b</w:t></w:r></w:p>';
  assert.equal(documentXmlToText(xml), 'a\n\nb');
});

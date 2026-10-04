// 阅读器与导入链路的源码断言（RN 渲染与 SAF 选文件依赖原生运行时，Node 进不去）。
// 关键回归钉：
// - 测量 Text 与可见页 Text 必须共用同一份排版 props（buildPageTextProps 唯一来源），
//   且测量 Text 必须不可见但参与布局（opacity 0，而非 display:none）；
// - 可见页只渲染分到本页的行（pageText）——测量漂移不得造成页面溢出；
// - 导入必须是 '*/*' + 扩展名校验（厂商文件管理器把 .txt 标成 octet-stream）；
// - 编码检测必须拒绝非 UTF-8（U+FFFD 比例），不允许静默导入乱码书。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readSource(relativePath) {
  return fs.readFileSync(path.resolve(relativePath), 'utf8');
}

test('useBookReader：测量-分页-重定位机制齐全', () => {
  const source = readSource('src/books/useBookReader.js');
  assert.ok(source.includes('buildPageTextProps'), '排版 props 必须有唯一来源函数');
  assert.ok(/LINE_HEIGHT_RATIO\s*=\s*[\d.]+/.test(source), '行高比常量定义');
  assert.ok(source.includes('paginateLines') && source.includes('findPageByAnchor'),
    '装箱与重定位必须复用 pagination.js 纯函数');
  assert.ok(source.includes("type: 'anchor'") && source.includes("type: 'last'") && source.includes("type: 'first'"),
    '三种测量后落点（锚/块首页/块末页）必须齐全');
  assert.ok(/status !== MEASURE_BUSY/.test(source), '晚到的 onTextLayout 必须按状态丢弃');
});

test('BookReaderView：可见页只渲染本页行，测量 Text 参与布局但不可见', () => {
  const source = readSource('src/books/BookReaderView.js');
  assert.ok(source.includes('pageText(reader.lines, reader.page)'), '可见页必须由本页行拼成');
  assert.ok(/opacity:\s*0/.test(source), '测量 Text 用 opacity 0（display:none 不产生布局，无法测量）');
  assert.ok(source.includes('onTextLayout={reader.handleTextLayout}'), '测量 Text 接线 onTextLayout');
  assert.ok(source.includes('TAP_ZONE_RATIO'), '左右点按翻页区');
  assert.ok(source.includes('reader.reanchor()'), '字号变化前必须先落锚');
  assert.ok(source.includes('next === fontSize'), '字号到边界时不得污染 pendingJump');
  assert.ok(source.includes('key={openBook.item.id}') || readSource('src/books/BookScreen.js').includes('key={openBook.item.id}'),
    '换书重挂载（key）省去复位逻辑');
});

test('importBook：宽松选择器 + base64 读字节 + 多格式提取 + 失败清理', () => {
  const source = readSource('src/books/importBook.js');
  assert.ok(source.includes("type: '*/*'"), '选择器必须 *.*（厂商把 .txt 标成 octet-stream，text/* 会选不中）');
  assert.ok(source.includes("from './extractText.js'"), '格式/编码处理下沉到 extractText');
  assert.ok(source.includes('extractPlainText'), '调用纯函数提取纯文本');
  assert.ok(/EncodingType\.Base64/.test(source), '以 base64 读原始字节（编码探测与 zip 解包的前提）');
  assert.ok(source.includes('writeAsStringAsync(dest, text)'), '提取后写回 UTF-8 正文');
  const catchBlocks = source.split('catch (error)');
  assert.ok(catchBlocks.length >= 3 && catchBlocks.slice(1).some(block => block.includes('deleteAsync(dest')),
    '复制/提取/落库失败都必须清理半成品文件');
});

test('extractText/decodeText：纯函数承担多格式与多编码（错误码可区分）', () => {
  const extract = readSource('src/books/extractText.js');
  const decode = readSource('src/books/decodeText.js');
  assert.ok(extract.includes("'.docx'") && extract.includes("'.html'"), 'docx/html 格式在支持列表');
  assert.ok(extract.includes('unzipSync'), 'docx 用 fflate 解压');
  assert.ok(/UNSUPPORTED_FORMAT/.test(extract), '不支持格式错误码');
  assert.ok(decode.includes("'gb18030'") && decode.includes("'big5'"), 'GBK/BIG5 候选解码');
  assert.ok(/code = 'ENCODING'/.test(decode), '无法识别编码错误码');
});

test('阅读进度落库：防抖保存 + 退出/卸载兜底（monkey 审查缺陷 1 回归）', () => {
  const reader = readSource('src/books/useBookReader.js');
  assert.ok(reader.includes('location'), 'useBookReader 必须暴露当前阅读位置');
  const view = readSource('src/books/BookReaderView.js');
  assert.ok(view.includes('saveBookProgress(item.id, location)'), '翻页/退出必须写回进度');
  assert.ok(/setTimeout\([\s\S]{0,160}saveBookProgress/.test(view), '位置变化必须防抖保存');
  assert.ok(view.includes('flushProgress'), '退出必须兜底 flush');
  assert.ok(view.includes('onPress={handleBack}'), '返回按钮必须走 flush 路径');
  assert.ok(/useEffect\(\(\) => \(\) => flushProgress\(\)/.test(view), '组件卸载必须兜底保存');
});

test('BookScreen：打开按需读文件、错误按 code 分流', () => {
  const source = readSource('src/books/BookScreen.js');
  assert.ok(source.includes('readBookContent'), '打开书籍才读正文文件');
  assert.ok(source.includes("code === 'ENCODING'") && source.includes("code === 'UNSUPPORTED_FORMAT'"),
    '导入错误按 code 分流提示');
  assert.ok(source.includes('deleteBookCommentsForBooks'), '删书同步清理评论键');
  assert.ok(source.includes('deleteAsync(item.uri'), '删书清理正文文件');
});

test('Markdown 渲染：按 format 切换渲染模式，进度/评论统一到块', () => {
  const view = readSource('src/books/BookReaderView.js');
  assert.ok(view.includes('BookMarkdownList'), 'Markdown 书籍走连续滚动渲染列表');
  assert.ok(view.includes('isMarkdownBook') && view.includes('handleToggleRenderMode'),
    '按格式提供渲染/纯文本切换');
  assert.ok(view.includes('markdownExcerpt') && view.includes('createBookMarkdownStyles'),
    'Markdown 模式复用摘录与样式工厂');
  assert.ok(/paged\s*\?\s*blocks\s*:\s*EMPTY_BLOCKS/.test(view),
    '非分页模式给分页 hook 传空块（保持惰性）');

  const imp = readSource('src/books/importBook.js');
  assert.ok(imp.includes('MARKDOWN_FORMATS') && /markdown:\s*MARKDOWN_FORMATS/.test(imp),
    '导入按 Markdown 格式分块');
  assert.ok(/\bformat,\s*$/m.test(imp) || imp.includes('format,'), '导入落库 format 字段');

  const lib = readSource('src/books/library.js');
  assert.ok(lib.includes('format: String(source.format'), '书籍条目归一 format');
});

test('导入失败提示按 code 走文案键，不渲染原始 error.message', () => {
  const screen = readSource('src/books/BookScreen.js');
  assert.ok(!screen.includes('error.message'),
    '不得把 error.message 渲染给用户：抛错信息面向开发者且是中文，会漏进英文界面');

  // 精确钉住导入处理体本身（避免只靠全文件扫描——注释里出现同名字样会造成假红/假绿）。
  const handler = screen.slice(screen.indexOf('const handleImport'), screen.indexOf('const handleOpen'));
  assert.ok(handler.length > 0, '必须能定位到 handleImport 处理体');
  assert.ok(!handler.includes('error.message'), 'handleImport 内不得把原始报错文本交给 Alert');

  const keys = [
    'books.import.encoding.body',
    'books.import.docxTooLarge.title',
    'books.import.docxTooLarge.body',
    'books.import.empty.title',
    'books.import.empty.body',
  ];
  for (const key of keys) {
    assert.ok(handler.includes(`t('${key}')`), `handleImport 必须使用 ${key}`);
  }
  assert.ok(handler.includes("code === 'EMPTY_BOOK'"), '空内容错误要有独立分支，而不是落到泛化提示');
  assert.ok(handler.includes("code === 'DOCX_TOO_LARGE'"), 'docx 超限要有独立分支，提示具体原因');

  const imp = readSource('src/books/importBook.js');
  assert.ok(/error\.code = 'EMPTY_BOOK'/.test(imp), '空内容错误必须带 code 才能被上层的文案分支识别');

  for (const locale of ['zh-CN', 'en']) {
    const table = readSource(`src/i18n/locales/${locale}.js`);
    for (const key of keys) {
      assert.ok(table.includes(`'${key}'`), `${locale} 缺少文案键 ${key}`);
    }
  }
});

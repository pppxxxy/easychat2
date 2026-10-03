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

test('importBook：宽松选择器 + 严格校验 + 编码检测 + 失败清理', () => {
  const source = readSource('src/books/importBook.js');
  assert.ok(source.includes("type: '*/*'"), '选择器必须 *.*（厂商把 .txt 标成 octet-stream，text/* 会选不中）');
  assert.ok(source.includes("'.txt'") && source.includes("'.md'"), '扩展名校验兜底');
  assert.ok(source.includes('looksLikeBrokenDecoding'), '编码检测函数存在');
  assert.ok(/0xfffd|0xFFFD/.test(source), '按 U+FFFD 比例判定');
  assert.ok(source.includes('UNSUPPORTED_FORMAT') && source.includes("'ENCODING'"), '错误必须带可区分 code');
  const importLines = source.split('\n').filter(line => line.trim().startsWith('import '));
  assert.ok(importLines.every(line => !/iconv|text-encoding|gbk/i.test(line)), '不得引入转码表依赖（v1 只支持 UTF-8）');
  const catchBlocks = source.split('catch (error)');
  assert.ok(catchBlocks.length >= 3 && catchBlocks.slice(1).some(block => block.includes('deleteAsync(dest')),
    '复制/校验失败都必须清理半成品文件');
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

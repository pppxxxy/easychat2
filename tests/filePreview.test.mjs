// 工作区文件预览分类（filePreview）测试。
import test from 'node:test';
import assert from 'node:assert/strict';

import { fileExtension, previewMode, isRichPreview } from '../src/workspace/filePreview.js';

test('fileExtension：取小写扩展名；无扩展名 / 隐藏文件 / 目录 → 空', () => {
  assert.equal(fileExtension('report.md'), 'md');
  assert.equal(fileExtension('a/b/Report.MD'), 'md');
  assert.equal(fileExtension('page.HTML'), 'html');
  assert.equal(fileExtension('.env'), '', '隐藏文件没有扩展名');
  assert.equal(fileExtension('Makefile'), '');
  assert.equal(fileExtension('dir/'), '');
  assert.equal(fileExtension(''), '');
  assert.equal(fileExtension(null), '');
  assert.equal(fileExtension('trailing.'), '');
});

test('previewMode：Markdown / HTML 分类，其余 text', () => {
  for (const name of ['x.md', 'x.markdown', 'x.mdown', 'x.mkd', 'x.mdx']) {
    assert.equal(previewMode(name), 'markdown', name);
  }
  for (const name of ['x.html', 'x.htm', 'x.xhtml']) {
    assert.equal(previewMode(name), 'html', name);
  }
  for (const name of ['x.txt', 'x.json', 'x.js', 'x.css', 'noext', 'x.MD.bak']) {
    assert.equal(previewMode(name), 'text', name);
  }
});

test('isRichPreview：Markdown / HTML 为 true，其余 false', () => {
  assert.equal(isRichPreview('README.md'), true);
  assert.equal(isRichPreview('report.html'), true);
  assert.equal(isRichPreview('src/main.js'), false);
  assert.equal(isRichPreview('data.json'), false);
  assert.equal(isRichPreview('notes'), false);
});

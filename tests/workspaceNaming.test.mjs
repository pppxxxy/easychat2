import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ensureDirectoryName,
  ensureDocxFileName,
  ensureTextFileName,
  isDocxName,
  sanitizeWorkspaceFileName,
} from '../src/workspace/naming.js';

test('sanitizeWorkspaceFileName 去掉路径分隔符与首尾点', () => {
  assert.equal(sanitizeWorkspaceFileName(' 笔记 '), '笔记');
  assert.equal(sanitizeWorkspaceFileName('a/b/c.txt'), 'a-b-c.txt');
  assert.equal(sanitizeWorkspaceFileName('..\\..\\x.md'), '..-..-x.md');
  assert.equal(sanitizeWorkspaceFileName('trailing...'), 'trailing');
  assert.equal(sanitizeWorkspaceFileName('', '兜底'), '兜底');
  assert.equal(sanitizeWorkspaceFileName(null, '兜底'), '兜底');
});

test('ensureTextFileName 保证文本扩展名', () => {
  assert.equal(ensureTextFileName('笔记'), '笔记.txt');
  assert.equal(ensureTextFileName('笔记.md'), '笔记.md');
  assert.equal(ensureTextFileName('笔记.markdown'), '笔记.markdown');
  assert.equal(ensureTextFileName('目录/子.txt'), '目录-子.txt');
  assert.equal(ensureTextFileName(''), '未命名.txt');
});

test('ensureDocxFileName 保证 .docx 扩展名', () => {
  assert.equal(ensureDocxFileName('报告'), '报告.docx');
  assert.equal(ensureDocxFileName('报告.docx'), '报告.docx');
  assert.equal(ensureDocxFileName('报告.DOCX'), '报告.DOCX');
  assert.equal(ensureDocxFileName(''), '文档.docx');
  assert.equal(isDocxName('a.docx'), true);
  assert.equal(isDocxName('a.txt'), false);
});
test('项目文件命名：保留源码扩展名；文件夹保留多级路径', () => {
  // 带合法文本扩展名的项目文件原样保留
  assert.equal(ensureTextFileName('index.js'), 'index.js');
  assert.equal(ensureTextFileName('index.html'), 'index.html');
  assert.equal(ensureTextFileName('package.json'), 'package.json');
  // 无扩展名仍补 .txt；二进制扩展名也退化为 .txt
  assert.equal(ensureTextFileName('README'), 'README.txt');
  assert.equal(ensureTextFileName('pic.png'), 'pic.png.txt');
  // 文件夹：多级路径保留，空值兜底
  assert.equal(ensureDirectoryName('src/components'), 'src/components');
  assert.equal(ensureDirectoryName('  src  '), 'src');
  assert.equal(ensureDirectoryName(''), '新建文件夹');
});

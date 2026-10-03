import test from 'node:test';
import assert from 'node:assert/strict';

import {
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
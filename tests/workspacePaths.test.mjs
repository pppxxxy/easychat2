import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertAllowedWorkspaceFile,
  assertAllowedWorkspaceOutputFile,
  fileExtension,
  isAllowedWorkspaceFile,
  isAllowedWorkspaceOutputFile,
  isListableWorkspaceFile,
  normalizeWorkspacePath,
  resolveWorkspaceUri,
  sandboxDirectory,
  sanitizeSandboxId,
} from '../src/workspace/paths.js';

test('sanitizeSandboxId 归一出安全目录名', () => {
  assert.equal(sanitizeSandboxId('char-1_AbC'), 'char-1_AbC');
  assert.equal(sanitizeSandboxId('角色 id/../x'), '___id____x');
  assert.equal(sanitizeSandboxId(''), 'default');
  assert.equal(sanitizeSandboxId(null), 'default');
  assert.equal(sanitizeSandboxId('a'.repeat(100)).length, 64);
});

test('normalizeWorkspacePath 只接受沙盒内相对路径', () => {
  assert.equal(normalizeWorkspacePath('a.txt'), 'a.txt');
  assert.equal(normalizeWorkspacePath('a\\b/./c.md'), 'a/b/c.md');
  assert.equal(normalizeWorkspacePath('  notes/readme.md  '), 'notes/readme.md');

  assert.throws(() => normalizeWorkspacePath(''), /路径不能为空/);
  assert.throws(() => normalizeWorkspacePath('   '), /路径不能为空/);
  assert.throws(() => normalizeWorkspacePath('/etc/passwd'), /相对路径/);
  assert.throws(() => normalizeWorkspacePath('../secret.txt'), /越出工作区/);
  assert.throws(() => normalizeWorkspacePath('a/../../b.txt'), /越出工作区/);
  assert.throws(() => normalizeWorkspacePath('a\u0000b.txt'), /非法字符/);
  assert.throws(() => normalizeWorkspacePath(`${'x'.repeat(300)}.txt`), /路径过长/);
});

test('fileExtension 与文本/二进制判定（可写项目 → 黑名单制）', () => {
  assert.equal(fileExtension('a.txt'), 'txt');
  assert.equal(fileExtension('dir/a.MD'), 'md');
  assert.equal(fileExtension('noext'), '');
  assert.equal(fileExtension('.hidden'), '');
  // 文本/项目文件：txt/md 之外，源码与配置也算
  assert.equal(isAllowedWorkspaceFile('a.txt'), true);
  assert.equal(isAllowedWorkspaceFile('a.md'), true);
  assert.equal(isAllowedWorkspaceFile('a.markdown'), true);
  assert.equal(isAllowedWorkspaceFile('src/index.js'), true);
  assert.equal(isAllowedWorkspaceFile('index.html'), true);
  assert.equal(isAllowedWorkspaceFile('package.json'), true);
  assert.equal(isAllowedWorkspaceFile('Makefile'), true, '无扩展名按文本');
  // 二进制/媒体一律拒绝
  assert.equal(isAllowedWorkspaceFile('a.png'), false);
  assert.equal(isAllowedWorkspaceFile('a.mp4'), false);
  assert.equal(isAllowedWorkspaceFile('a.zip'), false);
  assert.throws(() => assertAllowedWorkspaceFile('a.png'), /只能读写文本文件/);
});

test('写入白名单：文本 + .docx；.docx 可写可列但不可读', () => {
  assert.equal(isAllowedWorkspaceOutputFile('a.docx'), true);
  assert.equal(isAllowedWorkspaceOutputFile('a.txt'), true);
  assert.equal(isAllowedWorkspaceOutputFile('index.js'), true);
  assert.equal(isAllowedWorkspaceOutputFile('a.png'), false);
  assert.equal(isListableWorkspaceFile('a.docx'), true);
  assert.equal(isAllowedWorkspaceFile('a.docx'), false);
  assert.equal(assertAllowedWorkspaceOutputFile('a.docx'), 'a.docx');
  assert.throws(() => assertAllowedWorkspaceOutputFile('a.png'), /只支持文本文件与生成的 \.docx/);
});

test('sandboxDirectory 与 resolveWorkspaceUri', () => {
  assert.equal(sandboxDirectory('/doc/workspace', 'c1'), '/doc/workspace/c1/');
  assert.equal(sandboxDirectory('/doc/workspace/', 'c1'), '/doc/workspace/c1/');
  assert.equal(resolveWorkspaceUri('/doc/workspace/', 'c1', 'a.txt'), '/doc/workspace/c1/a.txt');
  assert.equal(resolveWorkspaceUri('/doc/workspace/', 'c1', 'src/app.js'), '/doc/workspace/c1/src/app.js');
  assert.throws(() => resolveWorkspaceUri('/doc/workspace/', 'c1', 'a.png'), /只能读写文本文件/);
});
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertAllowedWorkspaceFile,
  fileExtension,
  isAllowedWorkspaceFile,
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

test('fileExtension 与扩展名白名单', () => {
  assert.equal(fileExtension('a.txt'), 'txt');
  assert.equal(fileExtension('dir/a.MD'), 'md');
  assert.equal(fileExtension('noext'), '');
  assert.equal(fileExtension('.hidden'), '');
  assert.equal(isAllowedWorkspaceFile('a.txt'), true);
  assert.equal(isAllowedWorkspaceFile('a.md'), true);
  assert.equal(isAllowedWorkspaceFile('a.markdown'), true);
  assert.equal(isAllowedWorkspaceFile('a.png'), false);
  assert.equal(isAllowedWorkspaceFile('a.js'), false);
  assert.throws(() => assertAllowedWorkspaceFile('a.png'), /只支持纯文本与 Markdown/);
});

test('sandboxDirectory 与 resolveWorkspaceUri', () => {
  assert.equal(sandboxDirectory('/doc/workspace', 'c1'), '/doc/workspace/c1/');
  assert.equal(sandboxDirectory('/doc/workspace/', 'c1'), '/doc/workspace/c1/');
  assert.equal(resolveWorkspaceUri('/doc/workspace/', 'c1', 'a.txt'), '/doc/workspace/c1/a.txt');
  assert.throws(() => resolveWorkspaceUri('/doc/workspace/', 'c1', 'a.png'), /只支持纯文本与 Markdown/);
});
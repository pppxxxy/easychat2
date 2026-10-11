import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertAllowedWorkspaceFile,
  assertAllowedWorkspaceOutputFile,
  assertWritableWorkspacePath,
  fileExtension,
  isAllowedWorkspaceFile,
  isAllowedWorkspaceOutputFile,
  isListableWorkspaceFile,
  isProtectedWorkspacePath,
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

// ---- 受保护的写入路径（审计与快照，2026-10-10）----

test('isProtectedWorkspacePath：三个审计/快照目录全拦，相邻的 agent 资产不拦', () => {
  // 受保护：事件流 / 写前快照 / 推送基线
  assert.equal(isProtectedWorkspacePath('.easychat/sessions/s1.jsonl'), true);
  assert.equal(isProtectedWorkspacePath('.easychat/file-history/index.json'), true);
  assert.equal(isProtectedWorkspacePath('.easychat/file-history/entries/x.json'), true);
  assert.equal(isProtectedWorkspacePath('.easychat/rollback/123.json'), true);
  // 目录本身（无尾斜杠）也算
  assert.equal(isProtectedWorkspacePath('.easychat/sessions'), true);
  // 归一化口径：反斜杠 / ./ 前缀 / 多余斜杠
  assert.equal(isProtectedWorkspacePath('.easychat\\sessions\\s.jsonl'), true);
  assert.equal(isProtectedWorkspacePath('./.easychat/sessions/s.jsonl'), true);
  assert.equal(isProtectedWorkspacePath('.easychat//sessions//s.jsonl'), true);

  // 不拦：agent 必须能写自己的技能/命令/分身/钩子/环境，以及普通项目文件
  assert.equal(isProtectedWorkspacePath('.easychat/skills/x/SKILL.md'), false);
  assert.equal(isProtectedWorkspacePath('.easychat/commands/x.md'), false);
  assert.equal(isProtectedWorkspacePath('.easychat/agents/x.md'), false);
  assert.equal(isProtectedWorkspacePath('.easychat/hooks.json'), false);
  assert.equal(isProtectedWorkspacePath('.easychat/env.json'), false);
  assert.equal(isProtectedWorkspacePath('.easychat/pull-skipped.json'), false);
  // 前缀相似但不是同一目录：不能误伤
  assert.equal(isProtectedWorkspacePath('.easychat/sessions-notes.md'), false);
  assert.equal(isProtectedWorkspacePath('notes/sessions/s.jsonl'), false);
  assert.equal(isProtectedWorkspacePath(''), false);
  assert.equal(isProtectedWorkspacePath(null), false);
});

test('assertWritableWorkspacePath：受保护抛错，其它原样返回', () => {
  assert.throws(() => assertWritableWorkspacePath('.easychat/rollback/x.json'), /不允许改写/);
  assert.throws(() => assertWritableWorkspacePath('.easychat/file-history/index.json'), /不允许改写/);
  assert.equal(assertWritableWorkspacePath('notes/a.md'), 'notes/a.md');
  assert.equal(assertWritableWorkspacePath('.easychat/skills/x/SKILL.md'), '.easychat/skills/x/SKILL.md');
});
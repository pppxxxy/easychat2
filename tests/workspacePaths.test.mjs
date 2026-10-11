import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertAllowedWorkspaceFile,
  assertAllowedWorkspaceOutputFile,
  assertSafeWorkspaceSegment,
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

// ---- P0：URL 编码形态的沙盒逃逸（2026-10-11）----
//
// 事故形态：路径拼成 URI 后由 Android 原生 `Uri.getPath()` **解码**
//（expo-file-system 的 FileSystemLegacyModule.kt 里 `File(this.path!!)`），
// 于是 `a/%2e%2e/%2e%2e/x` 在 JS 侧只是一个普通段、原样通过，到原生侧变成
// `a/../../x` —— 逃出 `workspace/<id>/`。只拦字面量 `..` 等于没拦。
test('P0 回归：编码形态的越界段一律拒绝（主沙盒）', () => {
  const escapes = [
    'a/%2e%2e/%2e%2e/x',
    '%2e%2e',
    '..%2f',
    '%2F',
    '%252e%252e',
    '%2e%2e/x',
    'a/%2E%2E/b',
    '%2e%2e%2f%2e%2e%2fetc/passwd',
    'x/%25252e%25252e/y',
    'a%00b.txt',
    'a/%2e%2e',
  ];
  for (const path of escapes) {
    assert.throws(
      () => normalizeWorkspacePath(path),
      /越出工作区/,
      `${path} 必须被拒绝（原生侧会百分号解码）`
    );
  }
  // 判据本身可单独使用（git 侧共用同一份）
  assert.throws(() => assertSafeWorkspaceSegment('%2e%2e'), /越出工作区/);
  assert.throws(() => assertSafeWorkspaceSegment('..'), /越出工作区/);
  assert.equal(assertSafeWorkspaceSegment('normal-name.js'), 'normal-name.js');
});

test('P0 回归：正常路径不被误拒（中文 / 空格 / 点开头段 / 无扩展名）', () => {
  const ok = [
    ['中文目录/文档.md', '中文目录/文档.md'],
    ['my notes/周报 2026.md', 'my notes/周报 2026.md'],
    ['.gitignore', '.gitignore'],
    ['.easychat/skills/demo/SKILL.md', '.easychat/skills/demo/SKILL.md'],
    ['a/.hidden/b.txt', 'a/.hidden/b.txt'],
    ['src/..hidden', 'src/..hidden'],
    ['Makefile', 'Makefile'],
    ['a/./b//c.txt', 'a/b/c.txt'],
  ];
  for (const [input, expected] of ok) {
    assert.equal(normalizeWorkspacePath(input), expected, `${input} 是合法路径`);
  }
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

test('isProtectedWorkspacePath：审计/快照目录 + 会改 agent 行为的文件全拦，其余资产不拦', () => {
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

  // plugins.json 是插件（代码执行）装配源，一并保护（2026-10-11）
  assert.equal(isProtectedWorkspacePath('.easychat/plugins.json'), true);

  // 不拦：agent 仍能写自己的技能/命令/分身/钩子/环境，以及普通项目文件（既有设计）
  assert.equal(isProtectedWorkspacePath('.easychat/skills/x/SKILL.md'), false);
  assert.equal(isProtectedWorkspacePath('.easychat/commands/x.md'), false);
  assert.equal(isProtectedWorkspacePath('.easychat/agents/x.md'), false);
  assert.equal(isProtectedWorkspacePath('.easychat/hooks.json'), false);
  assert.equal(isProtectedWorkspacePath('.easychat/board/board.json'), false);
  assert.equal(isProtectedWorkspacePath('.easychat/env.json'), false);
  assert.equal(isProtectedWorkspacePath('.easychat/pull-skipped.json'), false);
  // 前缀相似但不是同一目录：不能误伤
  assert.equal(isProtectedWorkspacePath('.easychat/sessions-notes.md'), false);
  assert.equal(isProtectedWorkspacePath('notes/sessions/s.jsonl'), false);
  assert.equal(isProtectedWorkspacePath(''), false);
  assert.equal(isProtectedWorkspacePath(null), false);
});

// P1 回归（2026-10-11）：SAF 后端按**显示名**查找子项（safStore.js 的 findChild
// 用 `entry.name === name`），大小写变体在真实文件系统上可能落到同一个目录。
// 判据必须大小写不敏感，否则 `.easychat/SESSIONS/x.jsonl` 就绕过了守卫。
test('P1 回归：受保护前缀判定大小写不敏感（SAF 按显示名匹配）', () => {
  for (const path of [
    '.easychat/SESSIONS/s1.jsonl',
    '.EasyChat/sessions/s1.jsonl',
    '.easychat/File-History/index.json',
    '.easychat/ROLLBACK/1.json',
    './.EASYCHAT/Rollback/1.json',
  ]) {
    assert.equal(isProtectedWorkspacePath(path), true, `${path} 必须被判为受保护`);
    assert.throws(() => assertWritableWorkspacePath(path), /不允许改写/);
  }
  // 仍然不误伤相邻资产（大小写变体也一样）
  assert.equal(isProtectedWorkspacePath('.easychat/HOOKS.json'), false);
  assert.equal(isProtectedWorkspacePath('.easychat/Skills/x/SKILL.md'), false);
});

test('assertWritableWorkspacePath：受保护抛错，其它原样返回', () => {
  assert.throws(() => assertWritableWorkspacePath('.easychat/rollback/x.json'), /不允许改写/);
  assert.throws(() => assertWritableWorkspacePath('.easychat/file-history/index.json'), /不允许改写/);
  assert.equal(assertWritableWorkspacePath('notes/a.md'), 'notes/a.md');
  assert.equal(assertWritableWorkspacePath('.easychat/skills/x/SKILL.md'), '.easychat/skills/x/SKILL.md');
});
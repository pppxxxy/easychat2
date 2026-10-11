// LSP-lite 加深：多语言符号提取（symbols.js）+ 符号引用查找（references.js）。
// 纯函数行为测试——覆盖各语言常见顶层形态、整词匹配、定义/引用分类与预算截断。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SYMBOL_LANGUAGES,
  languageFromPath,
  isSymbolLanguage,
  extractSymbols,
  formatSymbols,
} from '../src/workspace/symbols.js';
import {
  escapeRegExp,
  buildSymbolPattern,
  scanReferences,
} from '../src/workspace/references.js';

test('languageFromPath：覆盖新增语言的扩展名', () => {
  assert.equal(languageFromPath('a.ts'), 'ts');
  assert.equal(languageFromPath('a.go'), 'go');
  assert.equal(languageFromPath('a.rs'), 'rust');
  assert.equal(languageFromPath('A.java'), 'java');
  assert.equal(languageFromPath('A.kt'), 'kotlin');
  assert.equal(languageFromPath('a.rb'), 'ruby');
  assert.equal(languageFromPath('a.php'), 'php');
  assert.equal(languageFromPath('a.cpp'), 'c');
  assert.equal(languageFromPath('a.h'), 'c');
  assert.equal(languageFromPath('A.cs'), 'cs');
  assert.equal(languageFromPath('A.swift'), 'swift');
  assert.equal(languageFromPath('run.sh'), 'sh');
  assert.equal(languageFromPath('README.md'), '');
  assert.equal(languageFromPath('noext'), '');
  assert.equal(isSymbolLanguage('go'), true);
  assert.equal(isSymbolLanguage('md'), false);
  assert.ok(SYMBOL_LANGUAGES.length >= 12);
});

test('extractSymbols：Go 的 func（含 receiver）与 type', () => {
  const src = [
    'package main',
    '',
    'type Server struct {',
    '}',
    '',
    'func (s *Server) Handle() {}',
    'func main() {',
    '}',
  ].join('\n');
  const out = extractSymbols(src, 'go');
  assert.deepEqual(out, [
    { kind: 'type', name: 'Server', line: 3 },
    { kind: 'function', name: 'Handle', line: 6 },
    { kind: 'function', name: 'main', line: 7 },
  ]);
});

test('extractSymbols：Rust 的 fn/struct/enum/trait/mod', () => {
  const src = [
    'pub struct Foo;',
    'pub enum Bar { A }',
    'pub trait Baz {}',
    'pub mod inner {}',
    'pub async fn run() {}',
    'unsafe fn raw() {}',
  ].join('\n');
  assert.deepEqual(extractSymbols(src, 'rust'), [
    { kind: 'class', name: 'Foo', line: 1 },
    { kind: 'class', name: 'Bar', line: 2 },
    { kind: 'class', name: 'Baz', line: 3 },
    { kind: 'type', name: 'inner', line: 4 },
    { kind: 'function', name: 'run', line: 5 },
    { kind: 'function', name: 'raw', line: 6 },
  ]);
});

test('extractSymbols：Java/Kotlin/Ruby/PHP/Swift 的顶层形态', () => {
  assert.deepEqual(extractSymbols('public final class Foo {}', 'java'), [{ kind: 'class', name: 'Foo', line: 1 }]);
  assert.deepEqual(extractSymbols('data class Bar(val x: Int)', 'kotlin'), [{ kind: 'class', name: 'Bar', line: 1 }]);
  assert.deepEqual(extractSymbols('suspend fun go() {}', 'kotlin'), [{ kind: 'function', name: 'go', line: 1 }]);
  assert.deepEqual(extractSymbols('def run!\nend', 'ruby'), [{ kind: 'function', name: 'run!', line: 1 }]);
  assert.deepEqual(extractSymbols('module M\nend', 'ruby'), [{ kind: 'module', name: 'M', line: 1 }]);
  assert.deepEqual(extractSymbols('abstract class A {}', 'php'), [{ kind: 'class', name: 'A', line: 1 }]);
  assert.deepEqual(extractSymbols('public protocol P {}', 'swift'), [{ kind: 'class', name: 'P', line: 1 }]);
  assert.deepEqual(extractSymbols('func f() {}', 'swift'), [{ kind: 'function', name: 'f', line: 1 }]);
});

test('extractSymbols：Shell 的两种函数写法', () => {
  assert.deepEqual(extractSymbols('function build() {', 'sh'), [{ kind: 'function', name: 'build', line: 1 }]);
  assert.deepEqual(extractSymbols('deploy() {', 'sh'), [{ kind: 'function', name: 'deploy', line: 1 }]);
});

test('extractSymbols：未知语言返回空；formatSymbols 给可读回退', () => {
  assert.deepEqual(extractSymbols('whatever', 'md'), []);
  assert.match(formatSymbols([], 'x.md'), /未提取到顶层符号/);
  assert.equal(formatSymbols([{ kind: 'class', name: 'A', line: 3 }], 'a.java'), '3: class A');
});

test('buildSymbolPattern：整词匹配与特殊字符转义', () => {
  assert.ok(buildSymbolPattern('run').test('runAgentTurn run'));
  // 整词：run 不应命中 runAgentTurn
  assert.equal(/\brun\b/.test('runAgentTurn'), false);
  assert.equal(escapeRegExp('a.b*c'), 'a\\.b\\*c');
  const dotted = buildSymbolPattern('a.b');
  assert.ok(dotted.test('x a.b y'));
  assert.equal(buildSymbolPattern(''), null);
});

test('scanReferences：区分定义与引用，整词不漏不错', () => {
  const files = [
    { path: 'src/a.js', content: 'export function run() {}\nrun();\nrunAgentTurn();' },
    { path: 'src/b.js', content: 'import { run } from "./a.js";\nrun();' },
  ];
  const out = scanReferences(files, { symbol: 'run' });
  assert.equal(out.total, 4, 'a.js 两处 run + b.js 两处（runAgentTurn 不算）');
  assert.equal(out.definitions, 1, '仅 a.js 第 1 行是定义');
  assert.equal(out.references, 3);
  assert.equal(out.fileCount, 2);
  assert.match(out.text, /\[定义\]/);
  assert.match(out.text, /\[引用\]/);
});

test('scanReferences：maxMatchesPerFile 截断并标注；空符号报错', () => {
  const files = [{ path: 'a.js', content: Array.from({ length: 5 }, () => 'x').join('\n') }];
  const out = scanReferences(files, { symbol: 'x', maxMatchesPerFile: 2 });
  assert.equal(out.total, 5);
  assert.match(out.text, /已列前 2 处/);
  const bad = scanReferences(files, { symbol: '   ' });
  assert.equal(bad.error, 'empty-symbol');
  assert.equal(bad.text, '');
});

test('scanReferences：时间预算耗尽时标注 truncated', () => {
  const files = [{ path: 'a.js', content: 'x\nx\n' }];
  let t = 0;
  const out = scanReferences(files, {
    symbol: 'x',
    now: () => { t += 10; return t; },
    startTime: 0,
    timeBudgetMs: 5,
  });
  assert.equal(out.truncated, true);
});

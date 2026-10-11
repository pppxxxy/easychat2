// LSP-lite 代码结构提取：语言判定 / 顶层符号 / 格式化。
import test from 'node:test';
import assert from 'node:assert/strict';

import { extractSymbols, formatSymbols, languageFromPath } from '../src/workspace/symbols.js';

test('languageFromPath：扩展名 → 语言', () => {
  assert.equal(languageFromPath('a.js'), 'js');
  assert.equal(languageFromPath('a.tsx'), 'ts');
  assert.equal(languageFromPath('a.mjs'), 'js');
  assert.equal(languageFromPath('a.py'), 'py');
  assert.equal(languageFromPath('a.txt'), '');
});

test('extractSymbols：JS/TS 顶层符号 + 行号（非符号行不误报）', () => {
  const code = [
    "import x from 'y';",
    'export function foo() {}',
    'class Bar {}',
    'export const baz = () => 1;',
    'const qux = async (a) => a;',
    'const n = 5;',
  ].join('\n');
  assert.deepEqual(extractSymbols(code, 'js'), [
    { kind: 'function', name: 'foo', line: 2 },
    { kind: 'class', name: 'Bar', line: 3 },
    { kind: 'const', name: 'baz', line: 4 },
    { kind: 'const', name: 'qux', line: 5 },
  ]);
});

test('extractSymbols：Python def/class；未知语言空', () => {
  const code = 'class A:\n    pass\ndef f():\n    pass\nasync def g():\n    pass\n';
  assert.deepEqual(extractSymbols(code, 'py'), [
    { kind: 'class', name: 'A', line: 1 },
    { kind: 'function', name: 'f', line: 3 },
    { kind: 'function', name: 'g', line: 5 },
  ]);
  assert.deepEqual(extractSymbols(code, ''), []);
});

test('formatSymbols：有符号按行号列表；无符号给提示', () => {
  assert.equal(formatSymbols([{ kind: 'function', name: 'f', line: 3 }], 'a.js'), '3: function f');
  assert.match(formatSymbols([], 'a.txt'), /未提取到/);
});

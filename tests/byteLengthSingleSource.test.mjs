// 「UTF-8 字节计数只有一份实现」这条结构性不变量（回归 2026-10-11 逐行审查 P2）。
//
// 背景：同一段字节计数逻辑曾在**四处**各写一份——storage/io.js、storage/backupStream.js
//（分片累加版）、chat/RichHtmlMessage.js、workspace/memory.js。四份必须永远一致（都用来判
//「是否超过内联/截断阈值」），任何一份漂移都会让阈值口径不一致，而且不会有任何测试报错
//（各自的用例只覆盖自己那份的典型输入）。
//
// 行为正确性分别由 tests/workspaceMemory.test.mjs（emoji 代理对、截断边界）与
// tests/backupStream.test.mjs（分片累加 === Buffer.byteLength(JSON.stringify(...))）钉住；
// 本文件钉的是**唯一实现**这件事本身：再长出一份手写副本就红。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const IMPLEMENTATION = 'src/utils/byteLength.js';
const CONSUMERS = [
  'src/storage/io.js',
  'src/storage/backupStream.js',
  'src/chat/RichHtmlMessage.js',
  'src/workspace/memory.js',
];

// 手写字节计数循环的特征片段：遍历字符 + charCodeAt。
const HAND_WRITTEN_LOOP = /for \(let index = 0; index < \w+\.length; index \+= 1\) \{\s*const code = \w+\.charCodeAt\(/;

test('utf8ByteLength 只有一份实现，四处消费方一律引用它', () => {
  for (const file of CONSUMERS) {
    const source = fs.readFileSync(path.resolve(file), 'utf8');
    assert.ok(
      source.includes('utils/byteLength.js'),
      `${file} 必须从唯一实现（${IMPLEMENTATION}）引用 utf8ByteLength`
    );
    assert.ok(
      !HAND_WRITTEN_LOOP.test(source),
      `${file} 不得再手写一份字节计数循环（四份副本就是这样长出来的）`
    );
  }
});

test('实现文件本身确实带着代理对处理（防上面那条检查空转）', () => {
  const source = fs.readFileSync(path.resolve(IMPLEMENTATION), 'utf8');
  assert.ok(HAND_WRITTEN_LOOP.test(source), '唯一实现里应有字节计数循环');
  assert.ok(source.includes('0xd800') && source.includes('0xdc00'), '应显式处理代理对（emoji 算 4 字节）');
});

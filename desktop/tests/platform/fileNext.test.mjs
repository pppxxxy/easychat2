// expo-file-system 新 API（File/FileHandle）适配行为测试。
//
// 核心性质（design.md「正确性属性 8」）：按任意字节位置切分流式读取，
// 解码结果与整块解码逐字相同。构造含中文与 emoji 的文件，用 3/5/7 字节错位切片。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { makeSandbox } from '../helpers/sandbox.mjs';
import { createFileNext, File as LazyFile } from '../../src/platform/fileNext.js';

function sliceRead(file, chunkSizes) {
  const handle = file.open();
  const decoder = new TextDecoder('utf-8');
  let text = '';
  let index = 0;
  try {
    while (true) {
      const size = chunkSizes[index % chunkSizes.length];
      index += 1;
      const bytes = handle.readBytes(size);
      if (!bytes || bytes.length === 0) break;
      text += decoder.decode(bytes, { stream: true });
      if (index > 100000) throw new Error('slice read did not terminate');
    }
    text += decoder.decode();
  } finally {
    handle.close();
  }
  return text;
}

test('File 适配：exists/size 是同步属性，text() 读取 UTF-8', () => {
  const sandbox = makeSandbox();
  try {
    const { File } = createFileNext(sandbox.bridge);
    const filePath = path.join(sandbox.documentsRoot, 'demo.txt');
    const text = '你好，桌面版 EasyChat2 👋 — S1';
    fs.writeFileSync(filePath, text, 'utf8');

    const file = new File(`${sandbox.documentDirectory}demo.txt`);
    assert.equal(file.exists, true);
    assert.equal(file.size, Buffer.byteLength(text, 'utf8'));
    assert.equal(file.text(), text);

    const missing = new File(`${sandbox.documentDirectory}missing.txt`);
    assert.equal(missing.exists, false);
    assert.equal(missing.size, 0);
  } finally {
    sandbox.cleanup();
  }
});

test('FileHandle：跨片多字节解码与整块一致（3/5/7 字节错位切片）', () => {
  const sandbox = makeSandbox();
  try {
    const { File } = createFileNext(sandbox.bridge);
    const filePath = path.join(sandbox.documentsRoot, 'big.txt');
    // 中文（3 字节）+ emoji（4 字节）混合，确保切片点必然落在多字节字符中间。
    const text = ('你好👋世界☮️，Peace & 桌面 —— ').repeat(40);
    fs.writeFileSync(filePath, text, 'utf8');

    const file = new File(`${sandbox.documentDirectory}big.txt`);
    assert.equal(sliceRead(file, [3]), text, '3 字节错位切片');
    assert.equal(sliceRead(file, [5]), text, '5 字节错位切片');
    assert.equal(sliceRead(file, [7]), text, '7 字节错位切片');
    assert.equal(sliceRead(file, [1]), text, '逐字节切片');
  } finally {
    sandbox.cleanup();
  }
});

test('File 适配：create + handle.writeBytes 流式写、整块 write、delete', () => {
  const sandbox = makeSandbox();
  try {
    const { File } = createFileNext(sandbox.bridge);
    const uri = `${sandbox.documentDirectory}stream.txt`;

    const file = new File(uri);
    file.create({ intermediates: true, overwrite: true });
    const handle = file.open();
    try {
      handle.writeBytes(new TextEncoder().encode('第一片'));
      handle.writeBytes(new TextEncoder().encode('第二片'));
    } finally {
      handle.close();
    }
    assert.equal(new File(uri).text(), '第一片第二片');
    assert.equal(new File(uri).size, Buffer.byteLength('第一片第二片', 'utf8'));

    new File(uri).write(new TextEncoder().encode('整块覆盖'));
    assert.equal(new File(uri).text(), '整块覆盖');

    new File(uri).delete();
    assert.equal(new File(uri).exists, false);
    assert.throws(() => new File(uri).delete(), '与 expo File.delete 一致：不存在时抛错');
  } finally {
    sandbox.cleanup();
  }
});

test('命名导出 File：共享层 `import { File }` 依赖的静态形状可用', () => {
  const sandbox = makeSandbox();
  const previous = globalThis.easychat2;
  globalThis.easychat2 = sandbox.bridge;
  try {
    const uri = `${sandbox.documentDirectory}named.txt`;
    new LazyFile(uri).write('named export');
    assert.equal(new LazyFile(uri).text(), 'named export');
  } finally {
    globalThis.easychat2 = previous;
    sandbox.cleanup();
  }
});

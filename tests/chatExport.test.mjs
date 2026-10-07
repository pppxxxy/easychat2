// 对话导出文件写出测试（P2）。加载真实现（chatExport.js），在 FileSystem mock 上验证。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const presetEnv = require.resolve('@babel/preset-env');

const files = new Map();
const dirs = new Set();
const fail = { write: false, move: false };

const FileSystem = {
  cacheDirectory: 'file:///cache/',
  EncodingType: { Base64: 'base64', UTF8: 'utf8' },
  makeDirectoryAsync: async dir => { dirs.add(dir); },
  writeAsStringAsync: async (uri, value) => {
    if (fail.write) throw new Error('disk full');
    files.set(uri, value);
  },
  readAsStringAsync: async uri => {
    if (!files.has(uri)) throw new Error(`missing ${uri}`);
    return files.get(uri);
  },
  moveAsync: async ({ from, to }) => {
    if (fail.move) throw new Error('move failed');
    if (!files.has(from)) throw new Error(`missing ${from}`);
    files.set(to, files.get(from));
    files.delete(from);
  },
  readDirectoryAsync: async dir => [...files.keys()]
    .filter(uri => uri.startsWith(dir))
    .map(uri => uri.slice(dir.length)),
  deleteAsync: async uri => { files.delete(uri); },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'expo-file-system' || request === 'expo-file-system/legacy') return FileSystem;
  return originalLoad.call(this, request, parent, isMain);
};

function loadChatExport() {
  const absPath = path.resolve('src/storage/chatExport.js');
  delete Module._cache[absPath];
  const code = babel.transformSync(fs.readFileSync(absPath, 'utf8'), {
    babelrc: false,
    configFile: false,
    filename: absPath,
    presets: [[presetEnv, { targets: { node: 'current' }, modules: 'commonjs' }]],
  }).code;
  const mod = new Module(absPath);
  mod.filename = absPath;
  mod.paths = Module._nodeModulePaths(path.dirname(absPath));
  Module._cache[absPath] = mod;
  mod._compile(code, absPath);
  return mod.exports;
}

test('writeChatExportText：写入缓存目录并返回 uri', async () => {
  files.clear();
  dirs.clear();
  const mod = loadChatExport();
  const { uri } = await mod.writeChatExportText({ fileName: 'a.md', content: '# hi' });
  assert.equal(uri, 'file:///cache/chat-export/a.md');
  assert.equal(files.get(uri), '# hi');
  assert.ok(dirs.has('file:///cache/chat-export/'));
});

test('writeChatExportText：缺文件名抛错', async () => {
  const mod = loadChatExport();
  await assert.rejects(() => mod.writeChatExportText({ fileName: '', content: 'x' }));
});

test('writeChatExportText：写盘失败清理半成品', async () => {
  files.clear();
  fail.write = true;
  const mod = loadChatExport();
  try {
    await assert.rejects(() => mod.writeChatExportText({ fileName: 'b.md', content: 'x' }));
    assert.equal(files.has('file:///cache/chat-export/b.md'), false);
  } finally {
    fail.write = false;
  }
});

test('persistChatExportImage：把临时截图移动到导出目录', async () => {
  files.clear();
  const mod = loadChatExport();
  files.set('file:///tmp/cap-1.png', 'PNGDATA');
  const { uri } = await mod.persistChatExportImage({ tmpUri: 'file:///tmp/cap-1.png', fileName: 'shot.png' });
  assert.equal(uri, 'file:///cache/chat-export/shot.png');
  assert.equal(files.get(uri), 'PNGDATA');
  assert.equal(files.has('file:///tmp/cap-1.png'), false);
});

test('persistChatExportImage：移动失败清理目标', async () => {
  files.clear();
  fail.move = true;
  const mod = loadChatExport();
  try {
    await assert.rejects(() => mod.persistChatExportImage({ tmpUri: 'file:///tmp/x.png', fileName: 'y.png' }));
    assert.equal(files.has('file:///cache/chat-export/y.png'), false);
  } finally {
    fail.move = false;
  }
});

test('sweepChatExportFiles：只保留最近 keepNewest 个', async () => {
  files.clear();
  const mod = loadChatExport();
  for (let i = 0; i < 5; i += 1) files.set(`file:///cache/chat-export/f${i}.md`, 'x');
  const dropped = await mod.sweepChatExportFiles({ keepNewest: 2 });
  assert.equal(dropped, 3);
  const remaining = [...files.keys()].filter(k => k.startsWith('file:///cache/chat-export/')).sort();
  assert.deepEqual(remaining, ['file:///cache/chat-export/f3.md', 'file:///cache/chat-export/f4.md']);
});

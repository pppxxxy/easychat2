import test from 'node:test';
import assert from 'node:assert/strict';
import fsNode from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const presetEnv = require.resolve('@babel/preset-env');

const DOCUMENT_DIR = 'file:///documents/';
const files = new Map();
const deleted = [];
const moved = [];
const copied = [];
let downloadShouldFail = false;
let copyShouldFail = false;

const fsStub = {
  documentDirectory: DOCUMENT_DIR,
  cacheDirectory: 'file:///cache/',
  makeDirectoryAsync: async () => {},
  deleteAsync: async key => {
    deleted.push(key);
    files.delete(key);
  },
  getInfoAsync: async key => {
    if (files.has(key)) return { exists: true, size: files.get(key).size };
    if (key && String(key).endsWith('.download')) return { exists: true, size: 2048 };
    if (key && String(key).startsWith('content://')) return { exists: true, size: 4096 };
    return { exists: false };
  },
  createDownloadResumable: (url, temporary) => ({
    downloadAsync: async () => {
      if (downloadShouldFail) throw new Error('network down');
      files.set(temporary, { size: 2048 });
      return { uri: temporary };
    },
  }),
  moveAsync: async ({ from, to }) => {
    moved.push([from, to]);
    files.set(to, files.get(from) || { size: 2048 });
    files.delete(from);
  },
  copyAsync: async ({ from, to }) => {
    if (copyShouldFail) throw new Error('copy failed');
    copied.push([from, to]);
    files.set(to, { size: 4096 });
  },
};

const storage = {
  saved: [],
  saveLocalModelItem: async item => {
    storage.saved.push(item);
    return item;
  },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'expo-file-system/legacy') return fsStub;
  if (request === '../storage/localModels.js') return storage;
  return originalLoad.call(this, request, parent, isMain);
};

const modulePath = path.resolve('src/localModel/modelManager.js');
const compiled = babel.transformSync(fsNode.readFileSync(modulePath, 'utf8'), {
  babelrc: false,
  configFile: false,
  filename: modulePath,
  presets: [[presetEnv, { targets: { node: 'current' }, modules: 'commonjs' }]],
}).code;
const mod = new Module(modulePath);
mod.filename = modulePath;
mod.paths = Module._nodeModulePaths(path.dirname(modulePath));
mod._compile(compiled, modulePath);
const manager = mod.exports;

function reset() {
  files.clear();
  deleted.length = 0;
  moved.length = 0;
  copied.length = 0;
  storage.saved.length = 0;
  downloadShouldFail = false;
  copyShouldFail = false;
}

test('downloadLocalModel：下载落盘、推导量化与规模并登记索引', async () => {
  reset();
  const item = await manager.downloadLocalModel({
    modelId: 'Qwen2.5-1.5B-Instruct-Q4_K_M.gguf',
    modelName: 'Qwen2.5 1.5B',
    modelUrl: 'https://huggingface.co/Qwen/Qwen2.5-1.5B-GGUF/resolve/main/Qwen2.5-1.5B-Instruct-Q4_K_M.gguf',
    sourceId: 'huggingface',
    repoPath: 'Qwen/Qwen2.5-1.5B-GGUF',
  });
  assert.equal(storage.saved.length, 1);
  assert.equal(item.id, 'Qwen2.5-1.5B-Instruct-Q4_K_M');
  assert.equal(item.quant, 'Q4_K_M');
  assert.equal(item.paramSize, 1.5);
  assert.equal(item.imported, false);
  assert.equal(item.hasVision, false);
  assert.equal(item.modelPath, `${DOCUMENT_DIR}local-models/Qwen2.5-1.5B-Instruct-Q4_K_M.gguf`);
  assert.equal(files.get(item.modelPath).size, 2048);
  assert.equal(moved.length, 1);
});

test('downloadLocalModel：配套 mmproj 下载并标记多模态能力', async () => {
  reset();
  const item = await manager.downloadLocalModel({
    modelId: 'MiniCPM-V-Q4_K_M',
    modelName: 'MiniCPM-V',
    modelUrl: 'https://example.com/MiniCPM-V-Q4_K_M.gguf',
    mmprojUrl: 'https://example.com/mmproj-f16.gguf',
  });
  assert.equal(item.hasVision, true);
  assert.equal(item.mmprojPath, `${DOCUMENT_DIR}local-models/MiniCPM-V-Q4_K_M.mmproj.gguf`);
  assert.equal(files.has(item.mmprojPath), true);
  assert.ok(item.mmprojBytes > 0);
});

test('downloadLocalModel：下载失败不登记并清理临时文件', async () => {
  reset();
  downloadShouldFail = true;
  await assert.rejects(
    () => manager.downloadLocalModel({
      modelId: 'q4',
      modelUrl: 'https://example.com/q4.gguf',
    }),
    /network down/
  );
  assert.equal(storage.saved.length, 0);
  assert.ok(deleted.some(key => key.endsWith('q4.gguf.download')));
  assert.equal(files.has(`${DOCUMENT_DIR}local-models/q4.gguf`), false);
});

test('downloadLocalModel：登记失败回滚已落盘模型与 mmproj', async () => {
  reset();
  await assert.rejects(
    () => manager.downloadLocalModel({
      modelId: 'rollback',
      modelUrl: 'https://example.com/rollback.gguf',
      mmprojUrl: 'https://example.com/mmproj.gguf',
    }, { registerItem: async () => { throw new Error('index write failed'); } }),
    /index write failed/
  );
  assert.equal(files.has(`${DOCUMENT_DIR}local-models/rollback.gguf`), false);
  assert.equal(files.has(`${DOCUMENT_DIR}local-models/rollback.mmproj.gguf`), false);
});

test('downloadLocalModel：无效地址或空 id 直接拒绝', async () => {
  reset();
  await assert.rejects(() => manager.downloadLocalModel({ modelId: 'x', modelUrl: 'ftp://x' }), /有效的模型地址/);
  await assert.rejects(() => manager.downloadLocalModel({ modelUrl: 'https://example.com/' }), /有效的模型地址/);
});

test('importLocalModel：复制本地 GGUF 并以 imported 登记', async () => {
  reset();
  const item = await manager.importLocalModel({
    sourceUri: 'content://picked/Qwen-3B-Q5_K_M.gguf',
    name: 'Qwen 3B Q5_K_M',
  });
  assert.equal(storage.saved.length, 1);
  assert.equal(item.imported, true);
  assert.equal(item.id, 'Qwen-3B-Q5_K_M');
  assert.equal(item.quant, 'Q5_K_M');
  assert.equal(item.paramSize, 3);
  assert.equal(item.sourceId, 'local');
  assert.equal(item.modelPath, `${DOCUMENT_DIR}local-models/Qwen-3B-Q5_K_M.gguf`);
  assert.deepEqual(copied[0], ['content://picked/Qwen-3B-Q5_K_M.gguf', item.modelPath]);
});

test('importLocalModel：可附带 mmproj 并标记识图能力', async () => {
  reset();
  const item = await manager.importLocalModel({
    sourceUri: 'content://picked/model.gguf',
    name: 'Vision Model',
    mmprojSourceUri: 'content://picked/mmproj.gguf',
  });
  assert.equal(item.hasVision, true);
  assert.equal(item.mmprojPath, `${DOCUMENT_DIR}local-models/model.mmproj.gguf`);
  assert.equal(copied.length, 2);
});

test('importLocalModel：复制失败不登记并清理目标文件', async () => {
  reset();
  copyShouldFail = true;
  await assert.rejects(
    () => manager.importLocalModel({ sourceUri: 'content://picked/boom.gguf', name: 'boom' }),
    /copy failed/
  );
  assert.equal(storage.saved.length, 0);
  assert.equal(files.has(`${DOCUMENT_DIR}local-models/boom.gguf`), false);
});

test('importLocalModel：未选择文件时拒绝', async () => {
  reset();
  await assert.rejects(() => manager.importLocalModel({ name: 'x' }), /请选择要导入的 GGUF 文件/);
});

test('deleteLocalModel：删除模型与 mmproj，缺文件不报错', async () => {
  reset();
  files.set(`${DOCUMENT_DIR}local-models/a.gguf`, { size: 10 });
  files.set(`${DOCUMENT_DIR}local-models/a.mmproj.gguf`, { size: 5 });
  await manager.deleteLocalModel({
    modelPath: `${DOCUMENT_DIR}local-models/a.gguf`,
    mmprojPath: `${DOCUMENT_DIR}local-models/a.mmproj.gguf`,
  });
  assert.equal(files.has(`${DOCUMENT_DIR}local-models/a.gguf`), false);
  assert.equal(files.has(`${DOCUMENT_DIR}local-models/a.mmproj.gguf`), false);
  await manager.deleteLocalModel({ modelPath: `${DOCUMENT_DIR}local-models/missing.gguf` });
});

test('getLocalModelFileInfo：无路径返回不存在，有路径读文件信息', async () => {
  reset();
  assert.equal((await manager.getLocalModelFileInfo({})).exists, false);
  files.set(`${DOCUMENT_DIR}local-models/b.gguf`, { size: 7 });
  const info = await manager.getLocalModelFileInfo({ modelPath: `${DOCUMENT_DIR}local-models/b.gguf` });
  assert.equal(info.exists, true);
  assert.equal(info.size, 7);
});

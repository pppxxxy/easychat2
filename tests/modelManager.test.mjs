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
let httpStatus = 0;
let failMoveToOnce = null;

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
      return { uri: temporary, ...(httpStatus ? { status: httpStatus } : {}) };
    },
  }),
  moveAsync: async ({ from, to }) => {
    if (failMoveToOnce && to === failMoveToOnce) {
      failMoveToOnce = null;
      throw new Error('move failed');
    }
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
  httpStatus = 0;
  failMoveToOnce = null;
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
  // 导入先复制到暂存位（.import），经原子替换就位后暂存被清
  const staging = `${DOCUMENT_DIR}local-models/Qwen-3B-Q5_K_M.gguf.import`;
  assert.deepEqual(copied[0], ['content://picked/Qwen-3B-Q5_K_M.gguf', staging]);
  assert.equal(files.get(item.modelPath).size, 4096);
  assert.equal(files.has(staging), false);
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

test('downloadLocalModel：HTTP 4xx/5xx 的错误页不落位、不登记', async () => {
  reset();
  httpStatus = 404;
  await assert.rejects(
    () => manager.downloadLocalModel({ modelId: 'oops', modelUrl: 'https://example.com/oops.gguf' }),
    /HTTP 404/
  );
  assert.equal(storage.saved.length, 0);
  assert.equal(files.has(`${DOCUMENT_DIR}local-models/oops.gguf`), false);
  assert.equal(files.has(`${DOCUMENT_DIR}local-models/oops.gguf.download`), false, '临时文件应清理');
});

test('downloadLocalModel：替换失败时旧模型被恢复，不出现两头落空', async () => {
  reset();
  const destination = `${DOCUMENT_DIR}local-models/keep.gguf`;
  const backup = `${destination}.old`;
  files.set(destination, { size: 100 });
  failMoveToOnce = destination;
  await assert.rejects(
    () => manager.downloadLocalModel({ modelId: 'keep', modelUrl: 'https://example.com/keep.gguf' }),
    /move failed/
  );
  assert.equal(storage.saved.length, 0);
  assert.equal(files.get(destination).size, 100, '旧模型应原样恢复');
  assert.equal(files.has(backup), false, '备份应被回收');
  assert.equal(files.has(`${destination}.download`), false, '临时文件应清理');
});

test('importLocalModel：替换失败时旧模型被恢复', async () => {
  reset();
  const destination = `${DOCUMENT_DIR}local-models/keep2.gguf`;
  files.set(destination, { size: 100 });
  failMoveToOnce = destination;
  await assert.rejects(
    () => manager.importLocalModel({ sourceUri: 'content://picked/keep2.gguf', name: 'keep2' }),
    /move failed/
  );
  assert.equal(storage.saved.length, 0);
  assert.equal(files.get(destination).size, 100, '旧模型应原样恢复');
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

test('verifyDownloadedSize：大小强校验（无声明大小则放行）', () => {
  assert.deepEqual(manager.verifyDownloadedSize(2048, 2048), { ok: true, reason: '' });
  assert.deepEqual(manager.verifyDownloadedSize(2048, 0), { ok: true, reason: '' }, '未声明大小不判');
  assert.deepEqual(manager.verifyDownloadedSize(0, 0), { ok: true, reason: '' });
  const bad = manager.verifyDownloadedSize(1800, 2048);
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /下载不完整/);
});

test('downloadLocalModel：声明大小与实际不符 → 拒绝登记并清理临时文件', async () => {
  reset();
  await assert.rejects(
    () => manager.downloadLocalModel({
      modelId: 'q4-truncated',
      modelUrl: 'https://example.com/q4.gguf',
      modelExpectedBytes: 9999,
    }),
    error => error && error.code === 'INCOMPLETE_DOWNLOAD'
  );
  assert.equal(storage.saved.length, 0, '不登记残缺模型');
  assert.ok(
    deleted.some(key => String(key).endsWith('.download')),
    '临时下载文件必须清理'
  );
  assert.equal(files.has(`${DOCUMENT_DIR}local-models/q4-truncated.gguf`), false, '不得留下半成品目标文件');
});

test('downloadLocalModel：声明大小一致 → 正常登记', async () => {
  reset();
  const item = await manager.downloadLocalModel({
    modelId: 'q4-ok',
    modelUrl: 'https://example.com/q4.gguf',
    modelExpectedBytes: 2048,
  });
  assert.equal(storage.saved.length, 1);
  assert.equal(files.get(item.modelPath).size, 2048);
});

test('isOrphanLocalModelTempFile：只认中间产物后缀', () => {
  assert.equal(manager.isOrphanLocalModelTempFile('a.gguf.download'), true);
  assert.equal(manager.isOrphanLocalModelTempFile('a.gguf.old'), true);
  assert.equal(manager.isOrphanLocalModelTempFile('a.gguf.import'), true);
  assert.equal(manager.isOrphanLocalModelTempFile('a.gguf'), false);
  assert.equal(manager.isOrphanLocalModelTempFile('a.mmproj.gguf'), false);
});

test('cleanupOrphanLocalModelFiles：删除残留并统计释放空间', async () => {
  const removed = [];
  const fs = {
    documentDirectory: DOCUMENT_DIR,
    readDirectoryAsync: async () => ['keep.gguf', 'stale.gguf.download', 'old.gguf.old', 'imp.gguf.import'],
    getInfoAsync: async path => ({ exists: true, size: path.includes('stale') ? 100 : path.includes('old') ? 200 : 300 }),
    deleteAsync: async path => { removed.push(path); },
  };
  const result = await manager.cleanupOrphanLocalModelFiles({ fileSystem: fs });
  assert.equal(result.removed, 3);
  assert.equal(result.freedBytes, 600);
  assert.ok(removed.every(path => !path.endsWith('keep.gguf')), '不得删除正常模型文件');
});

// 工作区改动历史：记录构造/装饰器行为（纯）+ 存储域往返（babel + 桩，先例 locationStorage）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

import { buildBatchEntry, buildChangeEntry, createHistoryRecordingStore } from '../src/workspace/history.js';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const presetEnv = require.resolve('@babel/preset-env');

// ---------- 纯部分：记录构造 + 装饰器 ----------

test('buildChangeEntry：字段归一、截断与默认值', () => {
  const entry = buildChangeEntry(
    { op: 'edit', path: 'a/b.txt', find: 'x'.repeat(300), replace: 'y', count: 2, all: true, length: 42 },
    { now: 1700000000000, idFactory: () => 'chg-test' }
  );
  assert.equal(entry.id, 'chg-test');
  assert.equal(entry.at, 1700000000000);
  assert.equal(entry.op, 'edit');
  assert.equal(entry.path, 'a/b.txt');
  assert.equal(entry.find.length, 161, 'find 截断为 160 + 省略号');
  assert.equal(entry.replace, 'y');
  assert.equal(entry.count, 2);
  assert.equal(entry.all, true);
  assert.equal(entry.length, 42);
  // 未知 op 归一到 write；默认 id 形如 chg-<ts>-<seq>。
  const fallback = buildChangeEntry({ op: 'bogus' }, { now: 123 });
  assert.equal(fallback.op, 'write');
  assert.match(fallback.id, /^chg-123-\d+$/);
});

test('装饰器：写/改/删都记录；写失败不记录；记录失败不影响文件操作', async () => {
  const calls = [];
  let failNextWrite = false;
  const base = {
    rootKind: 'app',
    listWorkspaceFiles: async () => [],
    readWorkspaceFile: async () => ({ path: 'x.txt', content: '', truncated: false }),
    fileUri: async ({ path: p }) => (p === 'exists.txt' ? 'file:///ws/exists.txt' : null),
    writeWorkspaceFile: async ({ path: p, content }) => {
      if (failNextWrite) throw new Error('磁盘满了');
      return { path: p, length: String(content || '').length };
    },
    writeWorkspaceBinaryFile: async ({ path: p }) => ({ path: p, base64Length: 8 }),
    editWorkspaceFile: async ({ path: p }) => ({ path: p, count: 1, length: 5 }),
    deleteFile: async ({ path: p }) => ({ path: p, deleted: p !== 'missing.txt' }),
  };
  const store = createHistoryRecordingStore(base, {
    record: (characterId, entry) => { calls.push({ characterId, entry }); },
  });

  await store.writeWorkspaceFile({ characterId: 'c1', path: 'new.txt', content: '你好' });
  await store.writeWorkspaceFile({ characterId: 'c1', path: 'exists.txt', content: 'hi' });
  await store.writeWorkspaceBinaryFile({ characterId: 'c1', path: 'doc.docx', base64: 'AAAAAAAA' });
  await store.editWorkspaceFile({ characterId: 'c1', path: 'x.txt', find: 'a', replace: 'b', count: 1 });
  await store.deleteFile({ characterId: 'c1', path: 'x.txt' });
  await store.deleteFile({ characterId: 'c1', path: 'missing.txt' });

  assert.equal(calls.length, 5, '五个成功操作各记一条；删除不存在不记');
  assert.deepEqual(calls[0].entry.op, 'write');
  assert.equal(calls[0].entry.created, true, '探测不存在 → 新建');
  assert.equal(calls[0].characterId, 'c1');
  assert.equal(calls[1].entry.created, false, '探测存在 → 覆盖');
  assert.equal(calls[2].entry.base64Length, 8);
  assert.equal(calls[3].entry.op, 'edit');
  assert.equal(calls[3].entry.find, 'a');
  assert.equal(calls[4].entry.op, 'delete');

  // 写失败：不记录，且异常原样抛出（历史不掩盖真实错误）。
  failNextWrite = true;
  await assert.rejects(() => store.writeWorkspaceFile({ characterId: 'c1', path: 'bad.txt', content: 'x' }), /磁盘满了/);
  assert.equal(calls.length, 5, '失败操作不产生历史');

  // 记录函数抛错：文件操作照常成功。
  failNextWrite = false;
  const noisy = createHistoryRecordingStore(base, {
    record: () => { throw new Error('历史写崩了'); },
  });
  const written = await noisy.writeWorkspaceFile({ characterId: 'c1', path: 'ok.txt', content: 'ok' });
  assert.equal(written.length, 2, '记录失败绝不影响写入结果');
});

test('buildBatchEntry：op=import、count 归一、path 截断', () => {
  const entry = buildBatchEntry({ path: 'repos/a/b/main/', count: 12 }, { now: 5, idFactory: () => 'chg-b' });
  assert.equal(entry.op, 'import');
  assert.equal(entry.count, 12);
  assert.equal(entry.path, 'repos/a/b/main/');
  assert.equal(entry.id, 'chg-b');
  assert.equal(entry.at, 5);
  assert.equal(entry.length, 0);
});

test('批量导入：批内逐文件写只记一条汇总；abort 不记；批内跳过探测', async () => {
  const calls = [];
  let uriProbes = 0;
  const base = {
    fileUri: async () => { uriProbes += 1; return 'file:///ws/x'; },
    writeWorkspaceFile: async ({ path: p, content }) => ({ path: p, length: String(content || '').length }),
    deleteFile: async ({ path: p }) => ({ path: p, deleted: true }),
  };
  const store = createHistoryRecordingStore(base, {
    record: (characterId, entry) => { calls.push({ characterId, entry }); },
  });

  store.beginBatch('c1', { path: 'repos/a/b/main/' });
  await store.writeWorkspaceFile({ characterId: 'c1', path: 'repos/a/b/main/1.txt', content: 'x' });
  await store.writeWorkspaceFile({ characterId: 'c1', path: 'repos/a/b/main/2.txt', content: 'yy' });
  await store.deleteFile({ characterId: 'c1', path: 'repos/a/b/main/2.txt' });
  assert.equal(calls.length, 0, '批内不产生逐文件记录（含回滚删除）');
  assert.equal(uriProbes, 0, '批内跳过存在性探测');
  const done = store.endBatch();
  assert.equal(done.count, 2);
  assert.equal(calls.length, 1, '结束时只记一条汇总');
  assert.equal(calls[0].entry.op, 'import');
  assert.equal(calls[0].entry.count, 2);
  assert.equal(calls[0].entry.path, 'repos/a/b/main/');

  // 取消/回滚：abortBatch 什么都不记。
  store.beginBatch('c1', { path: 'repos/a/b/main/' });
  await store.writeWorkspaceFile({ characterId: 'c1', path: 'repos/a/b/main/3.txt', content: 'z' });
  store.abortBatch();
  assert.equal(calls.length, 1, 'abort 后仍只有那一条汇总');

  // 批结束后恢复逐条记录。
  await store.writeWorkspaceFile({ characterId: 'c1', path: 'solo.txt', content: 'k' });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].entry.op, 'write');
});

// ---------- 存储域：往返/上限/分区（AsyncStorage 桩） ----------

const store = new Map();
const AsyncStorage = {
  getItem: async key => (store.has(key) ? store.get(key) : null),
  setItem: async (key, value) => { store.set(key, value); },
  removeItem: async key => { store.delete(key); },
};
const ioStub = {
  readJson: async key => {
    const raw = await AsyncStorage.getItem(key);
    if (raw === null || raw === undefined) return null;
    try { return JSON.parse(raw); } catch (error) { return null; }
  },
  createMutationQueue: () => {
    let single = Promise.resolve();
    return {
      enqueue(task) {
        const next = single.then(task, task);
        single = next.catch(() => {});
        return next;
      },
    };
  },
  backupCorruptValue: async () => {},
  readJsonStatus: async () => ({ status: 'missing' }),
  readJsonStatusWithSecrets: async () => ({ status: 'missing' }),
  setJsonWithSecrets: async () => {},
};

function loadSourceModule(relativePath) {
  const sourcePath = path.resolve(relativePath);
  const transformed = babel.transformSync(fs.readFileSync(sourcePath, 'utf8'), {
    babelrc: false,
    configFile: false,
    filename: sourcePath,
    presets: [[presetEnv, { targets: { node: 'current' }, modules: 'commonjs' }]],
  }).code;
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === '@react-native-async-storage/async-storage') return AsyncStorage;
    if (request.endsWith('/io.js')) return ioStub;
    return originalLoad.call(this, request, parent, isMain);
  };
  const runtime = new Module(sourcePath);
  runtime.filename = sourcePath;
  runtime.paths = Module._nodeModulePaths(path.dirname(sourcePath));
  runtime._compile(transformed, sourcePath);
  Module._load = originalLoad;
  return runtime.exports;
}

const workspace = loadSourceModule('src/storage/workspace.js');

test('改动历史存储：追加（新的在前）、按角色分区、清空互不影响', async () => {
  store.clear();
  assert.deepEqual(await workspace.getWorkspaceChanges('c1'), []);

  await workspace.appendWorkspaceChange('c1', { op: 'write', path: 'a.txt', length: 3, at: 100 });
  await workspace.appendWorkspaceChange('c1', { op: 'edit', path: 'a.txt', find: 'x', replace: 'y', count: 1, at: 200 });
  await workspace.appendWorkspaceChange('c2', { op: 'write', path: 'b.txt', at: 300 });

  const c1 = await workspace.getWorkspaceChanges('c1');
  assert.equal(c1.length, 2);
  assert.equal(c1[0].at, 200, '新的在前');
  assert.equal(c1[1].op, 'write');
  assert.equal((await workspace.getWorkspaceChanges('c2')).length, 1, '按角色分区');

  const removed = await workspace.clearWorkspaceChanges('c1');
  assert.equal(removed, 2);
  assert.deepEqual(await workspace.getWorkspaceChanges('c1'), []);
  assert.equal((await workspace.getWorkspaceChanges('c2')).length, 1, '清空一个角色不影响另一个');
});

test('改动历史存储：import 汇总条目可往返（op 不被归一成 write）', async () => {
  store.clear();
  await workspace.appendWorkspaceChange('imp', { op: 'import', path: 'repos/a/b/main/', count: 7, at: 10 });
  const list = await workspace.getWorkspaceChanges('imp');
  assert.equal(list.length, 1);
  assert.equal(list[0].op, 'import');
  assert.equal(list[0].count, 7);
  assert.equal(list[0].path, 'repos/a/b/main/');
});

test('改动历史存储：每角色上限裁剪（只保留最近 WORKSPACE_CHANGE_LIMIT 条）', async () => {
  store.clear();
  const total = workspace.WORKSPACE_CHANGE_LIMIT + 5;
  for (let i = 0; i < total; i += 1) {
    await workspace.appendWorkspaceChange('cap', { op: 'write', path: `f${i}.txt`, at: i + 1 });
  }
  const list = await workspace.getWorkspaceChanges('cap');
  assert.equal(list.length, workspace.WORKSPACE_CHANGE_LIMIT, '超出上限被裁剪');
  assert.equal(list[0].at, total, '保留的是最新的那条');
  assert.equal(list[list.length - 1].at, total - workspace.WORKSPACE_CHANGE_LIMIT + 1, '最旧的被丢弃');
});
test('仓库清单快照：按角色+仓库分区往返，非法值归一', async () => {
  store.clear();
  assert.equal(await workspace.getRepoSnapshot('c1', 'o/r/main'), null, '没有快照返回 null');

  await workspace.setRepoSnapshot('c1', 'o/r/main', { paths: ['a.js', 'src/b.js'], at: 123 });
  const snap = await workspace.getRepoSnapshot('c1', 'o/r/main');
  assert.deepEqual(snap, { at: 123, paths: ['a.js', 'src/b.js'] });
  assert.equal(await workspace.getRepoSnapshot('c1', 'o/other/main'), null, '仓库之间互不影响');
  assert.equal(await workspace.getRepoSnapshot('c2', 'o/r/main'), null, '角色之间互不影响');

  // 覆盖写：同一仓库再次拉取/推送后基线更新。
  await workspace.setRepoSnapshot('c1', 'o/r/main', { paths: ['only.js'], at: 456 });
  assert.deepEqual((await workspace.getRepoSnapshot('c1', 'o/r/main')).paths, ['only.js']);

  // 非法输入：空 id 直接忽略，不写脏数据。
  assert.equal(await workspace.setRepoSnapshot('', 'o/r/main', { paths: ['x'] }), null);
  assert.equal(await workspace.getRepoSnapshot('c1', ''), null);
});

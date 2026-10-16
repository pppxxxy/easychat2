// AC12 P0-1：单层列举（depth）专项测试。
// 病根：FilesPanel 每次 refresh 都全树 walk（每 entry 一次 getInfo 原生调用），
// 大项目下打开文件面板就卡十几秒。止血：列表支持 depth:1 单层，面板按下钻加载。
// 本文件钉住两个后端（legacy store.js / SAF safStore.js）的单层语义，
// 并守住「不传 depth 时行为与从前完全一致」这条兼容底线（既有调用方全靠它）。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { listWorkspaceFiles } from '../src/workspace/store.js';
import { writeWorkspaceFile } from '../src/workspace/store.js';
import { createSafWorkspaceStore } from '../src/workspace/safStore.js';

// ── 内存 fileSystem（与 workspaceStore.test.mjs 同款约定）──────────────
function createMemoryFs() {
  const entries = new Map();
  const api = {
    documentDirectory: '/doc/',
    async getInfoAsync(uri) {
      const key = entries.has(uri) ? uri : (entries.has(`${uri}/`) ? `${uri}/` : null);
      if (!key) return { exists: false };
      return { exists: true, isDirectory: entries.get(key).type === 'dir' };
    },
    async makeDirectoryAsync(uri, options) {
      const full = uri.endsWith('/') ? uri : `${uri}/`;
      if (options && options.intermediates) {
        let acc = '';
        for (const part of full.split('/').filter(Boolean)) {
          acc += `/${part}`;
          entries.set(`${acc}/`, { type: 'dir' });
        }
        return;
      }
      entries.set(full, { type: 'dir' });
    },
    async readDirectoryAsync(uri) {
      const prefix = uri.endsWith('/') ? uri : `${uri}/`;
      if (!entries.has(prefix)) throw new Error('ENOENT');
      const names = new Set();
      for (const key of entries.keys()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length).replace(/\/$/, '');
        if (!rest) continue;
        names.add(rest.split('/')[0]);
      }
      return [...names];
    },
    async readAsStringAsync(uri) {
      const entry = entries.get(uri);
      if (!entry || entry.type !== 'file') throw new Error('ENOENT');
      return entry.content;
    },
    async writeAsStringAsync(uri, text) {
      entries.set(uri, { type: 'file', content: String(text) });
    },
    seedFile(uri, content) {
      api.makeDirectoryAsync(uri.slice(0, uri.lastIndexOf('/') + 1), { intermediates: true });
      entries.set(uri, { type: 'file', content });
    },
    async deleteAsync(uri, options) {
      const full = uri.endsWith('/') ? uri : `${uri}/`;
      const found = entries.has(uri) || entries.has(full);
      if (!found && !(options && options.idempotent)) throw new Error('ENOENT');
      entries.delete(uri);
      entries.delete(full);
    },
  };
  return api;
}

const root = '/doc/workspace/';

async function seedTree() {
  const fileSystem = createMemoryFs();
  await writeWorkspaceFile({ root, characterId: 'c1', path: 'f1.txt', content: 'a', fileSystem });
  await writeWorkspaceFile({ root, characterId: 'c1', path: 'a/b/f2.txt', content: 'b', fileSystem });
  await writeWorkspaceFile({ root, characterId: 'c1', path: 'a/b/c/f3.txt', content: 'c', fileSystem });
  return fileSystem;
}

// ── legacy 后端 ──────────────────────────────────────────────────────

test('AC12 P0-1 legacy：depth:1 只列当前层（目录带斜杠、不递归）', async () => {
  const fileSystem = await seedTree();
  const files = await listWorkspaceFiles({ root, characterId: 'c1', fileSystem, depth: 1 });
  assert.deepEqual(files, ['a/', 'f1.txt']);
});

test('AC12 P0-1 legacy：depth:1 + subdir 只列该层', async () => {
  const fileSystem = await seedTree();
  const files = await listWorkspaceFiles({ root, characterId: 'c1', fileSystem, subdir: 'a/b', depth: 1 });
  assert.deepEqual(files, ['a/b/c/', 'a/b/f2.txt']);
});

test('AC12 P0-1 legacy：不传 depth = 全量（兼容底线，既有调用方不受影响）', async () => {
  const fileSystem = await seedTree();
  const files = await listWorkspaceFiles({ root, characterId: 'c1', fileSystem });
  assert.deepEqual(files, ['a/', 'a/b/', 'a/b/c/', 'a/b/c/f3.txt', 'a/b/f2.txt', 'f1.txt']);
});

test('AC12 P0-1 legacy：depth 传垃圾值按 1 兜底（不 NaN、不放大）', async () => {
  const fileSystem = await seedTree();
  const files = await listWorkspaceFiles({ root, characterId: 'c1', fileSystem, depth: 'garbage' });
  assert.deepEqual(files, ['a/', 'f1.txt']);
});

// ── SAF 后端（节点树 adapter，与 workspaceSafStore.test.mjs 的 createFakeSaf 同款）──────
// SAF 的 uri 由 adapter（DocumentFile）分配，不能拼字符串——节点树才还原真实语义。

const SAF_ROOT = 'content://tree/primary%3ADocs';

function createFakeSaf() {
  const nodes = new Map();
  let counter = 0;
  function seed(uri, name, isDirectory) {
    nodes.set(uri, { uri, name, isDirectory });
    return uri;
  }
  seed(SAF_ROOT, 'Docs', true);
  return {
    nodes,
    seed,
    async listChildren(uri) {
      const node = nodes.get(uri);
      if (!node || !node.isDirectory) throw new Error('not a directory');
      const prefix = `${uri}/`;
      return [...nodes.values()].filter(entry => (
        entry.uri.startsWith(prefix) && !entry.uri.slice(prefix.length).includes('/')
      ));
    },
    async createDirectory(parentUri, name) {
      counter += 1;
      return seed(`${parentUri}/dir-${counter}`, name, true);
    },
    async createFile(parentUri, name, mimeType) {
      counter += 1;
      const uri = `${parentUri}/file-${counter}`;
      seed(uri, name, false);
      nodes.get(uri).mimeType = mimeType;
      nodes.get(uri).content = '';
      return uri;
    },
    async readText(uri) {
      const node = nodes.get(uri);
      if (!node || node.isDirectory) throw new Error('not a file');
      return node.content;
    },
    async writeText(uri, text) {
      const node = nodes.get(uri);
      if (!node || node.isDirectory) throw new Error('not a file');
      node.content = String(text);
    },
    async writeBase64() {},
    async delete() {},
  };
}

async function seedSafTree() {
  const adapter = createFakeSaf();
  const store = createSafWorkspaceStore({ root: SAF_ROOT, adapter });
  await store.writeWorkspaceFile({ characterId: 'c1', path: 'f1.txt', content: 'a' });
  await store.writeWorkspaceFile({ characterId: 'c1', path: 'a/b/f2.txt', content: 'b' });
  await store.writeWorkspaceFile({ characterId: 'c1', path: 'a/b/c/f3.txt', content: 'c' });
  return { store, adapter };
}

test('AC12 P0-1 SAF：depth:1 只列当前层', async () => {
  const { store } = await seedSafTree();
  const files = await store.listWorkspaceFiles({ characterId: 'c1', depth: 1 });
  assert.deepEqual(files, ['a/', 'f1.txt']);
});

test('AC12 P0-1 SAF：depth:1 + subdir 只列该层', async () => {
  const { store } = await seedSafTree();
  const files = await store.listWorkspaceFiles({ characterId: 'c1', subdir: 'a/b', depth: 1 });
  assert.deepEqual(files, ['a/b/c/', 'a/b/f2.txt']);
});

test('AC12 P0-1 SAF：不传 depth = 全量（兼容底线）', async () => {
  const { store } = await seedSafTree();
  const files = await store.listWorkspaceFiles({ characterId: 'c1' });
  assert.deepEqual(files, ['a/', 'a/b/', 'a/b/c/', 'a/b/c/f3.txt', 'a/b/f2.txt', 'f1.txt']);
});

// ── FilesPanel 单层加载接线（源码断言，AC12 P0-1）─────────────────────
// FilesPanel.js 是 JSX 模块，Node 进不去（仓库先例：workspacePanel.test.mjs 的
// readSource 模式）。mergeListing 的行为由 store 侧单层语义 + 下列接线断言共同钉住。

import fs from 'node:fs';
import path from 'node:path';

function readSource(relativePath) {
  return fs.readFileSync(path.resolve(relativePath), 'utf8');
}

test('AC12 P0-1 FilesPanel：单层加载接线完整', () => {
  const source = readSource('src/workspace/screen/FilesPanel.js');
  assert.ok(source.includes('depth: 1'), '列表按 depth:1 单层请求');
  assert.ok(source.includes('mergeListing(prev, list, scope)'), '单层结果并入已见清单');
  assert.ok(source.includes('enterDir'), '目录导航统一走 enterDir（切层 + 加载该层）');
  // FEAT-AC12 P1：搜索的「全量拉取」与「清单还原」接线随防抖一起收进了
  // useWorkspaceFileSearch.js（防抖判据在 fileSearchDebounce.js）。判据不变
  // ——搜索仍必须触发全量拉取、切角色仍必须作废全量标记——只是调用点搬了家。
  // 两个文件合读，避免「搬家=断言空转」。
  const searchHook = readSource('src/workspace/screen/useWorkspaceFileSearch.js');
  assert.ok(searchHook.includes('full: true'), '搜索触发全量拉取（window 结束后）');
  assert.ok(source.includes('filesRef.current.full = false'), '切角色/重开面板重置全量标记');
});

// ── 缓存键含 depth（与 b8ddbfa listCache 的叠加点，P0-1 补充）──────────
// 事故形态：FilesPanel 先请求单层（depth:1）→ 缓存；聊天工具 list_workspace_files
// 不带 depth（全量语义）→ 若键不含 depth 会命中单层清单 → 模型把不完整清单当
// 完整事实推理（G1.7）。此测试钉住两者互不污染、各自缓存。
test('AC12 P0-1 缓存键含 depth：单层与全量互不污染', async () => {
  const { createListCachingStore } = await import('../src/workspace/listCache.js');
  let loads = 0;
  const calls = [];
  const base = {
    async listWorkspaceFilesWithMeta(args = {}) {
      loads += 1;
      calls.push(args.depth);
      return args.depth === 1
        ? { files: ['a/'], truncated: false }            // 单层：只报目录
        : { files: ['a/', 'a/f1.txt', 'a/b/f2.txt'], truncated: false }; // 全量
    },
    // 写路径桩：装饰器包装它做缓存失效，本身不需要真写。
    async writeWorkspaceFile() { return { path: 'new.txt', length: 1 }; },
  };
  const store = createListCachingStore(base, { rootKey: 'app:private' });

  const single = await store.listWorkspaceFiles({ characterId: 'c1', depth: 1 });
  assert.deepEqual(single, ['a/'], '单层请求返回单层结果');

  // 关键断言：全量请求不得命中单层缓存。
  const full = await store.listWorkspaceFiles({ characterId: 'c1' });
  assert.deepEqual(full, ['a/', 'a/f1.txt', 'a/b/f2.txt'], '全量请求必须真实遍历（不吃单层缓存）');
  assert.equal(loads, 2, '两次不同语义各算一次');

  // 各自缓存：同语义重复请求 0 次新增遍历。
  await store.listWorkspaceFiles({ characterId: 'c1', depth: 1 });
  await store.listWorkspaceFiles({ characterId: 'c1' });
  assert.equal(loads, 2, '同语义重复请求命中各自缓存');

  // 写操作后两个语义都失效（写后失效不区分 depth——目录内容变了都该重算）。
  await store.writeWorkspaceFile({ characterId: 'c1', path: 'new.txt', content: 'x' });
  await store.listWorkspaceFiles({ characterId: 'c1' });
  assert.equal(loads, 3, '写后全量重算');
  assert.deepEqual(calls, [1, undefined, undefined], 'depth 语义透传到底层 store');
});

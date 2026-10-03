import test from 'node:test';
import assert from 'node:assert/strict';

import {
  listWorkspaceFiles,
  readWorkspaceFile,
  writeWorkspaceFile,
} from '../src/workspace/store.js';

function createMemoryFs() {
  const entries = new Map();
  const api = {
    documentDirectory: '/doc/',
    async getInfoAsync(uri) {
      const key = entries.has(uri) ? uri : (entries.has(`${uri}/`) ? `${uri}/` : null);
      if (!key) return { exists: false };
      return { exists: true, isDirectory: entries.get(key).type === 'dir' };
    },
    async makeDirectoryAsync(uri) {
      entries.set(uri.endsWith('/') ? uri : `${uri}/`, { type: 'dir' });
    },
    async readDirectoryAsync(uri) {
      const prefix = uri.endsWith('/') ? uri : `${uri}/`;
      const names = new Set();
      for (const key of entries.keys()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length).replace(/\/$/, '');
        if (!rest) continue;
        names.add(rest.split('/')[0]);
      }
      if (names.size === 0) throw new Error('ENOENT');
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
      api.makeDirectoryAsync(uri.slice(0, uri.lastIndexOf('/') + 1));
      entries.set(uri, { type: 'file', content });
    },
  };
  return api;
}

const root = '/doc/workspace/';

test('write→read 往返并自动建目录', async () => {
  const fileSystem = createMemoryFs();
  const written = await writeWorkspaceFile({
    root, characterId: 'c1', path: 'notes/a.md', content: '# 标题', fileSystem,
  });
  assert.deepEqual(written, { path: 'notes/a.md', length: 4 });
  const read = await readWorkspaceFile({ root, characterId: 'c1', path: 'notes/a.md', fileSystem });
  assert.deepEqual(read, { path: 'notes/a.md', content: '# 标题', truncated: false });
});

test('list 递归、目录标记 /、过滤非白名单扩展名', async () => {
  const fileSystem = createMemoryFs();
  await writeWorkspaceFile({ root, characterId: 'c1', path: 'a.txt', content: 'a', fileSystem });
  await writeWorkspaceFile({ root, characterId: 'c1', path: 'sub/b.md', content: 'b', fileSystem });
  fileSystem.seedFile('/doc/workspace/c1/sub/c.png', 'binary');
  const files = await listWorkspaceFiles({ root, characterId: 'c1', fileSystem });
  assert.deepEqual(files, ['a.txt', 'sub/', 'sub/b.md']);
});

test('list 指定 subdir 只列该子树', async () => {
  const fileSystem = createMemoryFs();
  await writeWorkspaceFile({ root, characterId: 'c1', path: 'sub/b.md', content: 'b', fileSystem });
  const files = await listWorkspaceFiles({ root, characterId: 'c1', fileSystem, subdir: 'sub' });
  assert.deepEqual(files, ['sub/b.md']);
});

test('list 不存在的沙盒返回空数组', async () => {
  const fileSystem = createMemoryFs();
  assert.deepEqual(await listWorkspaceFiles({ root, characterId: 'nobody', fileSystem }), []);
});

test('read 缺失/目录/越界/非白名单均抛错', async () => {
  const fileSystem = createMemoryFs();
  await assert.rejects(
    readWorkspaceFile({ root, characterId: 'c1', path: 'missing.txt', fileSystem }),
    /文件不存在/,
  );
  await assert.rejects(
    readWorkspaceFile({ root, characterId: 'c1', path: 'a.png', fileSystem }),
    /只支持纯文本与 Markdown/,
  );
  await assert.rejects(
    readWorkspaceFile({ root, characterId: 'c1', path: '../x.txt', fileSystem }),
    /越出工作区/,
  );
});

test('write 拒绝越界与非白名单扩展名', async () => {
  const fileSystem = createMemoryFs();
  await assert.rejects(
    writeWorkspaceFile({ root, characterId: 'c1', path: '../x.txt', content: 'x', fileSystem }),
    /越出工作区/,
  );
  await assert.rejects(
    writeWorkspaceFile({ root, characterId: 'c1', path: 'a.png', content: 'x', fileSystem }),
    /只支持纯文本与 Markdown/,
  );
});

test('read 超过 maxChars 时截断', async () => {
  const fileSystem = createMemoryFs();
  await writeWorkspaceFile({ root, characterId: 'c1', path: 'a.txt', content: '0123456789', fileSystem });
  const read = await readWorkspaceFile({ root, characterId: 'c1', path: 'a.txt', fileSystem, maxChars: 4 });
  assert.deepEqual(read, { path: 'a.txt', content: '0123', truncated: true });
});

test('缺少 fileSystem 注入时抛错', async () => {
  await assert.rejects(
    listWorkspaceFiles({ root, characterId: 'c1' }),
    /缺少 fileSystem 注入/,
  );
});
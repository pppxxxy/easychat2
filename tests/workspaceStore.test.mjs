import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createWorkspaceDirectory,
  listWorkspaceFiles,
  readWorkspaceFile,
  writeWorkspaceBinaryFile,
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
    async makeDirectoryAsync(uri, options) {
      const full = uri.endsWith('/') ? uri : `${uri}/`;
      if (options && options.intermediates) {
        // 真实 expo makeDirectoryAsync({intermediates:true}) 会把每一级父目录都建出来。
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
    /只能读写文本文件/,
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
    /只能读写文本文件/,
  );
});

test('read 超过 maxChars 时截断', async () => {
  const fileSystem = createMemoryFs();
  await writeWorkspaceFile({ root, characterId: 'c1', path: 'a.txt', content: '0123456789', fileSystem });
  const read = await readWorkspaceFile({ root, characterId: 'c1', path: 'a.txt', fileSystem, maxChars: 4 });
  assert.deepEqual(read, { path: 'a.txt', content: '0123', truncated: true });
});

test('二进制写入 .docx 可被 list 看到，但 read 拒绝', async () => {
  const fileSystem = createMemoryFs();
  const written = await writeWorkspaceBinaryFile({
    root, characterId: 'c1', path: 'report.docx', base64: 'UEsDBAo=', fileSystem,
  });
  assert.deepEqual(written, { path: 'report.docx', base64Length: 8 });
  const files = await listWorkspaceFiles({ root, characterId: 'c1', fileSystem });
  assert.deepEqual(files, ['report.docx']);
  await assert.rejects(
    readWorkspaceFile({ root, characterId: 'c1', path: 'report.docx', fileSystem }),
    /只能读写文本文件/,
  );
});

test('缺少 fileSystem 注入时抛错', async () => {
  await assert.rejects(
    listWorkspaceFiles({ root, characterId: 'c1' }),
    /缺少 fileSystem 注入/,
  );
});
test('createWorkspaceDirectory：建多级目录、可被 list 看到、幂等', async () => {
  const fileSystem = createMemoryFs();
  const first = await createWorkspaceDirectory({ root, characterId: 'c1', path: 'src/components', fileSystem });
  assert.equal(first.path, 'src/components/');
  assert.equal(first.created, true);
  const again = await createWorkspaceDirectory({ root, characterId: 'c1', path: 'src/components', fileSystem });
  assert.equal(again.created, false, '重复创建是幂等的');
  const files = await listWorkspaceFiles({ root, characterId: 'c1', fileSystem });
  assert.ok(files.includes('src/'));
  assert.ok(files.includes('src/components/'));
});

test('createWorkspaceDirectory：越界路径被拒绝', async () => {
  const fileSystem = createMemoryFs();
  await assert.rejects(
    createWorkspaceDirectory({ root, characterId: 'c1', path: '../evil', fileSystem }),
    /越出工作区/,
  );
});

test('项目文件：源码扩展名可写可读可列（不再只限 txt/md）', async () => {
  const fileSystem = createMemoryFs();
  await writeWorkspaceFile({ root, characterId: 'c1', path: 'src/app.js', content: 'console.log(1)', fileSystem });
  await writeWorkspaceFile({ root, characterId: 'c1', path: 'index.html', content: '<h1>hi</h1>', fileSystem });
  const files = await listWorkspaceFiles({ root, characterId: 'c1', fileSystem });
  assert.ok(files.includes('src/app.js'));
  assert.ok(files.includes('index.html'));
  const read = await readWorkspaceFile({ root, characterId: 'c1', path: 'src/app.js', fileSystem });
  assert.equal(read.content, 'console.log(1)');
});

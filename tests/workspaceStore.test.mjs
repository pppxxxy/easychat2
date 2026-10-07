import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createWorkspaceDirectory,
  moveWorkspaceDirectory,
  editWorkspaceFile,
  listWorkspaceFiles,
  readWorkspaceFile,
  WORKSPACE_LIMITS,
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
    async moveAsync({ from, to }) {
      const fromPrefix = from.endsWith('/') ? from : `${from}/`;
      const toPrefix = to.endsWith('/') ? to : `${to}/`;
      const moves = [];
      for (const [key, value] of entries.entries()) {
        if (key === from) moves.push([key, to, value]);
        else if (key.startsWith(fromPrefix)) moves.push([key, `${toPrefix}${key.slice(fromPrefix.length)}`, value]);
      }
      if (moves.length === 0) throw new Error('ENOENT');
      for (const [key] of moves) entries.delete(key);
      for (const [, target, value] of moves) entries.set(target, value);
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
  assert.deepEqual(read, { path: 'notes/a.md', content: '# 标题', truncated: false, offset: 0, total: 4 });
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
  assert.deepEqual(read, { path: 'a.txt', content: '0123', truncated: true, offset: 0, total: 10, nextOffset: 4 });
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

test('write：父路径被同名文件占用时给出明确错误，不裸奔 ENOTDIR', async () => {
  const fileSystem = {
    async getInfoAsync(uri) {
      if (uri === `${root}c1/notes/`) return { exists: true, isDirectory: false };
      if (uri === `${root}c1/`) return { exists: true, isDirectory: true };
      return { exists: false };
    },
    async makeDirectoryAsync() { throw new Error('父路径被占用时不该尝试建目录'); },
    async writeAsStringAsync() { throw new Error('父路径被占用时不该写入'); },
    async readAsStringAsync() { throw new Error('不该读'); },
  };
  await assert.rejects(
    writeWorkspaceFile({ root, characterId: 'c1', path: 'notes/a.md', content: 'x', fileSystem }),
    /已被同名文件占用/,
  );
});

test('list：深路径文件不再被 MAX_DEPTH 藏掉（6 → 12）', async () => {
  const fileSystem = createMemoryFs();
  const deep = 'repos/demo/main/src/i18n/locales/zh-CN/app.js';
  await writeWorkspaceFile({ root, characterId: 'c1', path: deep, content: 'export default {}', fileSystem });
  const files = await listWorkspaceFiles({ root, characterId: 'c1', fileSystem });
  assert.ok(files.includes(deep), '8 段深的真实项目路径必须可见');
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

test('read 分段：offset/limit 与 nextOffset；越界 offset 归一到末尾', async () => {
  const fileSystem = createMemoryFs();
  await writeWorkspaceFile({ root, characterId: 'c1', path: 'big.txt', content: '0123456789', fileSystem });
  const head = await readWorkspaceFile({ root, characterId: 'c1', path: 'big.txt', fileSystem, maxChars: 4 });
  assert.deepEqual(head, { path: 'big.txt', content: '0123', truncated: true, offset: 0, total: 10, nextOffset: 4 });
  const tail = await readWorkspaceFile({ root, characterId: 'c1', path: 'big.txt', fileSystem, offset: 8, maxChars: 4 });
  assert.deepEqual(tail, { path: 'big.txt', content: '89', truncated: false, offset: 8, total: 10 });
  const beyond = await readWorkspaceFile({ root, characterId: 'c1', path: 'big.txt', fileSystem, offset: 999 });
  assert.deepEqual(beyond, { path: 'big.txt', content: '', truncated: false, offset: 10, total: 10 });
});

test('edit 守卫：超过读上限的文件可完整编辑；超过编辑上限明确拒绝且不落盘', async () => {
  const fileSystem = createMemoryFs();
  // 1MB+ 的文件：旧实现会带着截断内容回写、静默砍掉尾部——这里钉住完整编辑。
  const mid = `${'a'.repeat(1024 * 1024 + 10)}TAIL`;
  await writeWorkspaceFile({ root, characterId: 'c1', path: 'mid.txt', content: mid, fileSystem });
  const edited = await editWorkspaceFile({ root, characterId: 'c1', path: 'mid.txt', find: 'TAIL', replace: 'DONE', fileSystem });
  assert.equal(edited.count, 1);
  const after = await fileSystem.readAsStringAsync(`${root}c1/mid.txt`);
  assert.ok(after.endsWith('DONE'), '替换必须生效');
  assert.equal(after.length, mid.length, '尾部不得被截断（长度守恒）');

  // 超过编辑上限：拒绝，且文件原样未动。
  const huge = 'b'.repeat(WORKSPACE_LIMITS.MAX_EDIT_CHARS + 1);
  await writeWorkspaceFile({ root, characterId: 'c1', path: 'huge.txt', content: huge, fileSystem });
  await assert.rejects(
    editWorkspaceFile({ root, characterId: 'c1', path: 'huge.txt', find: 'b', replace: 'c', fileSystem }),
    /文件过大/
  );
  const untouched = await fileSystem.readAsStringAsync(`${root}c1/huge.txt`);
  assert.equal(untouched.length, huge.length, '拒绝后文件必须原样未动');
});
test('moveWorkspaceDirectory：目录改名（重命名仓库同步本地副本）', async () => {
  const fileSystem = createMemoryFs();
  await writeWorkspaceFile({ root, characterId: 'c1', path: 'repos/o/old/main/a.js', content: 'a', fileSystem });
  await writeWorkspaceFile({ root, characterId: 'c1', path: 'repos/o/old/main/src/b.js', content: 'b', fileSystem });

  const moved = await moveWorkspaceDirectory({
    root, characterId: 'c1', from: 'repos/o/old', to: 'repos/o/renamed', fileSystem,
  });
  assert.deepEqual(moved, { from: 'repos/o/old', to: 'repos/o/renamed', moved: true });
  const files = await listWorkspaceFiles({ root, characterId: 'c1', fileSystem });
  assert.ok(files.includes('repos/o/renamed/main/a.js'), '文件跟到新目录');
  assert.ok(files.includes('repos/o/renamed/main/src/b.js'), '子目录结构保留');
  assert.ok(!files.some(name => name.startsWith('repos/o/old/')), '旧目录已不在');

  // 源不存在：moved:false，不报错。
  const missing = await moveWorkspaceDirectory({
    root, characterId: 'c1', from: 'repos/o/nope', to: 'repos/o/x', fileSystem,
  });
  assert.equal(missing.moved, false);

  // 目标已存在：拒绝覆盖。
  await writeWorkspaceFile({ root, characterId: 'c1', path: 'repos/o/taken/main/c.js', content: 'c', fileSystem });
  await assert.rejects(
    moveWorkspaceDirectory({ root, characterId: 'c1', from: 'repos/o/renamed', to: 'repos/o/taken', fileSystem }),
    /已存在/,
  );
  // 源是文件：明确拒绝。
  await assert.rejects(
    moveWorkspaceDirectory({ root, characterId: 'c1', from: 'repos/o/taken/main/c.js', to: 'repos/o/moved.js', fileSystem }),
    /不是目录/,
  );
});

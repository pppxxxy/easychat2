// 外部根（SAF）后端：用假 adapter 跑通建目录/建文件/读/写/替换/越界拒绝。
//
// 这条测试的价值在于钉住「content:// 不能靠字符串拼接」这个前提：假 adapter 只认
// uri 与显示名，任何试图用 `父uri + '/' + 名字` 造子路径的实现都会因为找不到目录而失败。

import test from 'node:test';
import assert from 'node:assert/strict';

import { createSafWorkspaceStore } from '../src/workspace/safStore.js';
import { createExpoSafAdapter } from '../src/workspace/safStore.js';

const ROOT = 'content://tree/primary%3ADocs';

// 假 SAF：目录树以「完整 uri → 记录」保存，listChildren 只认 uri 精确匹配，
// 与真实 DocumentFile 的行为一致（不存在「拼字符串就能找到」这回事）。
function createFakeSaf() {
  const nodes = new Map();
  let counter = 0;

  function seed(uri, name, isDirectory) {
    nodes.set(uri, { uri, name, isDirectory });
    return uri;
  }

  // 根目录本身也要存在
  seed(ROOT, 'Docs', true);

  const api = {
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
      if (!nodes.has(parentUri)) throw new Error(`missing parent ${parentUri}`);
      counter += 1;
      return seed(`${parentUri}/dir-${counter}`, name, true);
    },
    async createFile(parentUri, name, mimeType) {
      if (!nodes.has(parentUri)) throw new Error(`missing parent ${parentUri}`);
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
    async writeBase64(uri, base64) {
      const node = nodes.get(uri);
      if (!node || node.isDirectory) throw new Error('not a file');
      node.content = `b64:${base64}`;
    },
    async delete(uri) {
      const node = nodes.get(uri);
      if (!node) throw new Error('missing');
      nodes.delete(uri);
    },
  };
  return api;
}

test('写入会逐级建目录与文件，uri 由 adapter 决定（不拼字符串）', async () => {
  const adapter = createFakeSaf();
  const store = createSafWorkspaceStore({ root: ROOT, adapter });
  const result = await store.writeWorkspaceFile({ characterId: 'c1', path: 'notes/a.md', content: '你好' });
  assert.deepEqual(result, { path: 'notes/a.md', length: 2 });

  // 角色目录 + notes 目录都是 createDirectory 建的，名字对得上
  const names = [...adapter.nodes.values()].map(node => node.name);
  assert.ok(names.includes('c1'), '角色子目录要建在外部根之下');
  assert.ok(names.includes('notes'), '中间目录要逐级建出来');
  const file = [...adapter.nodes.values()].find(node => node.name === 'a.md');
  assert.ok(file && !file.isDirectory);
  assert.equal(file.content, '你好');
  assert.equal(file.mimeType, 'text/plain');
});

test('读回与列目录：目录带 /、非白名单扩展名不出现', async () => {
  const adapter = createFakeSaf();
  const store = createSafWorkspaceStore({ root: ROOT, adapter });
  await store.writeWorkspaceFile({ characterId: 'c1', path: 'a.txt', content: 'a' });
  await store.writeWorkspaceFile({ characterId: 'c1', path: 'sub/b.md', content: 'b' });
  // 用户在文件管理器里放进去的 png：不该出现在列表里
  const c1Uri = [...adapter.nodes.values()].find(node => node.name === 'c1').uri;
  adapter.seed(`${c1Uri}/extra`, 'c.png', false);

  const files = await store.listWorkspaceFiles({ characterId: 'c1' });
  assert.deepEqual(files, ['a.txt', 'sub/', 'sub/b.md']);

  const read = await store.readWorkspaceFile({ characterId: 'c1', path: 'sub/b.md' });
  assert.deepEqual(read, { path: 'sub/b.md', content: 'b', truncated: false });

  // 另一个角色是独立子目录，读不到 c1 的文件
  await assert.rejects(
    store.readWorkspaceFile({ characterId: 'c2', path: 'a.txt' }),
    /文件不存在/,
  );
});

test('edit：精确替换复用同一规则，多处匹配默认拒绝', async () => {
  const adapter = createFakeSaf();
  const store = createSafWorkspaceStore({ root: ROOT, adapter });
  await store.writeWorkspaceFile({ characterId: 'c1', path: 'a.md', content: '猫 猫' });

  await assert.rejects(
    store.editWorkspaceFile({ characterId: 'c1', path: 'a.md', find: '猫', replace: '狗' }),
    /匹配到 2 处/,
  );
  // 拒绝之后文件必须原样：不能被半途写坏
  assert.equal((await store.readWorkspaceFile({ characterId: 'c1', path: 'a.md' })).content, '猫 猫');

  const edited = await store.editWorkspaceFile({ characterId: 'c1', path: 'a.md', find: '猫', replace: '狗', all: true });
  assert.equal(edited.count, 2);
  assert.equal((await store.readWorkspaceFile({ characterId: 'c1', path: 'a.md' })).content, '狗 狗');
});

test('docx 走二进制写入（base64 直传，非文本）', async () => {
  const adapter = createFakeSaf();
  const store = createSafWorkspaceStore({ root: ROOT, adapter });
  const result = await store.writeWorkspaceBinaryFile({ characterId: 'c1', path: 'report.docx', base64: 'UEsDBAo=' });
  assert.deepEqual(result, { path: 'report.docx', base64Length: 8 });
  const file = [...adapter.nodes.values()].find(node => node.name === 'report.docx');
  assert.equal(file.content, 'b64:UEsDBAo=');
  assert.match(file.mimeType, /wordprocessingml/);
  // .docx 可以被列出，但读文本（.docx 不在文本白名单）会被拒绝
  assert.deepEqual(await store.listWorkspaceFiles({ characterId: 'c1' }), ['report.docx']);
  await assert.rejects(
    store.readWorkspaceFile({ characterId: 'c1', path: 'report.docx' }),
    /只能读写文本文件/,
  );
});

test('越界与非法扩展名照旧被路径守卫拦下（外部根不放宽）', async () => {
  const adapter = createFakeSaf();
  const store = createSafWorkspaceStore({ root: ROOT, adapter });
  await assert.rejects(
    store.writeWorkspaceFile({ characterId: 'c1', path: '../x.txt', content: 'x' }),
    /越出工作区/,
  );
  await assert.rejects(
    store.writeWorkspaceFile({ characterId: 'c1', path: '/abs/x.txt', content: 'x' }),
    /相对路径/,
  );
  await assert.rejects(
    store.writeWorkspaceFile({ characterId: 'c1', path: 'a.png', content: 'x' }),
    /只能读写文本文件/,
  );
});

test('读路径不产生副作用：文件不存在时不建目录，列目录也不建', async () => {
  const adapter = createFakeSaf();
  const store = createSafWorkspaceStore({ root: ROOT, adapter });
  const before = adapter.nodes.size;
  assert.deepEqual(await store.listWorkspaceFiles({ characterId: 'nobody' }), []);
  await assert.rejects(
    store.readWorkspaceFile({ characterId: 'nobody', path: 'ghost.txt' }),
    /文件不存在/,
  );
  assert.equal(adapter.nodes.size, before, '读操作不得凭空建目录');
});

test('fileUri / deleteFile 走 adapter，找不到时如实返回', async () => {
  const adapter = createFakeSaf();
  const store = createSafWorkspaceStore({ root: ROOT, adapter });
  await store.writeWorkspaceFile({ characterId: 'c1', path: 'a.txt', content: 'a' });
  const uri = await store.fileUri({ characterId: 'c1', path: 'a.txt' });
  assert.ok(uri && uri.includes('/file-'));
  assert.equal(await store.fileUri({ characterId: 'c1', path: 'gone.txt' }), null);

  assert.deepEqual(await store.deleteFile({ characterId: 'c1', path: 'a.txt' }), { path: 'a.txt', deleted: true });
  assert.equal(adapter.nodes.has(uri), false);
  assert.deepEqual(await store.deleteFile({ characterId: 'c1', path: 'a.txt' }), { path: 'a.txt', deleted: false });
});

test('缺 adapter / 缺根目录时在装配期就抛错', async () => {
  assert.throws(() => createSafWorkspaceStore({ root: ROOT }), /缺少 adapter 注入/);
  assert.throws(() => createSafWorkspaceStore({ root: ROOT, adapter: {} }), /缺少 adapter 注入/);
  // 有 adapter 但缺了创建能力也要拦住：不然后面写文件才会莫名其妙地失败
  assert.throws(
    () => createSafWorkspaceStore({ root: ROOT, adapter: { listChildren: async () => [] } }),
    /缺少 adapter 的创建能力/,
  );
  assert.throws(() => createSafWorkspaceStore({ root: '', adapter: createFakeSaf() }), /缺少根目录/);
});

test('createExpoSafAdapter：新 API 缺失时明确抛错，齐备时形状正确', () => {
  assert.throws(() => createExpoSafAdapter(null), /不含 Directory\/File 新 API/);
  assert.throws(() => createExpoSafAdapter({ Directory: function Directory() {} }), /不含 Directory\/File 新 API/);

  const listed = [];
  // 真实的 expo 类是两个互不相干的类（各自 extends 原生 FileSystemFile/Directory），
  // 所以假实现也不能用 extends 造父子关系——那会让 instanceof 判断失真。
  class FakeDirectory {
    constructor(uri) { this.uri = uri; }
    list() { return [new FakeDirectory(`${this.uri}/x`), new FakeFile(`${this.uri}/y`)]; }
    createDirectory(name) { listed.push(['dir', this.uri, name]); return new FakeDirectory(`${this.uri}/d`); }
    createFile(name, mimeType) { listed.push(['file', this.uri, name, mimeType]); return new FakeFile(`${this.uri}/f`); }
    get name() { return this.uri.split('/').pop(); }
  }
  class FakeFile {
    constructor(uri) { this.uri = uri; }
    async text() { return 'body'; }
    write(content, options) { listed.push(['write', this.uri, content, options]); }
    delete() { listed.push(['delete', this.uri]); }
    get name() { return this.uri.split('/').pop(); }
  }
  const adapter = createExpoSafAdapter({ Directory: FakeDirectory, File: FakeFile });
  return (async () => {
    const children = await adapter.listChildren('content://root');
    assert.deepEqual(children.map(child => child.isDirectory), [true, false]);
    assert.equal(await adapter.readText('content://a'), 'body');
    await adapter.writeText('content://a', 'x');
    assert.deepEqual(listed[0], ['write', 'content://a', 'x', undefined]);
    await adapter.writeBase64('content://a', 'QUJD');
    assert.deepEqual(listed[1], ['write', 'content://a', 'QUJD', { encoding: 'base64' }]);
    await adapter.delete('content://a');
    assert.deepEqual(listed[2], ['delete', 'content://a']);
  })();
});

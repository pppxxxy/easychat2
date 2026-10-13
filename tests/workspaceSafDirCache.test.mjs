// R5 回归：SAF 写路径的目录 URI 缓存。
//
// 病根（实测口径）：content:// 逐段下降 = 每段一次 IPC。拉取 1066 个文件时，
// 每个文件的父路径（≈9-10 段）都从根重降一遍 ≈ 1.2 万次串行 IPC——而它们其实
// 只共享约 250 个目录。这里用**假 adapter 的调用计数**把收益钉成可回归的数字，
// 并守住两条安全边界：读路径不得用缓存（死链会让列表静默变空）、
// 缓存失效必须自愈（用户在文件管理器里删过目录）。
import test from 'node:test';
import assert from 'node:assert/strict';

import { createSafWorkspaceStore } from '../src/workspace/safStore.js';

const ROOT = 'content://tree/primary%3ADocs';

// 与 workspaceSafStore.test.mjs 同款假 SAF（uri 精确匹配，禁止拼字符串），
// 外加调用计数与「外部删除」能力（模拟用户在系统文件管理器里删目录）。
function createFakeSaf({ countCalls = true } = {}) {
  const nodes = new Map();
  const calls = { listChildren: 0, createDirectory: 0, createFile: 0 };
  let counter = 0;

  function seed(uri, name, isDirectory) {
    nodes.set(uri, { uri, name, isDirectory });
    return uri;
  }
  seed(ROOT, 'Docs', true);

  function removeTree(uri) {
    for (const key of [...nodes.keys()]) {
      if (key === uri || key.startsWith(`${uri}/`)) nodes.delete(key);
    }
  }

  return {
    nodes,
    calls,
    removeTree,
    async listChildren(uri) {
      if (countCalls) calls.listChildren += 1;
      const node = nodes.get(uri);
      if (!node || !node.isDirectory) throw new Error('not a directory');
      const prefix = `${uri}/`;
      return [...nodes.values()].filter(entry => (
        entry.uri.startsWith(prefix) && !entry.uri.slice(prefix.length).includes('/')
      ));
    },
    async createDirectory(parentUri, name) {
      if (countCalls) calls.createDirectory += 1;
      if (!nodes.has(parentUri)) throw new Error(`missing parent ${parentUri}`);
      counter += 1;
      return seed(`${parentUri}/dir-${counter}`, name, true);
    },
    async createFile(parentUri, name) {
      if (countCalls) calls.createFile += 1;
      if (!nodes.has(parentUri)) throw new Error(`missing parent ${parentUri}`);
      counter += 1;
      const uri = `${parentUri}/file-${counter}`;
      seed(uri, name, false);
      nodes.get(uri).mcontent = '';
      return uri;
    },
    async readText(uri) {
      const node = nodes.get(uri);
      if (!node || node.isDirectory) throw new Error('not a file');
      return node.mcontent;
    },
    async writeText(uri, text) {
      const node = nodes.get(uri);
      if (!node || node.isDirectory) throw new Error(`not a file: ${uri}`);
      node.mcontent = String(text);
    },
    async writeBase64(uri, base64) {
      const node = nodes.get(uri);
      if (!node || node.isDirectory) throw new Error('not a file');
      node.mcontent = `b64:${base64}`;
    },
    async delete(uri) {
      if (!nodes.has(uri)) throw new Error('missing');
      nodes.delete(uri);
    },
    async deleteDirectory(uri) {
      if (!nodes.has(uri)) throw new Error('missing');
      removeTree(uri);
    },
  };
}

const DIRS = ['repos', 'o', 'r', 'main', 'src', 'deep', 'nested'];

test('缓存收益：同目录批量写入的 listChildren IPC 大幅下降（写入不丢文件）', async () => {
  const saf = createFakeSaf();
  const store = createSafWorkspaceStore({ root: ROOT, adapter: saf });

  // 先把目录建出来（这次下降是一次性的），再测批量写入
  await store.writeWorkspaceFile({ characterId: 'c1', path: `${DIRS.join('/')}/seed.js`, content: 'x' });
  const baseline = saf.calls.listChildren;

  const count = 30;
  for (let i = 0; i < count; i += 1) {
    await store.writeWorkspaceFile({ characterId: 'c1', path: `${DIRS.join('/')}/f${i}.js`, content: `c${i}` });
  }
  const used = saf.calls.listChildren - baseline;

  // 未缓存：每文件 ≈ 7 段下降 + 1 次查文件 = 8 次 → 240 次
  // 有缓存：每文件 1 次查文件 = 30 次
  assert.ok(used <= count + 2, `缓存后每文件只应剩「查文件」一次 IPC，实测 ${used} 次`);
  assert.ok(used < count * 3, `必须显著优于未缓存的每文件 7-8 次，实测 ${used} 次`);

  // 正确性：内容真的写进去了（缓存只省定位，不改语义）
  const read = await store.readWorkspaceFile({ characterId: 'c1', path: `${DIRS.join('/')}/f7.js` });
  assert.equal(read.content, 'c7');
});

test('读路径不共享写缓存：外部删掉目录后列表如实变空而不报错/不假命中', async () => {
  const saf = createFakeSaf();
  const store = createSafWorkspaceStore({ root: ROOT, adapter: saf });
  await store.writeWorkspaceFile({ characterId: 'c1', path: 'repos/o/r/main/a.js', content: 'a' });

  const listed = await store.listWorkspaceFiles({ characterId: 'c1' });
  assert.ok(listed.includes('repos/o/r/main/a.js'), `列表应含刚写的文件：${JSON.stringify(listed)}`);

  // 外部删除整棵 repos（模拟用户在文件管理器里删掉）→ 列表必须如实变空
  const reposUri = [...saf.nodes.values()].find(node => node.name === 'repos').uri;
  saf.removeTree(reposUri);
  const after = await store.listWorkspaceFiles({ characterId: 'c1' });
  assert.deepEqual(after, [], '读路径走实时下降：外部删除立刻可见');
});

test('缓存自愈：缓存的目录被外部删掉后，下一次写入失效重建并成功', async () => {
  const saf = createFakeSaf();
  const store = createSafWorkspaceStore({ root: ROOT, adapter: saf });
  const target = 'repos/o/r/main/src/deep/nested';

  await store.writeWorkspaceFile({ characterId: 'c1', path: `${target}/one.js`, content: '1' });
  // 缓存此刻持有 nested 的 uri —— 从外部把它整棵删掉
  const nestedUri = [...saf.nodes.values()].find(node => node.name === 'nested').uri;
  saf.removeTree(nestedUri);

  // 写入必须自愈（失效 → 重新下降建目录 → 写成功），而不是抛「not a directory」
  const written = await store.writeWorkspaceFile({ characterId: 'c1', path: `${target}/two.js`, content: '2' });
  assert.equal(written.path, `${target}/two.js`);
  const read = await store.readWorkspaceFile({ characterId: 'c1', path: `${target}/two.js` });
  assert.equal(read.content, '2');
});

test('删除目录后缓存失效：同名目录重建能写进去（不会命中已删除的旧 uri）', async () => {
  const saf = createFakeSaf();
  const store = createSafWorkspaceStore({ root: ROOT, adapter: saf });

  // 先建一个**空**目录（非空目录删除会被 F2 守卫拒绝），写缓存随即建立
  await store.createWorkspaceDirectory({ characterId: 'c1', path: 'repos/o/r/main/tmp' });
  const deleted = await store.deleteWorkspaceDirectory({ characterId: 'c1', path: 'repos/o/r/main/tmp' });
  assert.equal(deleted.deleted, true);

  // 重建同名目录并写入：若缓存没失效，会拿着旧 uri 去写 → not a directory
  const again = await store.writeWorkspaceFile({ characterId: 'c1', path: 'repos/o/r/main/tmp/b.js', content: 'b' });
  assert.equal(again.path, 'repos/o/r/main/tmp/b.js');
  const read = await store.readWorkspaceFile({ characterId: 'c1', path: 'repos/o/r/main/tmp/b.js' });
  assert.equal(read.content, 'b');
});

test('缓存按沙盒隔离：不同 characterId 不串 uri', async () => {
  const saf = createFakeSaf();
  const store = createSafWorkspaceStore({ root: ROOT, adapter: saf });
  await store.writeWorkspaceFile({ characterId: 'c1', path: 'same/dir/a.js', content: 'one' });
  await store.writeWorkspaceFile({ characterId: 'c2', path: 'same/dir/a.js', content: 'two' });

  const first = await store.readWorkspaceFile({ characterId: 'c1', path: 'same/dir/a.js' });
  const second = await store.readWorkspaceFile({ characterId: 'c2', path: 'same/dir/a.js' });
  assert.equal(first.content, 'one');
  assert.equal(second.content, 'two');
});

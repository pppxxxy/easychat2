// W7 spike：isomorphic-git 能不能跑在我们的 store 契约上（纯 JS 路线的 go/no-go）。
//
// 这条测试要证明的就是当初选纯 JS 的唯一理由：**git 操作能在 Node 里直测**。
// 做法：内存 fileSystem（照 expo-file-system/legacy 的语义，见 tests/helpers）+
// 真 isomorphic-git，跑 init → add → commit → log → status → 改文件 → 取旧版本 → checkout。

import test from 'node:test';
import assert from 'node:assert/strict';

import git from 'isomorphic-git';
import { Buffer } from 'buffer';

import { createGitFs, normalizeGitPath } from '../src/workspace/gitFs.js';
import { createMemoryFileSystem } from './helpers/memoryFileSystem.mjs';

const ROOT = '/doc/workspace/';
const CHARACTER = 'ch1';
const SANDBOX = `${ROOT}${CHARACTER}/`;
const AUTHOR = { name: 'easychat', email: 'agent@easychat.local' };

function setup() {
  const fileSystem = createMemoryFileSystem();
  const fs = createGitFs({ root: ROOT, characterId: CHARACTER, fileSystem });
  return { fileSystem, fs };
}

test('spike：init → add → commit → log 全链路走我们的 fileSystem 契约', async () => {
  const { fileSystem, fs } = setup();
  await git.init({ fs, dir: '/' });
  assert.equal(fileSystem.nodes.has(`${SANDBOX}.git/HEAD`), true, '.git/HEAD 落在沙盒里');

  await fs.writeFile('README.md', 'hello\n');
  await git.add({ fs, dir: '/', filepath: 'README.md' });
  const oid = await git.commit({ fs, dir: '/', message: '第一次提交', author: AUTHOR });
  assert.match(oid, /^[0-9a-f]{40}$/, '真 sha1，不是占位');

  const entries = await git.log({ fs, dir: '/' });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].commit.message.trim(), '第一次提交', 'git 会在消息末尾补换行，属正常');
  assert.equal(entries[0].oid, oid);
});

test('spike：statusMatrix 报「已提交未改」，改文件后报 workdir=2', async () => {
  const { fs } = setup();
  await git.init({ fs, dir: '/' });
  await fs.writeFile('a.txt', 'one\n');
  await git.add({ fs, dir: '/', filepath: 'a.txt' });
  await git.commit({ fs, dir: '/', message: 'c1', author: AUTHOR });

  const clean = await git.statusMatrix({ fs, dir: '/' });
  assert.deepEqual(clean.find(row => row[0] === 'a.txt'), ['a.txt', 1, 1, 1], '[head, workdir, stage] 全 1 = 干净');

  await fs.writeFile('a.txt', 'two\n');
  const dirty = await git.statusMatrix({ fs, dir: '/' });
  assert.deepEqual(dirty.find(row => row[0] === 'a.txt'), ['a.txt', 1, 2, 1], 'workdir=2 = 已改未暂存');
});

test('spike：取 HEAD 旧版本（改了什么 = 旧 blob vs 当前文件，自拼 diff）', async () => {
  const { fs } = setup();
  await git.init({ fs, dir: '/' });
  await fs.writeFile('note.md', '第一行\n');
  await git.add({ fs, dir: '/', filepath: 'note.md' });
  const oid = await git.commit({ fs, dir: '/', message: 'c1', author: AUTHOR });
  await fs.writeFile('note.md', '第一行\n第二行\n');

  // 1.43.3 没有 git.diff（实测 typeof git.diff === 'undefined'）→ 自己取旧 blob。
  const { blob } = await git.readBlob({ fs, dir: '/', oid, filepath: 'note.md' });
  const before = Buffer.from(blob).toString('utf8');
  const after = await fs.readFile('note.md', { encoding: 'utf8' });
  assert.equal(before, '第一行\n', '旧版本可从对象库取回（喂给现有 lineDiff 就能出 diff）');
  assert.equal(after, '第一行\n第二行\n');
});

test('spike：checkout --force 还原被改动的文件（回合回滚的地基）', async () => {
  const { fs } = setup();
  await git.init({ fs, dir: '/' });
  await fs.writeFile('x.txt', 'keep\n');
  await git.add({ fs, dir: '/', filepath: 'x.txt' });
  await git.commit({ fs, dir: '/', message: 'c1', author: AUTHOR });
  await fs.writeFile('x.txt', 'wrecked\n');

  await git.checkout({ fs, dir: '/', force: true });
  assert.equal(await fs.readFile('x.txt', { encoding: 'utf8' }), 'keep\n', '回到 HEAD');
});

test('spike：二进制往返（git 对象是压缩字节，必须 base64 进出）', async () => {
  const { fs } = setup();
  const bytes = Buffer.from([0, 1, 2, 250, 251, 252, 0]);
  await fs.writeFile('blob.bin', bytes);
  const back = await fs.readFile('blob.bin');
  assert.deepEqual(Buffer.from(back), bytes, '字节级一致，没有被 UTF-8 破坏');
});

test('spike：越界路径被适配器挡下（不降级防护）', () => {
  assert.equal(normalizeGitPath('/.git/HEAD'), '.git/HEAD');
  assert.equal(normalizeGitPath('src//a.js'), 'src/a.js');
  assert.throws(() => normalizeGitPath('../../etc/passwd'), /越界/);
  assert.throws(() => normalizeGitPath('a/../../b'), /越界/);
});

test('spike：性能粗测（300 文件 add+commit / statusMatrix 耗时，给「按需触发」定上限）', async () => {
  const { fs } = setup();
  await git.init({ fs, dir: '/' });
  for (let i = 0; i < 300; i += 1) {
    await fs.writeFile(`src/f${i}.js`, `export const v = ${i};\n`);
  }
  const t0 = Date.now();
  await git.add({ fs, dir: '/', filepath: 'src' });
  await git.commit({ fs, dir: '/', message: 'bulk', author: AUTHOR });
  const t1 = Date.now();
  const matrix = await git.statusMatrix({ fs, dir: '/' });
  const t2 = Date.now();
  const rows = matrix.filter(row => String(row[0]).startsWith('src/'));
  console.log(`[spike] 300 文件：add+commit ${t1 - t0}ms，statusMatrix ${t2 - t1}ms，行数 ${rows.length}`);
  assert.equal(rows.length, 300, '每个文件一行');
  // 宽松上限：只用来抓「慢到不可用」，不是性能承诺（真机 Hermes 另测）。
  assert.ok(t2 - t1 < 10000, `statusMatrix 300 文件应远快于 10s，实测 ${t2 - t1}ms`);
});

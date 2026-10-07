// 仓库「待同步」清单 diff（纯函数）：本地副本 vs 最近一次拉取/推送的基线。
import test from 'node:test';
import assert from 'node:assert/strict';

import { diffRepoSnapshot, localRepoPaths } from '../src/workspace/screen/repoDiff.js';

const PREFIX = 'repos/o/r/main/';
const FILES = [
  'repos/o/r/main/',
  'repos/o/r/main/a.js',
  'repos/o/r/main/src/',
  'repos/o/r/main/src/b.js',
  'repos/o/r/main/new.md',
  'repos/o/other/main/x.js',
  'notes.txt',
];

test('localRepoPaths：只取该仓库前缀下的文件（去掉目录条目与其他仓库）', () => {
  assert.deepEqual(localRepoPaths({ files: FILES, prefix: PREFIX }), ['a.js', 'new.md', 'src/b.js']);
  assert.deepEqual(localRepoPaths({ files: FILES, prefix: '' }), ['notes.txt', 'repos/o/other/main/x.js', 'repos/o/r/main/a.js', 'repos/o/r/main/new.md', 'repos/o/r/main/src/b.js']);
  assert.deepEqual(localRepoPaths({}), []);
});

test('diffRepoSnapshot：新增 / 删除 / 一致三种情况', () => {
  const base = ['a.js', 'src/b.js'];

  const clean = diffRepoSnapshot({ files: ['repos/o/r/main/a.js', 'repos/o/r/main/src/b.js'], prefix: PREFIX, snapshotPaths: base });
  assert.deepEqual(clean, { added: [], removed: [], total: 2, pending: 0 }, '与基线一致 → 无待同步');

  const changed = diffRepoSnapshot({ files: FILES, prefix: PREFIX, snapshotPaths: base });
  assert.deepEqual(changed.added, ['new.md'], '本地新增被列出');
  assert.deepEqual(changed.removed, [], '基线里没有多出来的');
  assert.equal(changed.total, 3);
  assert.equal(changed.pending, 1);

  const deleted = diffRepoSnapshot({ files: ['repos/o/r/main/new.md'], prefix: PREFIX, snapshotPaths: base });
  assert.deepEqual(deleted.added, ['new.md']);
  assert.deepEqual(deleted.removed, ['a.js', 'src/b.js'], '基线里已消失的文件被列出');
  assert.equal(deleted.pending, 3);

  // 没有基线（首次，尚未拉取过）：全部算新增。
  const noBaseline = diffRepoSnapshot({ files: FILES, prefix: PREFIX, snapshotPaths: [] });
  assert.equal(noBaseline.added.length, 3);
  assert.equal(noBaseline.removed.length, 0);
});

test('diffRepoSnapshot：空输入与坏输入不抛', () => {
  assert.deepEqual(diffRepoSnapshot({}), { added: [], removed: [], total: 0, pending: 0 });
  assert.deepEqual(diffRepoSnapshot({ files: null, prefix: null, snapshotPaths: null }), { added: [], removed: [], total: 0, pending: 0 });
  assert.deepEqual(diffRepoSnapshot({ files: FILES, prefix: PREFIX, snapshotPaths: [null, '', 'a.js'] }).removed, []);
});

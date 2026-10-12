// 仓库「待同步」清单 diff（纯函数）：本地副本 vs 最近一次拉取/推送的基线。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyPullGuard,
  diffRepoSnapshot,
  hasMissingGaps,
  isDirtyPullState,
  localRepoPaths,
  pullGuardCopy,
} from '../src/workspace/screen/repoDiff.js';

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

// —— R1：残缺态裁决（截图对账：新增 5 + 删除 420 = 「425 处未推送」误报）——

test('classifyPullGuard：manifest 残留 → dirtyPull（跳过覆盖守卫），数字取 diff', () => {
  const manifest = { owner: 'o', repo: 'r', branch: 'main', files: 1059 };
  const diff = { added: ['x'], removed: ['a', 'b'], total: 3, pending: 3 };
  const decision = classifyPullGuard({ manifest, diff, hasLocal: true });
  assert.equal(decision.kind, 'dirtyPull', '有残留即 dirtyPull——不再问「覆盖你的改动」');
  assert.equal(decision.missing, 2, '缺口 = removed 数');
  assert.equal(decision.target, 1059, '上次拉取目标数如实带出');
  // 截图同款大数字：5 added + 420 removed 也只报「缺 420、目标 1059」这种可修复的话
  const big = classifyPullGuard({
    manifest,
    diff: { added: Array.from({ length: 5 }, (_, i) => `n${i}`), removed: Array.from({ length: 420 }, (_, i) => `m${i}`), pending: 425 },
    hasLocal: true,
  });
  assert.equal(big.kind, 'dirtyPull');
  assert.equal(big.missing, 420);
  // 坏输入：数组/非对象都按「无残留」处理
  assert.equal(classifyPullGuard({ manifest: [], diff, hasLocal: true }).kind, 'overwrite');
  assert.equal(classifyPullGuard({ manifest: null, diff, hasLocal: true }).kind, 'overwrite');
});

test('classifyPullGuard：无残留 → overwrite（缺失多于新增 = 残缺嫌疑）；本地为空/无增删 → clean', () => {
  const suspect = classifyPullGuard({
    manifest: null,
    diff: { added: ['x'], removed: ['a', 'b', 'c'], pending: 4 },
    hasLocal: true,
  });
  assert.equal(suspect.kind, 'overwrite');
  assert.equal(suspect.added, 1);
  assert.equal(suspect.removed, 3);
  assert.equal(suspect.suspect, true, 'removed > added → 残缺嫌疑');

  const normal = classifyPullGuard({ manifest: null, diff: { added: ['x', 'y'], removed: ['a'], pending: 3 }, hasLocal: true });
  assert.equal(normal.kind, 'overwrite');
  assert.equal(normal.suspect, false, '新增占多数 = 像正常的工作');

  assert.equal(classifyPullGuard({ manifest: null, diff: { added: [], removed: [], pending: 0 }, hasLocal: true }).kind, 'clean', '与基线一致放行');
  assert.equal(classifyPullGuard({ manifest: null, diff: { added: ['x'], pending: 1 }, hasLocal: false }).kind, 'clean', '本地为空（首次拉取）放行');
});

test('pullGuardCopy：三态各给键与参数（dirty 报缺口与目标；overwrite 报双数字）', () => {
  const dirty = pullGuardCopy({ decision: { kind: 'dirtyPull', missing: 420, target: 1059 } });
  assert.equal(dirty.key, 'workspace.github.pull.dirtyBody');
  assert.deepEqual(dirty.params, { missing: 420, target: 1059 });

  const suspect = pullGuardCopy({ decision: { kind: 'overwrite', added: 5, removed: 420, suspect: true } });
  assert.equal(suspect.key, 'workspace.github.pull.overwriteBodySuspect');
  assert.deepEqual(suspect.params, { added: 5, removed: 420 });

  const plain = pullGuardCopy({ decision: { kind: 'overwrite', added: 3, removed: 1, suspect: false } });
  assert.equal(plain.key, 'workspace.github.pull.overwriteBodySplit');
  assert.deepEqual(plain.params, { added: 3, removed: 1 });

  assert.deepEqual(pullGuardCopy({ decision: { kind: 'clean' } }), { key: '', params: {} });
  assert.deepEqual(pullGuardCopy({}), { key: '', params: {} });
});

test('isDirtyPullState：只看 manifest 残留硬信号（推送阻断口径）', () => {
  assert.equal(isDirtyPullState({ manifest: { files: 1 } }), true, '残留即 dirty');
  assert.equal(isDirtyPullState({ manifest: null, diff: { added: [], removed: ['a'] } }), false, '无残留不阻断——删文件后推送是合法操作');
  assert.equal(isDirtyPullState({ manifest: [] }), false, '数组不是清单对象');
  assert.equal(isDirtyPullState({}), false, '坏输入按非 dirty（不误伤正常推送）');
});

test('hasMissingGaps：缺失≥10 且 > 新增 → 软信号只提示不阻断', () => {
  assert.equal(hasMissingGaps({ diff: { added: [], removed: Array.from({ length: 420 }, (_, i) => `m${i}`) } }), true, '截图态：420 缺口无新增');
  assert.equal(hasMissingGaps({ diff: { added: ['a'], removed: ['b', 'c'] } }), false, '少量缺失 = 正常删除工作');
  assert.equal(hasMissingGaps({ diff: { added: [], removed: Array.from({ length: 10 }, (_, i) => `m${i}`) } }), true, '阈值边界：10');
  assert.equal(hasMissingGaps({ diff: { added: [], removed: Array.from({ length: 9 }, (_, i) => `m${i}`) } }), false, '阈值下：9');
  assert.equal(hasMissingGaps({ diff: { added: Array.from({ length: 20 }, (_, i) => `n${i}`), removed: Array.from({ length: 15 }, (_, i) => `m${i}`) } }), false, '新增更多 → 像重构不是残缺');
  assert.equal(hasMissingGaps({}), false);
});

test('文案联动：dirtyBody / dirtyNote / overwriteBody* 的占位符与裁决参数一致', async () => {
  const { zhCN } = await import('../src/i18n/locales/zh-CN.js');
  const { en } = await import('../src/i18n/locales/en.js');
  for (const [locale, table] of [['zh-CN', zhCN], ['en', en]]) {
    for (const key of [
      'workspace.github.pull.dirtyBody',
      'workspace.github.pull.overwriteBodySplit',
      'workspace.github.pull.overwriteBodySuspect',
      'workspace.github.push.dirtyNote',
    ]) {
      assert.ok(typeof table[key] === 'string' && table[key].length > 0, `${locale} 缺 ${key}`);
    }
    assert.match(table['workspace.github.pull.dirtyBody'], /\{missing\}/);
    assert.match(table['workspace.github.pull.dirtyBody'], /\{target\}/);
    assert.match(table['workspace.github.pull.overwriteBodySplit'], /\{added\}.*\{removed\}/);
    assert.match(table['workspace.github.pull.overwriteBodySuspect'], /\{added\}.*\{removed\}/);
  }
  // 裁决 → 渲染：参数喂进去不能残留占位符（translate 真实现）
  const { translate } = await import('../src/i18n/index.js');
  const decision = classifyPullGuard({ manifest: { files: 1059 }, diff: { added: ['x'], removed: ['a'], pending: 2 }, hasLocal: true });
  const copy = pullGuardCopy({ decision });
  const text = translate('zh-CN', copy.key, copy.params);
  assert.ok(!text.includes('{'), `dirtyBody 渲染后不得残留占位符：${text}`);
  assert.ok(text.includes('1059'), text);
});

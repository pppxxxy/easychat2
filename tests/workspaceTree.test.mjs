// 工作区文件分组 / 目录树纯函数（v2 Stage 2 地基）。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  breadcrumbsOf,
  directoryChildren,
  groupWorkspaceFiles,
  mergeManifestEntries,
  parentDirectoryOf,
  projectGroupOf,
} from '../src/workspace/screen/buildTree.js';

test('projectGroupOf：repos 分支快照 / 非项目返回 null（旧 projects/ 规范已移除）', () => {
  const repo = projectGroupOf('repos/pppxxxy/easychat2/main/src/app.js');
  assert.equal(repo.prefix, 'repos/pppxxxy/easychat2/main/');
  assert.equal(repo.label, 'pppxxxy/easychat2 · main');

  // 分支目录条目本身（带尾斜杠）同样归到该分支
  assert.equal(projectGroupOf('repos/pppxxxy/easychat2/main/').prefix, 'repos/pppxxxy/easychat2/main/');

  // 仓库根下的文件（没有分支层）：整段当项目，label 不带分支
  const shallow = projectGroupOf('repos/octocat/Hello-World/README');
  assert.equal(shallow.prefix, 'repos/octocat/Hello-World/');
  assert.equal(shallow.label, 'octocat/Hello-World');
  assert.equal(projectGroupOf('repos/octocat/Hello-World/').prefix, 'repos/octocat/Hello-World/');

  assert.equal(projectGroupOf('projects/octocat__Hello-World/a.txt'), null, '旧 projects/ 规范已移除');
  assert.equal(projectGroupOf('css/app.css'), null, '普通目录不是项目');
  assert.equal(projectGroupOf('a.txt'), null, '根级文件不是项目');
  assert.equal(projectGroupOf('repos/'), null, '只有 repos 前缀不算');
  assert.equal(projectGroupOf('repos/only'), null, '缺 repo 段不算');
});

test('groupWorkspaceFiles：根级散文件与项目卡分开，计数正确', () => {
  const files = [
    'a.txt',
    'css/',
    'css/app.css',
    'repos/pppxxxy/easychat2/main/',
    'repos/pppxxxy/easychat2/main/App.js',
    'repos/pppxxxy/easychat2/main/src/',
    'repos/pppxxxy/easychat2/main/src/app.js',
  ];
  const { rootEntries, groups } = groupWorkspaceFiles(files);
  assert.deepEqual(rootEntries, ['a.txt', 'css/', 'css/app.css']);
  assert.equal(groups.length, 1);
  // repos 组在前（新规范），projects 组在后（旧规范只读兼容）
  assert.equal(groups[0].id, 'repos/pppxxxy/easychat2/main');
  assert.equal(groups[0].label, 'pppxxxy/easychat2 · main');
  assert.equal(groups[0].fileCount, 2);
  assert.equal(groups[0].dirCount, 2);
});

test('directoryChildren：只列当前层，目录在前文件在后', () => {
  const files = ['a.txt', 'src/', 'src/a.js', 'src/sub/', 'src/sub/b.js', 'z.txt'];
  const root = directoryChildren(files, '');
  assert.deepEqual(root.map(item => item.name), ['src', 'a.txt', 'z.txt']);
  assert.equal(root[0].isDirectory, true);
  assert.equal(root[0].path, 'src/');

  const inSrc = directoryChildren(files, 'src/');
  assert.deepEqual(inSrc.map(item => item.name), ['sub', 'a.js']);
  assert.equal(inSrc[0].path, 'src/sub/');
  assert.equal(inSrc[1].path, 'src/a.js');
  assert.equal(inSrc[1].isDirectory, false);

  const inSub = directoryChildren(files, 'src/sub/');
  assert.deepEqual(inSub.map(item => item.name), ['b.js']);
});

test('breadcrumbsOf：根 + 逐段路径', () => {
  assert.deepEqual(breadcrumbsOf('', '工作区'), [{ name: '工作区', path: '' }]);
  const crumbs = breadcrumbsOf('repos/pppxxxy/easychat2/main/src/', '工作区');
  assert.deepEqual(crumbs.map(c => c.name), ['工作区', 'repos', 'pppxxxy', 'easychat2', 'main', 'src']);
  assert.equal(crumbs[crumbs.length - 1].path, 'repos/pppxxxy/easychat2/main/src/');
  assert.equal(crumbs[1].path, 'repos/');
});

test('C1 mergeManifestEntries：本地 ∪ 清单，清单独有条目标 virtual（仓库内相对路径入参）', () => {
  const prefix = 'repos/o/r/main/';
  const files = [
    'repos/o/r/main/',
    'repos/o/r/main/src/',
    'repos/o/r/main/README.md',
    'repos/o/r/main/src/a.js',
  ];
  const manifestEntries = [
    { path: 'src', type: 'tree' },
    { path: 'src/a.js', type: 'blob' },
    { path: 'src/b.js', type: 'blob' }, // 只有清单
    { path: 'docs', type: 'tree' }, // 只有清单（目录）
    { path: 'docs/guide.md', type: 'blob' }, // 只有清单
  ];
  const { entries, virtual } = mergeManifestEntries({ files, manifestEntries, prefix });
  assert.deepEqual(entries, [
    'repos/o/r/main/',
    'repos/o/r/main/README.md',
    'repos/o/r/main/docs/',
    'repos/o/r/main/docs/guide.md',
    'repos/o/r/main/src/',
    'repos/o/r/main/src/a.js',
    'repos/o/r/main/src/b.js',
  ], '本地 ∪ 清单（目录带尾斜杠）');
  assert.deepEqual([...virtual].sort(), [
    'repos/o/r/main/docs/',
    'repos/o/r/main/docs/guide.md',
    'repos/o/r/main/src/b.js',
  ], '只在清单里 = virtual；本地已有的（README/src/a.js）不打云朵');

  // 空清单 → 纯本地
  const none = mergeManifestEntries({ files, manifestEntries: [], prefix });
  assert.equal(none.virtual.size, 0);
  assert.deepEqual(none.entries, [...files].sort());

  // 前缀过滤：别的仓库的清单条目不进本仓库
  const other = mergeManifestEntries({
    files: [],
    manifestEntries: [{ path: 'unrelated/x.js', type: 'blob' }],
    prefix: 'repos/other/repo/main/',
  });
  assert.deepEqual(other.entries, ['repos/other/repo/main/unrelated/x.js'], '清单条目拼前缀后归位');
  assert.equal(other.virtual.size, 1);

  // 形态冲突：清单说 src 是目录、本地 src 是文件 → 以本地为准（不打云朵）
  const flipped = mergeManifestEntries({
    files: ['repos/o/r/main/src'],
    manifestEntries: [{ path: 'src', type: 'tree' }],
    prefix,
  });
  assert.equal(flipped.virtual.size, 0, '本地存在（即使形态不同）就不打云朵');

  // 坏输入安全
  assert.deepEqual(mergeManifestEntries({}).entries, []);
  assert.equal(mergeManifestEntries({ manifestEntries: [{ path: '' }, null] }).virtual.size, 0);
});

test('F1 parentDirectoryOf：目录路径的上一级（空目录空状态的返回按钮用）', () => {
  assert.equal(parentDirectoryOf('repos/pppxxxy/easychat2/main/'), 'repos/pppxxxy/easychat2/');
  assert.equal(parentDirectoryOf('repos/'), '');
  assert.equal(parentDirectoryOf('a/'), '', '一级目录的上一级 = 根层');
  assert.equal(parentDirectoryOf(''), '');
  assert.equal(parentDirectoryOf(null), '');
  // 无尾斜杠也按「目录」处理（条目约定带尾斜杠，但函数不依赖它）
  assert.equal(parentDirectoryOf('a/b'), 'a/');
});

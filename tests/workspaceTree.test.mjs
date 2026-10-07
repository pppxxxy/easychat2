// 工作区文件分组 / 目录树纯函数（v2 Stage 2 地基）。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  breadcrumbsOf,
  directoryChildren,
  groupWorkspaceFiles,
  projectGroupOf,
} from '../src/workspace/screen/buildTree.js';

test('projectGroupOf：repos 分支快照 / projects 旧规范 / 非项目返回 null', () => {
  const repo = projectGroupOf('repos/pppxxxy/easychat2/main/src/app.js');
  assert.equal(repo.kind, 'repo');
  assert.equal(repo.prefix, 'repos/pppxxxy/easychat2/main/');
  assert.equal(repo.label, 'pppxxxy/easychat2 · main');

  // 分支目录条目本身（带尾斜杠）同样归到该分支
  assert.equal(projectGroupOf('repos/pppxxxy/easychat2/main/').prefix, 'repos/pppxxxy/easychat2/main/');

  // 仓库根下的文件（没有分支层）：整段当项目，label 不带分支
  const shallow = projectGroupOf('repos/octocat/Hello-World/README');
  assert.equal(shallow.prefix, 'repos/octocat/Hello-World/');
  assert.equal(shallow.label, 'octocat/Hello-World');
  assert.equal(projectGroupOf('repos/octocat/Hello-World/').prefix, 'repos/octocat/Hello-World/');

  const legacy = projectGroupOf('projects/octocat__Hello-World/a.txt');
  assert.equal(legacy.kind, 'legacy');
  assert.equal(legacy.prefix, 'projects/octocat__Hello-World/');
  assert.equal(legacy.label, 'octocat/Hello-World');

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
    'projects/octocat__Hello-World/',
    'projects/octocat__Hello-World/README',
  ];
  const { rootEntries, groups } = groupWorkspaceFiles(files);
  assert.deepEqual(rootEntries, ['a.txt', 'css/', 'css/app.css']);
  assert.equal(groups.length, 2);
  // repos 组在前（新规范），projects 组在后（旧规范只读兼容）
  assert.equal(groups[0].kind, 'repo');
  assert.equal(groups[0].id, 'repos/pppxxxy/easychat2/main');
  assert.equal(groups[0].label, 'pppxxxy/easychat2 · main');
  assert.equal(groups[0].fileCount, 2);
  assert.equal(groups[0].dirCount, 2);
  assert.equal(groups[1].kind, 'legacy');
  assert.equal(groups[1].fileCount, 1);
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

// 工作区文件搜索（workspace/fileSearch.js）——纯函数行为测试。
// 背景：文件面板只能逐层下钻，没有搜索；全仓唯一的搜索框在 GitHub 面板。
import test from 'node:test';
import assert from 'node:assert/strict';

import { searchWorkspaceFiles } from '../src/workspace/fileSearch.js';

const FILES = [
  'README.md',
  'src/chat.js',
  'src/chat/deep/thing.js',
  'src/workspace/screen/FilesPanel.js',
  'src/workspace/',
  'repos/pppxxxy/easychat2/main/src/chat.js',
  'docs/',
];

test('searchWorkspaceFiles：空查询不返回结果（界面该显示原来的树，不是全量平铺）', () => {
  assert.deepEqual(searchWorkspaceFiles(FILES, ''), { matches: [], total: 0, truncated: false });
  assert.deepEqual(searchWorkspaceFiles(FILES, '   '), { matches: [], total: 0, truncated: false });
  assert.deepEqual(searchWorkspaceFiles(FILES, null), { matches: [], total: 0, truncated: false });
  assert.deepEqual(searchWorkspaceFiles(null, 'x'), { matches: [], total: 0, truncated: false });
});

test('searchWorkspaceFiles：只搜文件，不搜目录（目录能逐层点，混进结果只是噪声）', () => {
  const { matches } = searchWorkspaceFiles(FILES, 'workspace');
  assert.ok(matches.every(item => !item.path.endsWith('/')), '目录条目不出现在结果里');
  assert.ok(matches.some(item => item.path === 'src/workspace/screen/FilesPanel.js'));
  assert.ok(!matches.some(item => item.path === 'src/workspace/'), '目录本身不出现');
});

test('searchWorkspaceFiles：大小写不敏感，文件名命中排在仅路径命中之前', () => {
  const lower = searchWorkspaceFiles(FILES, 'readme').matches.map(x => x.path);
  assert.deepEqual(lower, ['README.md'], '大小写不敏感');

  const { matches } = searchWorkspaceFiles(FILES, 'chat');
  // 文件名命中（chat.js）在前，仅路径命中（chat/deep/thing.js）在后
  assert.equal(matches[0].name, 'chat.js');
  assert.ok(matches[0].name.toLowerCase().includes('chat'));
  const onlyPathHit = matches.findIndex(item => !item.name.toLowerCase().includes('chat'));
  const nameHit = matches.findIndex(item => item.name.toLowerCase().includes('chat'));
  assert.ok(nameHit < onlyPathHit, '文件名命中必须排在仅路径命中之前');
});

test('searchWorkspaceFiles：同为文件名命中时路径越浅越靠前', () => {
  const { matches } = searchWorkspaceFiles(FILES, 'chat.js');
  assert.deepEqual(matches.map(x => x.path), [
    'src/chat.js',
    'repos/pppxxxy/easychat2/main/src/chat.js',
  ]);
});

test('searchWorkspaceFiles：带出所在目录（结果里要显示「在哪儿」）', () => {
  const { matches } = searchWorkspaceFiles(FILES, 'FilesPanel');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].name, 'FilesPanel.js');
  assert.equal(matches[0].dir, 'src/workspace/screen/');
  // 根层文件的 dir 是空串，不是 './' 或 '/'
  assert.equal(searchWorkspaceFiles(FILES, 'README').matches[0].dir, '');
});

test('searchWorkspaceFiles：limit 截断但 total 如实报全量（界面要能说「还有 N 条」）', () => {
  const many = Array.from({ length: 12 }, (_, i) => `dir/f${i}.txt`);
  const result = searchWorkspaceFiles(many, 'f', { limit: 5 });
  assert.equal(result.matches.length, 5);
  assert.equal(result.total, 12);
  assert.equal(result.truncated, true);
  // 没超限时 truncated 为 false
  const small = searchWorkspaceFiles(many, 'f', { limit: 50 });
  assert.equal(small.matches.length, 12);
  assert.equal(small.truncated, false);
  // 坏 limit（0 / 负数 / NaN）退化为默认上限 50，**不**返回空列表。
  // 这里曾经写成 `Number(limit) || 50`，于是 limit:0 变成 50——断言就抓这个。
  assert.equal(searchWorkspaceFiles(many, 'f', { limit: 0 }).matches.length, 12);
  assert.equal(searchWorkspaceFiles(many, 'f', { limit: -3 }).matches.length, 12);
  assert.equal(searchWorkspaceFiles(many, 'f', { limit: 'abc' }).matches.length, 12);
});

test('searchWorkspaceFiles：无命中给空结果，坏输入不抛', () => {
  assert.deepEqual(searchWorkspaceFiles(FILES, '不存在的名字'), { matches: [], total: 0, truncated: false });
  assert.deepEqual(searchWorkspaceFiles([null, undefined, ''], 'x'), { matches: [], total: 0, truncated: false });
});

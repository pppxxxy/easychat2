// 工作区「从 GitHub 拉项目」的纯函数：仓库解析、URL / 请求头、zipball 解压与过滤。
//（真正的下载走 XHR，Node 里跑不了；这里只钉可测的部分。）

import test from 'node:test';
import assert from 'node:assert/strict';
import { strToU8, zipSync } from 'fflate';

import {
  PROJECTS_DIR,
  buildRepoHeaders,
  buildRepoZipUrl,
  extractRepoFiles,
  parseRepoInput,
  projectDirectoryName,
} from '../src/workspace/project.js';

test('parseRepoInput：owner/repo、链接、git@ 都认，非法输入返回 null', () => {
  assert.deepEqual(parseRepoInput('facebook/react'), { owner: 'facebook', repo: 'react' });
  assert.deepEqual(parseRepoInput('https://github.com/facebook/react'), { owner: 'facebook', repo: 'react' });
  assert.deepEqual(parseRepoInput('https://github.com/facebook/react.git'), { owner: 'facebook', repo: 'react' });
  assert.deepEqual(parseRepoInput('git@github.com:facebook/react.git'), { owner: 'facebook', repo: 'react' });
  assert.deepEqual(parseRepoInput('github.com/facebook/react'), { owner: 'facebook', repo: 'react' });
  assert.deepEqual(parseRepoInput('  facebook/react/  '), { owner: 'facebook', repo: 'react' });
  assert.equal(parseRepoInput(''), null);
  assert.equal(parseRepoInput('facebook'), null, '只有 owner 不算仓库');
  assert.equal(parseRepoInput('foo bar/baz'), null, '含空格等非法字符要拒绝');
  assert.equal(parseRepoInput('a/../b'), null);
  assert.equal(parseRepoInput(null), null);
});

test('项目目录名、下载 URL 与请求头', () => {
  assert.equal(PROJECTS_DIR, 'projects');
  assert.equal(projectDirectoryName('a', 'b'), 'a__b', 'owner__repo，避免不同 owner 同名仓库互相覆盖');
  assert.equal(buildRepoZipUrl('a', 'b'), 'https://api.github.com/repos/a/b/zipball');
  assert.equal(buildRepoZipUrl('a', 'b', 'main'), 'https://api.github.com/repos/a/b/zipball/main');
  assert.equal(buildRepoZipUrl('a', 'b', '  '), 'https://api.github.com/repos/a/b/zipball', '空白分支按默认处理');
  assert.equal(buildRepoHeaders('').Authorization, undefined, '没有令牌时不带 Authorization');
  assert.equal(buildRepoHeaders('  ').Authorization, undefined);
  assert.equal(buildRepoHeaders('t').Authorization, 'Bearer t');
  assert.equal(buildRepoHeaders('t').Accept, 'application/vnd.github+json');
});

test('extractRepoFiles：剥掉 zipball 顶层目录，跳过二进制与超大文件', () => {
  const zip = zipSync({
    'owner-repo-abc123/README.md': strToU8('# hi'),
    'owner-repo-abc123/src/index.js': strToU8('export default 1;'),
    'owner-repo-abc123/logo.png': strToU8('binary-ish'),
  });
  const { files, skipped, total } = extractRepoFiles(zip);
  assert.deepEqual(files.map(item => item.path).sort(), ['README.md', 'src/index.js']);
  assert.equal(files.find(item => item.path === 'README.md').content, '# hi');
  assert.equal(skipped, 1, 'png 属二进制黑名单，跳过');
  assert.equal(total, 3);

  // 单文件仓库同样剥掉顶层目录
  const single = extractRepoFiles(zipSync({ 'owner-repo-x/LICENSE': strToU8('MIT') }));
  assert.deepEqual(single.files.map(item => item.path), ['LICENSE']);

  // 超大文件跳过
  const big = zipSync({ 'owner-repo-x/big.txt': new Uint8Array(2000) });
  const limited = extractRepoFiles(big, { maxFileBytes: 1000 });
  assert.equal(limited.files.length, 0);
  assert.equal(limited.skipped, 1);

  // 文件数上限：多余的计入 skipped，不静默丢弃
  const many = {};
  for (let index = 0; index < 10; index += 1) many[`owner-repo-x/f${index}.txt`] = strToU8('x');
  const capped = extractRepoFiles(zipSync(many), { maxFiles: 4 });
  assert.equal(capped.files.length, 4);
  assert.equal(capped.skipped, 6);
});

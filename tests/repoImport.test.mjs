// GitHub 仓库快照导入：纯函数测试（URL/解析/zip-slip/限额/解压）+ 套餐定义测试。

import test from 'node:test';
import assert from 'node:assert/strict';
import { strToU8, zipSync } from 'fflate';

import {
  buildBranchesApiUrl,
  buildRepoApiUrl,
  buildRepoZipUrl,
  buildReposApiUrl,
  extractRepoFiles,
  parseRepoFullName,
  REPO_IMPORT_LIMITS,
  scanRepoZipball,
  stripZipballEntry,
} from '../src/workspace/repoImport.js';
import { CATALOG_BUNDLES, findCatalogBundle, findCatalogItem, buildCatalogContent } from '../src/workspace/catalog.js';
import fs from 'node:fs';
import path from 'node:path';

test('URL 构造：列表/仓库/分支/codeload', () => {
  assert.equal(buildReposApiUrl({ page: 2 }), 'https://api.github.com/user/repos?sort=pushed&per_page=30&visibility=all&page=2');
  assert.equal(buildRepoApiUrl({ owner: 'a', repo: 'b' }), 'https://api.github.com/repos/a/b');
  assert.equal(buildBranchesApiUrl({ owner: 'a', repo: 'b' }), 'https://api.github.com/repos/a/b/branches?per_page=100');
  assert.equal(
    buildRepoZipUrl({ owner: 'a', repo: 'b', branch: 'feat/x' }),
    'https://codeload.github.com/a/b/zip/refs/heads/feat%2Fx',
    '分支名里的 / 必须编码'
  );
});

test('parseRepoFullName：owner/repo、URL、@前缀，非法返回 null', () => {
  assert.deepEqual(parseRepoFullName('octocat/hello'), { owner: 'octocat', repo: 'hello' });
  assert.deepEqual(parseRepoFullName('https://github.com/octocat/hello-world'), { owner: 'octocat', repo: 'hello-world' });
  assert.deepEqual(parseRepoFullName('https://github.com/octocat/hello.git'), { owner: 'octocat', repo: 'hello' });
  assert.deepEqual(parseRepoFullName('@octocat/hello'), { owner: 'octocat', repo: 'hello' });
  assert.equal(parseRepoFullName('hello'), null);
  assert.equal(parseRepoFullName(''), null);
});

test('stripZipballEntry：剥顶层目录，越界/绝对路径一律拒', () => {
  assert.equal(stripZipballEntry('repo-main/src/app.js', 'repo-main/'), 'src/app.js');
  assert.equal(stripZipballEntry('repo-main/README.md', 'repo-main/'), 'README.md');
  assert.equal(stripZipballEntry('repo-main/', 'repo-main/'), '', '顶层目录本身');
  assert.equal(stripZipballEntry('evil/../../etc/passwd', 'evil/'), '', '越界');
  assert.equal(stripZipballEntry('/etc/passwd', 'repo-main/'), '', '绝对路径剥不掉前缀');
  assert.equal(stripZipballEntry('other/file.txt', 'repo-main/'), '', '不属于本包');
  assert.equal(stripZipballEntry('repo-main/a//b.js', 'repo-main/'), 'a/b.js', '空段折叠');
});

function buildZipball(root, entries) {
  const tree = {};
  for (const [name, content] of Object.entries(entries)) {
    tree[`${root}${name}`] = typeof content === 'string' ? strToU8(content) : content;
  }
  return zipSync(tree);
}

test('scanRepoZipball：正常快照扫描出文件清单与跳过计数', () => {
  const bytes = buildZipball('demo-main/', {
    'README.md': 'hello',
    'src/app.js': 'console.log(1)',
    '.gitignore': 'node_modules',
  });
  const scan = scanRepoZipball(bytes, 'demo-main/');
  assert.deepEqual(scan.files.map(item => item.path).sort(), ['.gitignore', 'README.md', 'src/app.js']);
  assert.equal(scan.skippedSlip, 0);
  assert.equal(scan.totalBytes, 'hello'.length + 'console.log(1)'.length + 'node_modules'.length);
});

test('scanRepoZipball：zip-slip 条目被跳过并计数', () => {
  // fflate 不允许直接造带 .. 的键？可以：键名原样进 zip 目录。
  const bytes = buildZipball('demo-main/', { 'safe.txt': 'ok' });
  const malicious = zipSync({
    'demo-main/safe.txt': strToU8('ok'),
    'demo-main/../../../evil.txt': strToU8('bad'),
    'demo-main/': new Uint8Array(0),
  });
  const scan = scanRepoZipball(malicious, 'demo-main/');
  assert.deepEqual(scan.files.map(item => item.path), ['safe.txt']);
  assert.ok(scan.skippedSlip >= 1, '越界条目必须计数');
  assert.ok(bytes.length > 0);
});

test('scanRepoZipball：条目数/总量/包大小限额（用缩小限额测，避免构造超大 zip）', () => {
  const bytes = buildZipball('demo-main/', {
    'a.txt': '1',
    'b.txt': '2',
    'c.txt': '3',
    'd.txt': '4',
  });
  assert.throws(
    () => scanRepoZipball(bytes, 'demo-main/', { ...REPO_IMPORT_LIMITS, MAX_ENTRIES: 3 }),
    error => error.code === 'REPO_LIMIT_ENTRIES'
  );
  assert.throws(
    () => scanRepoZipball(bytes, 'demo-main/', { ...REPO_IMPORT_LIMITS, MAX_TOTAL_UNCOMPRESSED_BYTES: 2 }),
    error => error.code === 'REPO_LIMIT_TOTAL'
  );
  const tinyLimits = { ...REPO_IMPORT_LIMITS, MAX_DOWNLOAD_BYTES: 10 };
  assert.throws(
    () => scanRepoZipball(zipSync({ 'demo-main/a.txt': strToU8('hello world') }), 'demo-main/', tinyLimits),
    error => error.code === 'REPO_LIMIT_DOWNLOAD'
  );
});

test('extractRepoFiles：只落文本，二进制与超限跳过并计数', () => {
  const bytes = buildZipball('demo-main/', {
    'README.md': '文本内容',
    'src/index.js': 'export default 1;',
    'logo.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    'big.log': 'x'.repeat(REPO_IMPORT_LIMITS.MAX_FILE_BYTES + 1),
  });
  const { files, skippedBinary, skippedOversize } = extractRepoFiles(bytes, 'demo-main/');
  const paths = files.map(item => item.path).sort();
  assert.deepEqual(paths, ['README.md', 'src/index.js']);
  assert.equal(files.find(item => item.path === 'src/index.js').content, 'export default 1;');
  assert.equal(skippedBinary, 1, 'png 计入二进制跳过');
  assert.equal(skippedOversize, 1, '超过单文件上限的 big.log 计入超限跳过');
});

test('套餐：id 引用的条目都存在，full 含 gitconfig 且需提交身份', () => {
  for (const bundle of CATALOG_BUNDLES) {
    for (const itemId of bundle.items) {
      assert.ok(findCatalogItem(itemId), `套餐 ${bundle.id} 引用了不存在的条目 ${itemId}`);
    }
    assert.ok(findCatalogBundle(bundle.id));
  }
  assert.equal(findCatalogBundle('full').needsGitIdentity, true);
  assert.equal(findCatalogBundle('standard').items.length, 4);
  assert.equal(findCatalogBundle('mirror').items.length, 2);
  // 完整包写入数 = 7（与 .gitconfig 一起）。
  const gitconfig = findCatalogItem('gitconfig');
  assert.match(buildCatalogContent(gitconfig, { userName: 'zh', userEmail: 'z@e.com' }), /name = zh/);
});

test('接线源码断言：重排顺序 + 套餐接线 + 导入入口', () => {
  const panel = fs.readFileSync(path.resolve('src/WorkspacePanel.js'), 'utf8');
  const order = [
    panel.indexOf('styles.statusBar'),
    panel.indexOf('styles.chatPrimary'),
    panel.indexOf('styles.importRow'),
    panel.indexOf('styles.fileToolsRow'),
    panel.indexOf('styles.collapsedHeader'),
  ];
  assert.ok(order.every(index => index > 0), '五个区块都存在');
  assert.deepEqual([...order].sort((a, b) => a - b), order, '顺序必须为 状态条→对话→导入行→文件工具→折叠卡');
  assert.ok(panel.includes('setChatOpen(true)'), '对话入口保持既有行为');
  // 定义与按钮绑定都要在：只留定义不解绑按钮不算接线（注入验证抓过子串盲区）。
  assert.match(panel, /const handleBundleWrite = useCallback/, '套餐一键写入（定义）');
  assert.match(panel, /onPress=\{\(\) => handleBundleWrite\(bundle\.id\)\}/, '套餐一键写入（按钮绑定）');
  assert.ok(panel.includes('catalogStatuses'), '写入状态徽章已接线');
  assert.ok(panel.includes('<WorkspaceRepoSheet'), 'GitHub 导入弹层已挂载');
  // 旧布局的杂混按钮行不得复活
  assert.ok(!panel.includes('styles.chatLauncher'), '旧底部对话入口应被移除');
  // 凭据单一来源：repo 弹层复用 MCP 设置里的 token，不得新建第二套凭据存储。
  const sheet = fs.readFileSync(path.resolve('src/workspace/WorkspaceRepoSheet.js'), 'utf8');
  // 定义（import）与实际调用都要在：只留 import 不调用等于凭据断链（注入验证抓过）。
  assert.match(sheet, /await getGithubMcpSettings\(\)/, '凭据必须实际取自 MCP 设置');
  assert.ok(!sheet.includes('AsyncStorage') && !sheet.includes('@easychat2_'), '弹层不得自建凭据存储键');
  // 安全分级不动：弹层文案如实声明快照边界，不得出现绕过分级的话术。
  assert.ok(sheet.includes('snapshotNote') || sheet.includes('快照'), '快照边界文案必须在位');
});

// GitHub 仓库快照导入：纯函数测试（URL/解析/zip-slip/限额/解压）+ 套餐定义测试。

import test from 'node:test';
import assert from 'node:assert/strict';
import { strToU8, zipSync } from 'fflate';

import {
  buildBranchesApiUrl,
  buildRepoApiUrl,
  buildRepoZipUrl,
  buildReposApiUrl,
  clearPullManifest,
  extractRepoFiles,
  parsePullManifest,
  parseRepoFullName,
  PULL_MANIFEST_PATH,
  parseRepoManifest,
  readPullManifest,
  readRepoManifest,
  repoManifestPath,
  REPO_IMPORT_LIMITS,
  scanRepoZipball,
  stripZipballEntry,
  writePullManifest,
  writeRepoManifest,
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

test('extractRepoFiles：跳过 zip 目录条目——.github/ 不得变成 0 字节文件（真机死亡链）', () => {
  // 真实 GitHub zipball 会把目录也列成条目（名字以 / 结尾、size=0）。此前它们被
  // stripZipballEntry 折成 '.github' 当 0 字节文本写入，随后 '.github/workflows' 建
  // 同名父目录时撞上该文件 → ENOTDIR → 整包回滚。任何前部带子目录的仓库必死。
  const bytes = zipSync({
    'demo-main/': new Uint8Array(0),
    'demo-main/.c8rc.json': strToU8('{}'),
    'demo-main/.gitattributes': strToU8('* text=auto'),
    'demo-main/.github/': new Uint8Array(0),
    'demo-main/.github/workflows/': new Uint8Array(0),
    'demo-main/.github/workflows/ci.yml': strToU8('name: ci'),
  });
  const scan = scanRepoZipball(bytes, 'demo-main/');
  assert.deepEqual(scan.files.map(item => item.path).sort(),
    ['.c8rc.json', '.gitattributes', '.github/workflows/ci.yml']);
  assert.ok(scan.skippedDirs >= 2, '目录条目必须计数');

  const { files, skippedDirs } = extractRepoFiles(bytes, 'demo-main/');
  const paths = files.map(item => item.path).sort();
  assert.deepEqual(paths, ['.c8rc.json', '.gitattributes', '.github/workflows/ci.yml']);
  assert.ok(!paths.includes('.github'), '目录条目不得被当成文件落盘');
  assert.ok(skippedDirs >= 2, '目录条目在 extract 结果里也要计数');
  assert.equal(files.find(item => item.path === '.github/workflows/ci.yml').content, 'name: ci');
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

test('接线源码断言：文件面板区块顺序 + 套餐接线 + GitHub 工作台单一导入入口', () => {
  const panel = fs.readFileSync(path.resolve('src/workspace/screen/FilesPanel.js'), 'utf8');
  const order = [
    panel.indexOf('styles.statusBar'),
    panel.indexOf('styles.importRow'),
    panel.indexOf('styles.fileToolsRow'),
    panel.indexOf('styles.collapsedHeader'),
  ];
  assert.ok(order.every(index => index > 0), '四个区块都存在');
  assert.deepEqual([...order].sort((a, b) => a - b), order, '顺序必须为 状态条→导入行→文件工具→折叠卡');
  // 定义与按钮绑定都要在：只留定义不解绑按钮不算接线（注入验证抓过子串盲区）。
  assert.match(panel, /const handleBundleWrite = useCallback/, '套餐一键写入（定义）');
  assert.match(panel, /onPress=\{\(\) => handleBundleWrite\(bundle\.id\)\}/, '套餐一键写入（按钮绑定）');
  assert.ok(panel.includes('catalogStatuses'), '写入状态徽章已接线');
  // 旧布局的杂混按钮行不得复活；聊天入口归单屏，不再挂在文件面板上。
  assert.ok(!panel.includes('styles.chatLauncher'), '旧底部对话入口应被移除');
  assert.ok(!panel.includes('setChatOpen(true)'), '聊天入口不再是文件面板的一部分');
  assert.ok(!panel.includes('WorkspaceRepoSheet'), 'GitHub 导入不再是文件面板内的弹层');

  // 凭据单一来源：GitHub 工作台复用 MCP 设置里的 token，不得新建第二套凭据存储。
  const github = fs.readFileSync(path.resolve('src/workspace/screen/GithubPanel.js'), 'utf8');
  assert.match(github, /await getGithubMcpSettings\(\)/, '凭据必须实际取自 MCP 设置');
  assert.ok(!github.includes('AsyncStorage') && !github.includes('@easychat2_'), '面板不得自建凭据存储键');
  // 快照边界如实声明；拉取链路必须复用 repoImport 的限额与解压（含目录条目修复）。
  assert.ok(github.includes('workspace.github.pull.hint'), '快照边界文案必须在位');
  assert.ok(github.includes('extractRepoFiles(') && github.includes('REPO_IMPORT_LIMITS'), '拉取复用 repoImport 的解压与限额');
});

test('F4 拉取残留清单：解析容错 + 写入/读取/清理往返（全不抛错）', async () => {
  // 解析：坏输入一律 null（当作没有），不抛错
  assert.equal(parsePullManifest('{bad'), null);
  assert.equal(parsePullManifest('[]'), null);
  assert.equal(parsePullManifest(null), null);
  assert.equal(parsePullManifest({ owner: 'a' }), null, '缺 repo/branch 视为无效');
  assert.deepEqual(
    parsePullManifest(JSON.stringify({ owner: 'a', repo: 'b', branch: 'main', files: 3 })),
    { owner: 'a', repo: 'b', branch: 'main', files: 3, at: 0 }
  );
  assert.deepEqual(
    parsePullManifest({ owner: 'a', repo: 'b', branch: 'm', files: ['x', 'y'], at: 5 }),
    { owner: 'a', repo: 'b', branch: 'm', files: 2, at: 5 },
    '数组形态兼容（取长度）'
  );

  // IO 往返：fake store（内存）
  const files = {};
  const store = {
    async writeWorkspaceFile({ path: file, content }) { files[file] = content; },
    async readWorkspaceFile({ path: file }) {
      if (!(file in files)) throw new Error('missing');
      return { content: files[file] };
    },
    async deleteFile({ path: file }) { delete files[file]; },
  };
  assert.equal(
    await writePullManifest(store, 'c1', { owner: 'a', repo: 'b', branch: 'main', files: 3 }),
    true
  );
  assert.ok(PULL_MANIFEST_PATH in files, '清单落在 .easychat/ 下（与 skills 同域）');
  const manifest = await readPullManifest(store, 'c1');
  assert.equal(manifest.files, 3);
  assert.equal(await clearPullManifest(store, 'c1'), true);
  assert.equal(await readPullManifest(store, 'c1'), null, '清理后视为没有（= 上次跑完了）');

  // 旁路机制：缺 store / 读写失败都不得抛错、不得挡住拉取主流程
  assert.equal(await readPullManifest(null, 'c1'), null);
  assert.equal(await writePullManifest(null, 'c1', {}), false);
  assert.equal(await clearPullManifest(null, 'c1'), false);
  const failing = { async writeWorkspaceFile() { throw new Error('no space'); } };
  assert.equal(await writePullManifest(failing, 'c1', { owner: 'a', repo: 'b', branch: 'm' }), false, '写失败返回 false 不抛');
});

test('C1 仓库清单：路径编码（branch 含斜杠不造假目录）+ 解析容错 + IO 往返', async () => {
  assert.equal(
    repoManifestPath({ owner: 'o', repo: 'r', branch: 'feature/x' }),
    '.easychat/repos-manifest/o__r__feature%2Fx.json',
    'branch 的斜杠被编码，不与 owner/repo 段混淆'
  );
  // 解析：坏输入一律 null（当作没有清单）
  assert.equal(parseRepoManifest('{bad'), null);
  assert.equal(parseRepoManifest('[]'), null);
  assert.equal(parseRepoManifest(null), null);
  assert.deepEqual(
    parseRepoManifest({ entries: [{ path: 'a.js' }], truncated: true, at: 7 }),
    { entries: [{ path: 'a.js', type: 'blob', sha: '', size: 0 }], truncated: true, at: 7 }
  );
  assert.equal(parseRepoManifest({ entries: [{ path: 'd/' }] }).entries[0].type, 'tree', '尾斜杠推断 tree');

  // IO 往返（fake store 内存）
  const files = {};
  const store = {
    async writeWorkspaceFile({ path: file, content }) { files[file] = content; },
    async readWorkspaceFile({ path: file }) {
      if (!(file in files)) throw new Error('missing');
      return { content: files[file] };
    },
  };
  const key = { owner: 'o', repo: 'r', branch: 'main' };
  assert.equal(await writeRepoManifest(store, 'c1', key, {
    entries: [{ path: 'src/a.js', type: 'blob' }],
    truncated: false,
  }), true);
  assert.ok('.easychat/repos-manifest/o__r__main.json' in files, '清单落盘在专属子目录');
  const manifest = await readRepoManifest(store, 'c1', key);
  assert.equal(manifest.entries.length, 1);
  assert.equal(await readRepoManifest(store, 'c1', { owner: 'o', repo: 'r', branch: 'nope' }), null);
  // 无 store 全部安全（旁路机制不挡主流程）
  assert.equal(await readRepoManifest(null, 'c1', key), null);
  assert.equal(await writeRepoManifest(null, 'c1', key, {}), false);
});

test('C1 快速检出接线：Trees API + 清单落盘/载入 + 树合并（云朵角标）+ 截断如实提示', () => {
  const github = fs.readFileSync(path.resolve('src/workspace/screen/GithubPanel.js'), 'utf8');
  assert.ok(github.includes('listTree({'), 'Trees API 接线（1 次请求出全树）');
  assert.ok(github.includes('writeRepoManifest('), '检出结果落盘缓存');
  assert.ok(github.includes('readRepoManifest('), '打开仓库时载入清单');
  assert.ok(github.includes('mergeManifestEntries('), '树 = 本地 ∪ 清单');
  assert.ok(github.includes('virtualPaths.has(child.path)'), '未物化条目带云朵角标');
  assert.ok(github.includes("t('workspace.github.checkout.truncatedHint')"), '截断如实提示（不假装拿全）');
  assert.ok(
    github.includes('const paths = entries.filter(item => item.type'),
    '清单设为「已同步」基线（与完整拉取同语义）'
  );
});

test('B1/B2/B3 拉取体验接线：分支 chip + 默认分支对齐 + 覆盖守卫（下载之前）', () => {
  const github = fs.readFileSync(path.resolve('src/workspace/screen/GithubPanel.js'), 'utf8');
  // B1：数据层 listBranches 早已存在，UI 必须真的调用它（之前是裸输入框、手打分支名）
  assert.ok(github.includes('listBranches({ token, owner, repo })'), '分支列表接线（第一页）');
  assert.ok(github.includes('listBranches({ token, owner, repo, page: 2 })'), '超过一页时翻第 2 页');
  assert.ok(github.includes("t('workspace.github.branch.defaultTag')"), '默认分支徽标');
  assert.ok(github.includes("t('workspace.github.branch.loadError')"), '失败态：一行提示、不阻塞手动输入');
  assert.ok(github.includes("t('workspace.github.branch.overLimit')"), '超量提示（其余手动输入）');
  assert.ok(github.includes('branchSeqRef'), '竞态防护：快速切仓库旧响应不覆盖新列表');
  // B2：初值与该仓库真实默认分支同源（normalizeRepo.defaultBranch），不再硬编码 main
  assert.ok(github.includes('current.branch || current.defaultBranch'), '初值对齐默认分支');
  // B3：覆盖守卫——守卫调用必须在下载之前（取消 = 连 zip 都不下载）
  assert.ok(github.includes('confirmPullOverwrite'), '覆盖确认存在');
  const guardAt = github.indexOf('confirmPullOverwrite(guardDiff.pending)');
  const downloadAt = github.indexOf('await downloadZip({ url, token })');
  assert.ok(guardAt > 0 && downloadAt > 0 && guardAt < downloadAt, '守卫在下载之前');
  assert.ok(github.includes('guardLocal.length > 0'), '首次拉取（本地为空）不拦——只拦未推送改动');
});

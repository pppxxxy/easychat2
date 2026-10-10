// C3 批量单提交测试：SHA-1 / git blob sha（与 Node crypto 对拍）/ base64 /
// 三态 diff / pushRepoSnapshot 全链路（fake request 分派）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  bytesToBase64,
  collectRollbackEntries,
  computeGitBlobSha,
  diffRemoteLocal,
  pushRepoSnapshot,
  ROLLBACK_MAX_FILES,
  ROLLBACK_MAX_FILE_CHARS,
  sha1Hex,
} from '../src/workspace/repoPush.js';

const nodeSha1 = bytes => createHash('sha1').update(Buffer.from(bytes)).digest('hex');

test('sha1Hex：RFC 3174 已知向量', () => {
  const bytes = text => new TextEncoder().encode(text);
  assert.equal(sha1Hex(bytes('')), 'da39a3ee5e6b4b0d3255bfef95601890afd80709');
  assert.equal(sha1Hex(bytes('abc')), 'a9993e364706816aba3e25717850c26c9cd0d89d');
  assert.equal(
    sha1Hex(bytes('The quick brown fox jumps over the lazy dog')),
    '2fd4e1c67a2d28fced849ee1bb76e7391b93eb12'
  );
  // 需要 2 个分块 + 补位跨块的输入（55/56/64 字节边界）
  for (const length of [55, 56, 63, 64, 65, 200]) {
    const input = bytes('a'.repeat(length));
    assert.equal(sha1Hex(input), nodeSha1(input), `边界长度 ${length}`);
  }
});

test('computeGitBlobSha：与 Node crypto 对拍（空/多行/中文/emoji/长文本）+ 知名向量', () => {
  const cases = [
    '',
    'hello\n',
    '# 标题\n\n正文',
    '表情 😀🚀 混合',
    'x'.repeat(5000),
    '行1\n行2\n'.repeat(300),
  ];
  for (const text of cases) {
    const data = Buffer.from(text, 'utf8');
    const expected = nodeSha1(Buffer.concat([Buffer.from(`blob ${data.length}\0`, 'utf8'), data]));
    assert.equal(computeGitBlobSha(text), expected, `对拍失败：${JSON.stringify(text.slice(0, 16))}`);
  }
  // git 里空 blob 的知名 sha（GitHub 上任何一个空文件的 sha）
  assert.equal(computeGitBlobSha(''), 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
});

test('bytesToBase64：与 Buffer 对拍（空/补位/多字节）', () => {
  const cases = [
    new Uint8Array([]),
    new Uint8Array([1]),
    new Uint8Array([1, 2]),
    new Uint8Array([1, 2, 3]),
    new Uint8Array([255, 254, 253, 252]),
    new TextEncoder().encode('中文 base64 测试'),
  ];
  for (const bytes of cases) {
    assert.equal(bytesToBase64(bytes), Buffer.from(bytes).toString('base64'));
  }
});

test('diffRemoteLocal：新增/修改/删除三态（blob 才比较，目录忽略）', () => {
  const localFiles = [
    { path: 'a.js', sha: 'sha-a' },
    { path: 'b.js', sha: 'sha-b-new' },
    { path: 'c.js', sha: 'sha-c' },
  ];
  const remoteEntries = [
    { path: 'b.js', type: 'blob', sha: 'sha-b-old' },
    { path: 'c.js', type: 'blob', sha: 'sha-c' },
    { path: 'd.js', type: 'blob', sha: 'sha-d' },
    { path: 'dir', type: 'tree', sha: 'tree-x' },
  ];
  // G1 新语义：删除需要「曾经物化过」的证据（knownPaths）——d.js 在基线里有过 → 真删除
  assert.deepEqual(diffRemoteLocal({ localFiles, remoteEntries, knownPaths: ['d.js'] }), {
    added: ['a.js'],
    modified: ['b.js'],
    removed: ['d.js'],
    // G1 可见性：未物化的远程文件（目录不算）单独报出；
    // 分母 = 远程 ∧ known，而 known 按设计并入本次本地文件 → b.js/c.js/d.js 三个
    remoteOnly: [],
    knownRemoteCount: 3,
    pending: 3,
  });
  assert.equal(diffRemoteLocal({}).pending, 0);
});

test('G1 删除安全：knownPaths 缺失/不含 → removed 恒空；前缀剥离；并集覆盖本地', () => {
  const localFiles = [{ path: 'a.js', sha: 'sha-a' }];
  const remoteEntries = [
    { path: 'a.js', type: 'blob', sha: 'sha-a' },
    { path: 'skip.png', type: 'blob', sha: 'sha-png' }, // 拉取时被跳过的二进制
    { path: 'gone.js', type: 'blob', sha: 'sha-gone' }, // 用户真删过的
  ];
  // 核心 BUG 场景：无基线（旧会话/手工拷入）——被跳过的文件绝不能被判删除
  assert.deepEqual(diffRemoteLocal({ localFiles, remoteEntries }).removed, [], '无 knownPaths → 宁可少删');
  assert.deepEqual(diffRemoteLocal({ localFiles, remoteEntries, knownPaths: [] }).removed, []);
  // 基线只含 skip.png（它没过用户手，只是从没落地）→ 仍不算删除（不在 known 里……）
  // 注意：knownPaths 语义是「拉取/推送成功后的本地清单」——skip.png 从不在本地清单里，
  // 所以真实基线也不含它；这里验证即使误把远程全集当基线，语义仍安全：
  assert.deepEqual(
    diffRemoteLocal({ localFiles, remoteEntries, knownPaths: ['gone.js'] }).removed,
    ['gone.js'],
    '只有基线里有过、现在没有的才算删除'
  );
  // 前缀剥离：宿主传的是含前缀完整路径，diff 内部剥前缀后再比对
  assert.deepEqual(
    diffRemoteLocal({
      localFiles,
      remoteEntries,
      knownPaths: ['repos/o/r/main/gone.js', 'repos/o/r/main/a.js'],
      prefix: 'repos/o/r/main/',
    }).removed,
    ['gone.js']
  );
  // 本次本地文件天然并入 known（防御基线滞后）：删掉本地文件后它不在 local 里，
  // 但仍在 known（基线），进 removed；未变过的本地文件不受影响
  assert.deepEqual(
    diffRemoteLocal({ localFiles, remoteEntries, knownPaths: new Set(['a.js']) }).removed,
    []
  );
});

const SCENE_STORE = {
  async listWorkspaceFiles() {
    return [
      'repos/o/r/main/',
      'repos/o/r/main/add.txt',
      'repos/o/r/main/mod.txt',
      'repos/o/r/main/same.txt',
    ];
  },
  async readWorkspaceFile({ path }) {
    const contents = {
      'repos/o/r/main/add.txt': 'brand new',
      'repos/o/r/main/mod.txt': 'changed content',
      'repos/o/r/main/same.txt': 'same content',
    };
    return { content: contents[path] };
  },
};

const SCENE_TREE = {
  truncated: false,
  tree: [
    { path: 'dir', type: 'tree', sha: 'tree-dir', size: 0 },
    { path: 'mod.txt', type: 'blob', sha: 'old-sha-mod', size: 10 },
    { path: 'same.txt', type: 'blob', sha: computeGitBlobSha('same content'), size: 12 },
    { path: 'gone.txt', type: 'blob', sha: 'gone-sha', size: 3 },
  ],
};

// mock fetch（与 workspaceGithubApi 测试同款）：顺带覆盖真实的 request 层
// （超时/退避/限流解析都是活代码）。
function makeResponse(status, data) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => data,
  };
}

function fetchMock(handler) {
  return async (url, init = {}) => {
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    return handler(String(url), method, body);
  };
}

test('pushRepoSnapshot：新增/修改/未改/删除 → 一次提交（blob 只发新增+修改、删除为 sha:null）', async () => {
  const calls = [];
  let blobCount = 0;
  const fetchImpl = fetchMock((url, method, body) => {
    calls.push({ url, method, body });
    if (url.includes('/git/trees/') && url.includes('recursive=1')) return makeResponse(200, SCENE_TREE);
    if (url.includes('/git/ref/heads/')) return makeResponse(200, { object: { sha: 'parent1' } });
    if (url.endsWith('/git/blobs')) {
      blobCount += 1;
      return makeResponse(201, { sha: `blob-new-${blobCount}` });
    }
    if (url.endsWith('/git/trees') && method === 'POST') return makeResponse(201, { sha: 'tree1' });
    if (url.endsWith('/git/commits')) return makeResponse(201, { sha: 'commit1' });
    if (url.includes('/git/refs/heads/')) return makeResponse(200, { object: { sha: 'commit1' } });
    throw new Error(`unexpected ${method} ${url}`);
  });
  const confirmCalls = [];
  const confirmBaselineMissing = [];
  const result = await pushRepoSnapshot({
    store: SCENE_STORE,
    characterId: 'c1',
    owner: 'o',
    repo: 'r',
    branch: 'main',
    token: 't',
    // G1：模拟拉取时写入的基线（四个文件都落地过）——gone.txt 本地没了才是真删除
    baselinePaths: [
      'repos/o/r/main/add.txt',
      'repos/o/r/main/mod.txt',
      'repos/o/r/main/same.txt',
      'repos/o/r/main/gone.txt',
    ],
    fetchImpl,
    sleepImpl: async () => {},
    confirm: async ({ diff, baselineMissing }) => {
      confirmCalls.push(diff);
      confirmBaselineMissing.push(baselineMissing);
      return true;
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.commit, 'commit1');
  assert.deepEqual(confirmCalls, [
    {
      added: ['add.txt'],
      modified: ['mod.txt'],
      removed: ['gone.txt'],
      remoteOnly: [],
      knownRemoteCount: 3,
      pending: 3,
    },
  ], '确认框拿到三态计数（含 G1 的 remoteOnly / knownRemoteCount 与无基线标记）');
  assert.equal(confirmBaselineMissing[0], false, '有基线时 baselineMissing=false');
  assert.equal(blobCount, 2, '只对新增/修改创建 blob（未改文件零请求）');

  const treeCall = calls.find(item => item.url.endsWith('/git/trees') && item.method === 'POST');
  const byPath = new Map(treeCall.body.tree.map(item => [item.path, item]));
  assert.equal(byPath.get('same.txt').sha, computeGitBlobSha('same content'), '未改沿用远程 sha');
  // 并发池的完成顺序不定：断言语义（是新 blob、互不相同）而不是编号
  const addSha = byPath.get('add.txt').sha;
  const modSha = byPath.get('mod.txt').sha;
  assert.match(addSha, /^blob-new-\d+$/, '新增用新 blob');
  assert.match(modSha, /^blob-new-\d+$/, '修改用新 blob（不是远程旧 sha）');
  assert.notEqual(addSha, modSha, '两个文件各自创建 blob');
  assert.equal(byPath.get('gone.txt').sha, null, '删除 = sha:null 条目');
  assert.equal(byPath.has('dir'), false, '目录不进条目（GitHub 按 path 自动建树）');

  const commitCall = calls.find(item => item.url.endsWith('/git/commits'));
  assert.deepEqual(commitCall.body.parents, ['parent1'], '父提交 = ref 指向的 commit');
  assert.equal(commitCall.body.tree, 'tree1');
  const refCall = calls.find(item => item.url.includes('/git/refs/heads/'));
  assert.deepEqual(refCall.body, { sha: 'commit1', force: false }, '绝不 force（非快进被 GitHub 拒绝）');
});

test('pushRepoSnapshot：空 diff / 取消 / truncated —— 都不写远程', async () => {
  // 空 diff：本地与远程完全一致 → empty，只拉了一次远程树
  const calls = [];
  const empty = await pushRepoSnapshot({
    store: {
      async listWorkspaceFiles() { return ['repos/o/r/main/', 'repos/o/r/main/a.txt']; },
      async readWorkspaceFile() { return { content: 'same' }; },
    },
    owner: 'o',
    repo: 'r',
    branch: 'main',
    fetchImpl: fetchMock(url => {
      calls.push(url);
      return makeResponse(200, { truncated: false, tree: [{ path: 'a.txt', type: 'blob', sha: computeGitBlobSha('same') }] });
    }),
    sleepImpl: async () => {},
  });
  assert.deepEqual(empty, {
    empty: true,
    diff: { added: [], modified: [], removed: [], remoteOnly: [], knownRemoteCount: 1, pending: 0 },
  });
  assert.equal(calls.length, 1, '空 diff 只拉远程树，零写操作');

  // 取消：confirm=false → 什么都不发
  const calls2 = [];
  const cancelled = await pushRepoSnapshot({
    store: SCENE_STORE,
    owner: 'o',
    repo: 'r',
    branch: 'main',
    fetchImpl: fetchMock(url => {
      calls2.push(url);
      return makeResponse(200, SCENE_TREE);
    }),
    confirm: async () => false,
    sleepImpl: async () => {},
  });
  assert.equal(cancelled.cancelled, true);
  assert.equal(calls2.length, 1, '取消后零写操作（连父提交都没查）');

  // truncated：清单不完整 → 拒绝推送（完整树会把看不见的文件全删）
  const truncated = await pushRepoSnapshot({
    store: SCENE_STORE,
    owner: 'o',
    repo: 'r',
    branch: 'main',
    fetchImpl: fetchMock(() => makeResponse(200, { truncated: true, tree: [] })),
    sleepImpl: async () => {},
  });
  assert.deepEqual(truncated, { ok: false, reason: 'truncated' });
});

test('G1 端到端复现：被跳过的远程二进制（本地没有、无基线）绝不进删除清单', async () => {
  // 场景 = 用户实测：拉取仓库 → 二进制被跳过（本地没有）→ 直接推送。
  // 修复前：它们全进 removed → 确认一次就从远端真删；修复后：沿用远程 sha 原样传递。
  const calls = [];
  const store = {
    async listWorkspaceFiles() {
      return ['repos/o/r/main/', 'repos/o/r/main/a.txt', 'repos/o/r/main/new.txt'];
    },
    async readWorkspaceFile({ path }) {
      const contents = {
        'repos/o/r/main/a.txt': 'a',
        'repos/o/r/main/new.txt': 'brand new',
      };
      return { content: contents[path] };
    },
  };
  const remoteTree = {
    truncated: false,
    tree: [
      { path: 'a.txt', type: 'blob', sha: computeGitBlobSha('a'), size: 1 },
      { path: 'skip.png', type: 'blob', sha: 'sha-png', size: 100 }, // 拉取时被跳过的二进制
      { path: 'assets/logo.bin', type: 'blob', sha: 'sha-bin', size: 200 },
    ],
  };
  const fetchImpl = fetchMock((url, method, body) => {
    calls.push({ url, method, body });
    if (url.includes('/git/trees/') && url.includes('recursive=1')) return makeResponse(200, remoteTree);
    if (url.includes('/git/ref/heads/')) return makeResponse(200, { object: { sha: 'parent1' } });
    if (url.endsWith('/git/blobs')) return makeResponse(201, { sha: 'blob-new' });
    if (url.endsWith('/git/trees') && method === 'POST') return makeResponse(201, { sha: 'tree1' });
    if (url.endsWith('/git/commits')) return makeResponse(201, { sha: 'commit1' });
    if (url.includes('/git/refs/heads/')) return makeResponse(200, { object: { sha: 'commit1' } });
    throw new Error(`unexpected ${method} ${url}`);
  });
  // 模拟真实基线（拉取时写入的本地清单——跳过的文件从不在其中）
  const result = await pushRepoSnapshot({
    store,
    characterId: 'c1',
    owner: 'o',
    repo: 'r',
    branch: 'main',
    token: 't',
    baselinePaths: ['repos/o/r/main/a.txt'],
    fetchImpl,
    sleepImpl: async () => {},
    confirm: async () => true,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.diff.removed, [], '核心断言：被跳过的文件不被判删除');
  assert.deepEqual(result.diff.added, ['new.txt']);
  // 提交树条目：被跳过的文件**沿远程 sha 原样传递**、**没有任何 sha:null 条目**
  const treeCall = calls.find(item => item.url.endsWith('/git/trees') && item.method === 'POST');
  const byPath = new Map(treeCall.body.tree.map(item => [item.path, item.sha]));
  assert.equal(byPath.get('skip.png'), 'sha-png', '被跳过的二进制原样保留（sha 未变）');
  assert.equal(byPath.get('assets/logo.bin'), 'sha-bin', '子目录里的也一样');
  assert.equal(
    treeCall.body.tree.some(item => item.sha === null),
    false,
    '绝不出现删除条目（修复前这里会有 skip.png 与 logo.bin 的 sha:null）'
  );
  assert.equal(byPath.get('new.txt'), 'blob-new', '真正的新增照常上传');

  // 更直接：不传基线（旧会话）同样安全——再跑一次，断言 removed 恒空且无 sha:null
  const noBaseline = await pushRepoSnapshot({
    store,
    characterId: 'c1',
    owner: 'o',
    repo: 'r',
    branch: 'main',
    token: 't',
    fetchImpl,
    sleepImpl: async () => {},
    confirm: async () => true,
  });
  assert.deepEqual(noBaseline.diff.removed, [], '无基线 → 宁可少删');
});

test('H3 collectRollbackEntries：取回旧内容 / 超限与失败如实记账 / 文件数上限', async () => {
  const textResponse = text => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => text });
  const fetchImpl = fetchMock(url => {
    if (url.endsWith('/git/blobs/sha-a')) return textResponse('old-a');
    if (url.endsWith('/git/blobs/sha-big')) return textResponse('x'.repeat(ROLLBACK_MAX_FILE_CHARS + 1));
    throw new Error('boom'); // sha-fail：拉取失败
  });
  const entries = [
    { path: 'a.txt', type: 'blob', sha: 'sha-a' },
    { path: 'big.txt', type: 'blob', sha: 'sha-big' },
    { path: 'fail.txt', type: 'blob', sha: 'sha-fail' },
  ];
  const result = await collectRollbackEntries({
    fetchImpl,
    token: 't',
    owner: 'o',
    repo: 'r',
    entries,
    paths: ['a.txt', 'big.txt', 'fail.txt', 'ghost.txt'],
  });
  assert.equal(result.entries[0].content, 'old-a', '正常取回旧内容');
  assert.equal(result.entries[0].sha, 'sha-a');
  assert.equal(result.entries[1].content, null);
  assert.equal(result.entries[1].reason, 'too-large', '超单文件限额 → 只记 sha');
  assert.equal(result.entries[2].reason, 'fetch-failed', '拉取失败 → 如实记账（不挡推送）');
  assert.equal(result.entries[3].reason, 'no-sha', '远程无 sha 的路径防御');
  assert.equal(result.skippedCount, undefined, '4 条不超文件数上限');

  // 文件数上限：超出的计入 skippedCount（不静默丢）
  const many = Array.from({ length: ROLLBACK_MAX_FILES + 2 }, (_, i) => ({ path: `f${i}.txt`, sha: `sha-${i}` }));
  const capped = await collectRollbackEntries({
    fetchImpl: fetchMock(() => textResponse('x')),
    token: 't',
    owner: 'o',
    repo: 'r',
    entries: many.map(item => ({ path: item.path, type: 'blob', sha: item.sha })),
    paths: many.map(item => item.path),
  });
  assert.equal(capped.entries.length, ROLLBACK_MAX_FILES);
  assert.equal(capped.skippedCount, 2);
});

// G1 可见性（2026-10-10）：diff 要多报两件事，UI 才有依据把「安全」说清楚——
// ① remoteOnly：远程有而本地未物化（本次保持原样）的文件；② knownRemoteCount：
// 有资格进 removed 的路径总数（UI 用它判断「删除量是否异常放大」）。
test('G1 可见性：diff 报出 remoteOnly 与 knownRemoteCount，且不进 pending', () => {
  const localFiles = [
    { path: 'a.txt', sha: 'sha-a' },
  ];
  const remoteEntries = [
    { type: 'blob', path: 'a.txt', sha: 'sha-a' },
    { type: 'blob', path: 'gone.txt', sha: 'sha-gone' },
    { type: 'blob', path: 'pic.png', sha: 'sha-pic' },   // 拉取时被跳过 → 本地从未物化
    { type: 'blob', path: 'big.zip', sha: 'sha-zip' },   // 同上
  ];
  // 基线只包含曾经物化过的两个路径（gone.txt 现在本地没了）
  const diff = diffRemoteLocal({
    localFiles,
    remoteEntries,
    knownPaths: ['a.txt', 'gone.txt'],
  });
  assert.deepEqual(diff.removed, ['gone.txt']);
  assert.deepEqual(diff.remoteOnly, ['big.zip', 'pic.png'], '未物化的远程文件要点名（保持原样）');
  assert.equal(diff.knownRemoteCount, 2, '分母 = 远程 ∧ 曾经物化');
  assert.equal(diff.pending, 1, 'remoteOnly 不产生树改动，不进 pending');

  // 全量未物化（快速检出：只有 manifest，没有本地副本）→ 删除恒空 + remoteOnly 点名
  const quick = diffRemoteLocal({ localFiles: [], remoteEntries, knownPaths: [] });
  assert.deepEqual(quick.removed, []);
  assert.equal(quick.remoteOnly.length, 4);
  assert.equal(quick.knownRemoteCount, 0);
});

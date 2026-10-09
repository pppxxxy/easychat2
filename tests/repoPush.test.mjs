// C3 批量单提交测试：SHA-1 / git blob sha（与 Node crypto 对拍）/ base64 /
// 三态 diff / pushRepoSnapshot 全链路（fake request 分派）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  bytesToBase64,
  computeGitBlobSha,
  diffRemoteLocal,
  pushRepoSnapshot,
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
  assert.deepEqual(diffRemoteLocal({ localFiles, remoteEntries }), {
    added: ['a.js'],
    modified: ['b.js'],
    removed: ['d.js'],
    pending: 3,
  });
  assert.equal(diffRemoteLocal({}).pending, 0);
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
  const result = await pushRepoSnapshot({
    store: SCENE_STORE,
    characterId: 'c1',
    owner: 'o',
    repo: 'r',
    branch: 'main',
    token: 't',
    fetchImpl,
    sleepImpl: async () => {},
    confirm: async ({ diff }) => {
      confirmCalls.push(diff);
      return true;
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.commit, 'commit1');
  assert.deepEqual(confirmCalls, [
    { added: ['add.txt'], modified: ['mod.txt'], removed: ['gone.txt'], pending: 3 },
  ], '确认框拿到三态计数');
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
  assert.deepEqual(empty, { empty: true, diff: { added: [], modified: [], removed: [], pending: 0 } });
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

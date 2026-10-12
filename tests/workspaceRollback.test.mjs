// H3 回滚基线测试：纯函数（构造 / 解析 / 挑选 / 轮换 / 可恢复性）+ IO（fake store 往返与恢复）。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyRollbackSnapshot,
  buildRollbackPayload,
  formatRollbackUnrestorableLines,
  listRollbackSnapshots,
  parseRollbackSnapshot,
  pickRollbackSnapshots,
  readLatestRollbackSnapshot,
  ROLLBACK_DIR,
  ROLLBACK_KEEP,
  rollbackRestorableEntries,
  rollbackRotationDeletes,
  rollbackSnapshotPath,
  rollbackUnrestorableReport,
  writeRollbackSnapshot,
} from '../src/workspace/rollbackBaseline.js';

test('H3 快照构造/解析：自包含（owner/repo/branch/commit）+ 坏输入安全', () => {
  const payload = buildRollbackPayload({
    owner: 'o',
    repo: 'r',
    branch: 'main',
    commit: 'abc123',
    at: 1700000000000,
    rollback: {
      entries: [
        { path: 'a.txt', sha: 'sha-a', content: 'old-a' },
        { path: 'b.txt', sha: 'sha-b', content: null, reason: 'too-large' },
        { path: '' },
      ],
      skippedCount: 2,
    },
  });
  assert.equal(payload.at, 1700000000000);
  assert.equal(payload.commit, 'abc123');
  assert.equal(payload.entries.length, 2, '空路径丢弃');
  assert.equal(payload.entries[0].content, 'old-a');
  assert.equal(payload.entries[1].content, null);
  assert.equal(payload.entries[1].reason, 'too-large');
  assert.equal(payload.skippedCount, 2);

  assert.deepEqual(parseRollbackSnapshot(JSON.stringify(payload)).entries.length, 2, 'round-trip');
  assert.equal(parseRollbackSnapshot('{坏'), null);
  assert.equal(parseRollbackSnapshot('[]'), null);
  assert.equal(parseRollbackSnapshot({ no: 'entries' }), null, '缺 entries 视为无效');
  assert.equal(parseRollbackSnapshot(null), null);

  // 路径生成：非法 ts 用当前时间兜底（仍然可写）
  assert.match(rollbackSnapshotPath(5), /^\.easychat\/rollback\/5\.json$/);
  assert.match(rollbackSnapshotPath('bad'), /^\.easychat\/rollback\/\d+\.json$/);
});

test('H3 快照挑选与轮换：按时间戳降序、保留最近 KEEP 份', () => {
  const picked = pickRollbackSnapshots([
    `${ROLLBACK_DIR}/100.json`,
    `${ROLLBACK_DIR}/300.json`,
    `${ROLLBACK_DIR}/200.json`,
    `${ROLLBACK_DIR}/`,
    `${ROLLBACK_DIR}/notes.txt`,
    '.easychat/other/999.json',
    'repos/o/r/main/a.js',
  ]);
  assert.deepEqual(picked.map(item => item.ts), [300, 200, 100], '降序（最新在前）');
  const deletes = rollbackRotationDeletes(picked, ROLLBACK_KEEP);
  assert.deepEqual(deletes, [], `${ROLLBACK_KEEP} 份以内不删`);
  const more = pickRollbackSnapshots(
    Array.from({ length: 5 }, (_, i) => `${ROLLBACK_DIR}/${(i + 1) * 100}.json`)
  );
  assert.deepEqual(rollbackRotationDeletes(more, 3), [
    `${ROLLBACK_DIR}/200.json`,
    `${ROLLBACK_DIR}/100.json`,
  ], '保留最近 3 份、最旧两份待删');

  // 可恢复性分组
  const { restorable, unrestorable } = rollbackRestorableEntries({
    entries: [
      { path: 'a', content: 'x' },
      { path: 'b', content: null },
      { path: 'c' },
    ],
  });
  assert.deepEqual(restorable.map(item => item.path), ['a']);
  assert.deepEqual(unrestorable.map(item => item.path), ['b', 'c']);
});

test('H3 不可恢复项前置清单：执行前就知道是哪几个、为什么回不去', () => {
  // 症状：确认框只说「另有 N 个文件的旧内容未存」，用户看不到是哪几个、也看不到原因，
  // 只能先点「恢复」再吃结果。确认门的价值就是「点之前知道会发生什么」。
  const payload = buildRollbackPayload({
    owner: 'o', repo: 'r', branch: 'main', commit: 'c1', at: 1,
    rollback: {
      entries: [
        { path: 'keep.txt', sha: 's1', content: 'old' },
        { path: 'big.bin', sha: 's2', content: null, reason: 'too-large' },
        { path: 'huge.bin', sha: 's3', content: null, reason: 'total-limit' },
        { path: 'gone.txt', sha: 's4', content: null, reason: 'fetch-failed' },
        { path: 'noref.txt', sha: 's5', content: null },
      ],
      skippedCount: 2,
    },
  });
  const report = rollbackUnrestorableReport(payload);
  assert.equal(report.unrestorableCount, 4, 'content 为 null 的四条');
  assert.equal(report.missingCount, 2, '连条目都没记下的两条');
  assert.equal(report.total, 6, '总数 = 记下原因码的 + 只知道数量的');
  assert.deepEqual(report.shown.map(item => item.path), ['big.bin', 'huge.bin', 'gone.txt', 'noref.txt'],
    '清单带出路径（顺序与快照一致）');
  assert.deepEqual(report.shown.map(item => item.reason), ['too-large', 'total-limit', 'fetch-failed', 'unknown'],
    '缺 reason 归为 unknown，不假装知道原因');
  assert.equal(report.omittedCount, 2, '未列出的只剩 skippedCount 那部分');

  // limit 只影响展示条数，不影响计数
  const capped = rollbackUnrestorableReport(payload, 2);
  assert.equal(capped.shown.length, 2);
  assert.equal(capped.unrestorableCount, 4, '计数不受展示上限影响');
  assert.equal(capped.omittedCount, 4, '被截掉的 2 条 + 只知道数量的 2 条');

  // 全可恢复：不该显示空清单
  const clean = rollbackUnrestorableReport(buildRollbackPayload({
    rollback: { entries: [{ path: 'a.txt', sha: 's', content: 'x' }] },
  }));
  assert.equal(clean.total, 0);
  assert.deepEqual(clean.shown, []);

  // 坏输入安全（缺 payload / 缺 entries）
  assert.equal(rollbackUnrestorableReport(null).total, 0);
  assert.equal(rollbackUnrestorableReport({}).total, 0);
  assert.equal(rollbackUnrestorableReport({ entries: 'nope' }).total, 0);
});

test('H3 不可恢复项清单渲染：逐条给路径与原因，词条缺失不糊原因码', () => {
  const payload = buildRollbackPayload({
    owner: 'o', repo: 'r', branch: 'main', commit: 'c1', at: 1,
    rollback: {
      entries: [
        { path: 'keep.txt', sha: 's1', content: 'old' },
        { path: 'big.bin', sha: 's2', content: null, reason: 'too-large' },
        { path: 'gone.txt', sha: 's3', content: null, reason: 'fetch-failed' },
      ],
      skippedCount: 1,
    },
  });
  const report = rollbackUnrestorableReport(payload);
  // 原因码是 kebab，i18n key 只允许点分字母数字 ⇒ 纯函数负责转 camel
  assert.deepEqual(report.shown.map(item => item.reasonKey), [
    'workspace.github.rollback.lostReason.tooLarge',
    'workspace.github.rollback.lostReason.fetchFailed',
  ]);

  // 宿主注入的 labelFor 就是 t 的包装：这里用 stub 逐字断言渲染结果
  const labels = {
    'workspace.github.rollback.lostReason.tooLarge': '单文件过大',
    'workspace.github.rollback.lostReason.fetchFailed': '拉取旧内容失败',
    'workspace.github.rollback.lostReason.unknown': '原因未知',
    'workspace.github.rollback.lostMore': '另有 {count} 个同样未存。',
  };
  const rendered = formatRollbackUnrestorableLines(report, (key, params) => {
    const text = labels[key];
    if (text === undefined) return key; // 与真实 t 一致：缺词条返回 key
    return params ? text.replace('{count}', String(params.count)) : text;
  }, '以下文件回滚后保持现状：');
  assert.ok(rendered.startsWith('\n\n以下文件回滚后保持现状：'), '带标题前缀');
  assert.ok(rendered.includes('· big.bin（单文件过大）'), '逐条给路径 + 原因');
  assert.ok(rendered.includes('· gone.txt（拉取旧内容失败）'));
  assert.ok(rendered.includes('另有 1 个同样未存。'), '截断/未记录的数量如实告知');

  // 词条缺失（真实 t 的行为：缺词条原样返回 key）→ 换成「原因未知」，不把内部原因码糊到用户脸上
  const tLike = labels2 => (key, params) => {
    const text = labels2[key];
    if (text === undefined) return key;
    return params ? text.replace('{count}', String(params.count)) : text;
  };
  const fallback = formatRollbackUnrestorableLines(report, tLike({
    'workspace.github.rollback.lostReason.unknown': '原因未知',
    'workspace.github.rollback.lostMore': '另有 {count} 个同样未存。',
  }), '标题');
  assert.ok(fallback.includes('（原因未知）'), '缺词条回退到「原因未知」');
  assert.equal(fallback.includes('lostReason.tooLarge'), false, '不得把 i18n key 当文案显示');

  // 全可恢复：返回空串，宿主直接拼在确认正文后（不必再判空）
  const clean = formatRollbackUnrestorableLines(
    rollbackUnrestorableReport(buildRollbackPayload({ rollback: { entries: [{ path: 'a', sha: 's', content: 'x' }] } })),
    key => key,
    '标题'
  );
  assert.equal(clean, '');
  // 坏输入安全：缺 labelFor 时原样给 key，不抛也不递归
  assert.equal(formatRollbackUnrestorableLines(null, key => key, '标题'), '');
  assert.equal(
    formatRollbackUnrestorableLines(report),
    '\n\n\n· big.bin（workspace.github.rollback.lostReason.tooLarge）\n· gone.txt（workspace.github.rollback.lostReason.fetchFailed）\nworkspace.github.rollback.lostMore'
  );
});

test('H3 IO 往返：写 + 轮换删除 + 读最新 + 应用恢复（单条失败不拖垮其余）', async () => {
  const files = new Map();
  const deleted = [];
  const store = {
    async listWorkspaceFiles({ subdir }) {
      const prefix = `${subdir}/`;
      return [...files.keys()].filter(path => path.startsWith(prefix));
    },
    async writeWorkspaceFile({ path, content }) {
      if (path.endsWith('boom.txt')) throw new Error('write fail');
      files.set(path, content);
    },
    async readWorkspaceFile({ path }) {
      if (!files.has(path)) throw new Error('missing');
      return { content: files.get(path) };
    },
    async deleteFile({ path }) {
      deleted.push(path);
      files.delete(path);
    },
  };

  const make = at => buildRollbackPayload({
    owner: 'o', repo: 'r', branch: 'main', commit: `c${at}`, at,
    rollback: { entries: [{ path: 'a.txt', sha: 's', content: `old-${at}` }] },
  });
  // 写 5 份 → 轮换只留最近 3 份（最旧两份被删）
  for (const at of [100, 200, 300, 400, 500]) {
    assert.ok(await writeRollbackSnapshot(store, 'c1', make(at)), '写入成功');
  }
  const snapshots = await listRollbackSnapshots(store, 'c1');
  assert.deepEqual(snapshots.map(item => item.ts), [500, 400, 300], '只保留最近 3 份');
  assert.equal(deleted.length, 2, '旧两份被删');

  // 读最新一份
  const latest = await readLatestRollbackSnapshot(store, 'c1');
  assert.equal(latest.at, 500);
  assert.equal(latest.entries[0].content, 'old-500');

  // 应用恢复：带前缀写回；单条失败记账不中断
  const payload = buildRollbackPayload({
    owner: 'o', repo: 'r', branch: 'main', commit: 'c9', at: 900,
    rollback: {
      entries: [
        { path: 'ok.txt', sha: 's1', content: 'restored!' },
        { path: 'boom.txt', sha: 's2', content: 'will fail' },
        { path: 'lost.txt', sha: 's3', content: null, reason: 'too-large' },
      ],
    },
  });
  const outcome = await applyRollbackSnapshot({
    store,
    characterId: 'c1',
    payload,
    localPrefix: 'repos/o/r/main/',
  });
  assert.deepEqual(outcome.restored, ['ok.txt']);
  assert.deepEqual(outcome.failed, ['boom.txt']);
  assert.deepEqual(outcome.unrestorable, ['lost.txt']);
  assert.equal(files.get('repos/o/r/main/ok.txt'), 'restored!', '带前缀写回');

  // 旁路：缺 store / 无快照都安全
  assert.equal(await readLatestRollbackSnapshot(null, 'c1'), null);
  assert.equal(await writeRollbackSnapshot(null, 'c1', make(1)), null);
  assert.deepEqual(
    (await applyRollbackSnapshot({ store: null, characterId: 'c1', payload, localPrefix: '' })).restored,
    []
  );
});

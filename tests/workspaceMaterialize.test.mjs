// C2 按需物化测试：路径解析 / URL / base64 解码 / contents 响应提取 / IO 薄壳 / 接线契约。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  base64ToBytes,
  buildContentsUrl,
  extractContentsText,
  materializeRepoFile,
  parseRepoFilePath,
} from '../src/workspace/repoMaterialize.js';
import { repoManifestPath } from '../src/workspace/repoPaths.js';
import {
  MATERIALIZE_MAX_PER_CALL,
  MATERIALIZE_TOOL_DEFINITION,
  groupPendingByDir,
} from '../src/workspace/toolDefs/materializeTool.js';

test('parseRepoFilePath：repos/<owner>/<repo>/<branch>/<rel>；不满足形态返回 null', () => {
  assert.deepEqual(
    parseRepoFilePath('repos/o/r/main/src/a.js'),
    { owner: 'o', repo: 'r', branch: 'main', rel: 'src/a.js' }
  );
  assert.deepEqual(
    parseRepoFilePath('repos/o/r/feature%2Fx/deep/file.md'),
    { owner: 'o', repo: 'r', branch: 'feature%2Fx', rel: 'deep/file.md' }
  );
  assert.equal(parseRepoFilePath('src/a.js'), null, '不在 repos 下');
  assert.equal(parseRepoFilePath('repos/o/r/main'), null, '段数不足（没有文件）');
  assert.equal(parseRepoFilePath(''), null);
  assert.equal(parseRepoFilePath(null), null);
});

test('buildContentsUrl：rel 逐段编码 + ref 编码', () => {
  assert.equal(
    buildContentsUrl({ owner: 'o', repo: 'r', ref: 'main', rel: 'src/a b/中文.md' }),
    'https://api.github.com/repos/o/r/contents/src/a%20b/%E4%B8%AD%E6%96%87.md?ref=main'
  );
  assert.equal(
    buildContentsUrl({ owner: 'o', repo: 'r', ref: 'feature/x', rel: 'a.js' }),
    'https://api.github.com/repos/o/r/contents/a.js?ref=feature%2Fx'
  );
});

test('base64ToBytes / extractContentsText：UTF-8 中文解码 + 上限形态如实返回', () => {
  assert.deepEqual([...base64ToBytes('aGVsbG8=')], [104, 101, 108, 108, 111], 'hello');
  assert.deepEqual([...base64ToBytes('aGVs\nbG8=')], [104, 101, 108, 108, 111], '带换行也认');
  const text = extractContentsText({ encoding: 'base64', content: '5L2g5aW9' });
  assert.equal(text.ok, true);
  assert.equal(text.text, '你好', 'UTF-8 多字节正确解码');
  // >1MB：GitHub 不内联 content —— 如实返回 none（调用方给「完整拉取」提示）
  assert.deepEqual(extractContentsText({ encoding: 'none' }), { ok: false, reason: 'none' });
  assert.deepEqual(extractContentsText(null), { ok: false, reason: 'none' });
});

test('materializeRepoFile：单文件拉取写沙盒；前置不满足零网络、失败不写入', async () => {
  const written = [];
  const store = {
    async writeWorkspaceFile({ path: file, content }) { written.push({ file, content }); },
  };
  const calls = [];
  const requestImpl = async (fetchImpl, url) => {
    calls.push(url);
    return { data: { encoding: 'base64', content: 'aGVsbG8=' } };
  };
  const result = await materializeRepoFile({
    store, characterId: 'c1', path: 'repos/o/r/main/src/a.js', token: 't', requestImpl,
  });
  assert.equal(result.ok, true);
  assert.equal(result.chars, 5);
  assert.deepEqual(calls, ['https://api.github.com/repos/o/r/contents/src/a.js?ref=main']);
  assert.deepEqual(written, [{ file: 'repos/o/r/main/src/a.js', content: 'hello' }]);

  // 非 repos 路径 / 无 store：不发网络、不写
  assert.deepEqual(
    await materializeRepoFile({ store, path: 'src/a.js', requestImpl }),
    { ok: false, reason: 'notRepoPath' }
  );
  assert.deepEqual(
    await materializeRepoFile({ path: 'repos/o/r/main/a.js', requestImpl }),
    { ok: false, reason: 'noStore' }
  );
  assert.equal(calls.length, 1, '前置不满足时零网络');

  // encoding none（>1MB）：返回原因且不写
  const big = await materializeRepoFile({
    store,
    path: 'repos/o/r/main/big.bin',
    requestImpl: async () => ({ data: { encoding: 'none' } }),
  });
  assert.deepEqual(big, { ok: false, reason: 'none' });
  assert.equal(written.length, 1, '失败不写入任何内容');
});

test('C2 接线契约：read 工具透明物化 + 面板点开即拉 + 宿主注入（三道前置）', () => {
  const readTools = fs.readFileSync(path.resolve('src/workspace/toolDefs/readTools.js'), 'utf8');
  assert.ok(readTools.includes('options.materializer'), 'read 工具读失败时试物化');
  assert.ok(readTools.includes("typeof options.materializer !== 'function'"), '没注入 = 旧行为逐字节一致');

  const panel = fs.readFileSync(path.resolve('src/workspace/screen/GithubPanel.js'), 'utf8');
  assert.ok(panel.includes('virtualPaths.has(path)'), '只对未物化（云朵）文件按需拉');
  assert.ok(panel.includes('materializeRepoFile({ store, characterId, path, token })'), '点开即拉');
  assert.ok(panel.includes("t('workspace.github.materialize.fail')"), '失败如实报（不静默）');

  const chat = fs.readFileSync(path.resolve('src/workspace/screen/ChatPanel.js'), 'utf8');
  assert.ok(chat.includes('materializer: materializeForAgent'), '工作区宿主注入物化器');
  assert.ok(chat.includes('readRepoManifest(store, characterId, target)'), '前置之一：必须做过快速检出');
  assert.ok(chat.includes('item.path === target.rel'), '前置之二：文件必须在清单里');

  const native = fs.readFileSync(path.resolve('src/workspace/native.js'), 'utf8');
  assert.ok(native.includes('extras.materializer'), '注册入口透传');
});

test('materialize_repo：只拉清单内未物化文件；失败与剩余量如实报告；三条引导路径', async () => {
  const dir = { owner: 'o', repo: 'r', branch: 'main' };
  const store = {
    async readWorkspaceFile({ path }) {
      if (path === repoManifestPath(dir)) {
        return {
          content: JSON.stringify({
            entries: [
              { path: 'a.js', type: 'blob' },
              { path: 'b.js', type: 'blob' },
              { path: 'c.js', type: 'blob' },
              { path: 'src', type: 'tree' },
            ],
          }),
        };
      }
      throw new Error('missing');
    },
    async listWorkspaceFiles() {
      return ['repos/o/r/main/', 'repos/o/r/main/a.js']; // a.js 已物化
    },
  };
  const executed = [];
  const options = {
    store,
    materializer: async item => {
      executed.push(item);
      return item !== 'repos/o/r/main/c.js'; // c.js 模拟失败
    },
  };
  const text = await MATERIALIZE_TOOL_DEFINITION.execute(options, { path: 'repos/o/r/main/' }, { characterId: 'c1' });
  assert.deepEqual(executed, ['repos/o/r/main/b.js', 'repos/o/r/main/c.js'], '只拉未物化的（a.js 跳过、目录不入列）');
  assert.match(text, /成功 1 个/);
  assert.match(text, /失败 1 个/);

  // 已全部物化 → 明确报告
  const doneText = await MATERIALIZE_TOOL_DEFINITION.execute(
    { store: { ...store, async listWorkspaceFiles() { return ['repos/o/r/main/a.js', 'repos/o/r/main/b.js', 'repos/o/r/main/c.js']; } }, materializer: async () => true },
    { path: 'repos/o/r/main/' },
    { characterId: 'c1' }
  );
  assert.match(doneText, /已全部物化/);

  // 无清单 → 引导快速检出（不猜、不静默）
  const noManifest = await MATERIALIZE_TOOL_DEFINITION.execute(
    { store: { async readWorkspaceFile() { throw new Error('missing'); } }, materializer: async () => true },
    { path: 'repos/o/r/main/' },
    { characterId: 'c1' }
  );
  assert.match(noManifest, /没有云端清单/);

  // 非法 path / 宿主不支持 → 明确提示
  assert.match(
    await MATERIALIZE_TOOL_DEFINITION.execute(options, { path: 'src/' }, { characterId: 'c1' }),
    /形如 repos/
  );
  assert.match(
    await MATERIALIZE_TOOL_DEFINITION.execute({ store }, { path: 'repos/o/r/main/' }, { characterId: 'c1' }),
    /不支持按需物化/
  );
});

test('materialize_repo：单次上限 25（默认与 limit 收敛）+ 剩余量提示', async () => {
  const entries = Array.from({ length: 30 }, (unused, index) => ({ path: `f${index}.js`, type: 'blob' }));
  const store = {
    async readWorkspaceFile() { return { content: JSON.stringify({ entries }) }; },
    async listWorkspaceFiles() { return []; },
  };
  const executed = [];
  const options = { store, materializer: async item => { executed.push(item); return true; } };
  const text = await MATERIALIZE_TOOL_DEFINITION.execute(
    options,
    { path: 'repos/o/r/main/' },
    { characterId: 'c1' }
  );
  assert.equal(executed.length, MATERIALIZE_MAX_PER_CALL, '默认单次上限 25');
  assert.match(text, /还有 5 个未物化/, '剩余量如实报告');

  const limited = await MATERIALIZE_TOOL_DEFINITION.execute(
    options,
    { path: 'repos/o/r/main/', limit: 3 },
    { characterId: 'c1' }
  );
  assert.equal(executed.length, MATERIALIZE_MAX_PER_CALL + 3, 'limit 收敛');
  assert.match(limited, /还有 27 个未物化/);
});

// F 项（2026-10-12）：大仓库反复调用 25 个一批时，模型此前看不见「还剩哪些目录」，
// 只能猜下一批——现在 subdir 收敛 + 剩余目录分布如实列出，反复调用才能逐目录拉完。
test('materialize_repo：subdir 收敛一批；剩余文件的目录分布如实列出（模型据此挑下一批）', async () => {
  const entries = [
    { path: 'src/a.js', type: 'blob' },
    { path: 'src/b.js', type: 'blob' },
    { path: 'src/deep/c.js', type: 'blob' },
    { path: 'docs/x.md', type: 'blob' },
    { path: 'docs/y.md', type: 'blob' },
    { path: 'README.md', type: 'blob' },
  ];
  const store = {
    async readWorkspaceFile() { return { content: JSON.stringify({ entries }) }; },
    async listWorkspaceFiles() { return []; },
  };
  const executed = [];
  const options = { store, materializer: async item => { executed.push(item); return true; } };

  // 全仓一批：按清单顺序取前 N（默认 25 → 全取），剩余为 0 时不再列目录
  const all = await MATERIALIZE_TOOL_DEFINITION.execute(options, { path: 'repos/o/r/main/' }, { characterId: 'c1' });
  assert.equal(executed.length, 6);
  assert.match(all, /成功 6 个/);
  assert.equal(/未物化的目录/.test(all), false, '全部拉完时不再列剩余目录');

  // subdir 只处理该子目录（含其子目录），剩余量按**全仓**报（不谎称拉完）
  executed.length = 0;
  const scoped = await MATERIALIZE_TOOL_DEFINITION.execute(
    options,
    { path: 'repos/o/r/main/', subdir: 'src/' },
    { characterId: 'c1' }
  );
  assert.deepEqual(executed, ['repos/o/r/main/src/a.js', 'repos/o/r/main/src/b.js', 'repos/o/r/main/src/deep/c.js'],
    'subdir 递归覆盖其下所有文件');
  assert.match(scoped, /还有 3 个未物化/, '剩余量按全仓算（docs 2 + README 1）');
  assert.match(scoped, /docs\/（2 个）/, '剩余目录分布要点名数量最多的目录');
  assert.match(scoped, /（仓库根目录）\/（1 个）/, '顶层文件归到仓库根目录');
  assert.match(scoped, /可用 subdir 指定其中一个/);

  // subdir 写法归一化：首尾斜杠随便给，越界段拒绝
  executed.length = 0;
  await MATERIALIZE_TOOL_DEFINITION.execute(options, { path: 'repos/o/r/main/', subdir: '/docs' }, { characterId: 'c1' });
  assert.deepEqual(executed, ['repos/o/r/main/docs/x.md', 'repos/o/r/main/docs/y.md'], '首尾斜杠不影响匹配');
  assert.match(
    await MATERIALIZE_TOOL_DEFINITION.execute(options, { path: 'repos/o/r/main/', subdir: '../src' }, { characterId: 'c1' }),
    /不能含 \.\. 或 \. 段/,
    '越界子目录一律拒绝（与 git 路径越界同口径）'
  );
  // subdir 下没有未物化文件 → 如实说，并给出全仓剩余量
  assert.match(
    await MATERIALIZE_TOOL_DEFINITION.execute(options, { path: 'repos/o/r/main/', subdir: 'nope/' }, { characterId: 'c1' }),
    /没有未物化的文件；全仓还有 6 个未物化/
  );
});

test('groupPendingByDir：首层目录归组、数量降序、可截断（纯函数，Node 直测）', () => {
  const prefix = 'repos/o/r/main/';
  const paths = [
    `${prefix}src/a.js`, `${prefix}src/b.js`, `${prefix}src/deep/c.js`,
    `${prefix}docs/x.md`, `${prefix}README.md`,
  ];
  const all = groupPendingByDir(paths, prefix);
  // 数量降序；同数量按目录名（'' 是仓库根目录，排在最前）——顺序稳定才可断言。
  assert.deepEqual(all.list, [
    { dir: 'src', count: 3 },
    { dir: '', count: 1 },
    { dir: 'docs', count: 1 },
  ]);
  assert.equal(all.total, 3);
  const capped = groupPendingByDir(paths, prefix, { max: 2 });
  assert.equal(capped.list.length, 2);
  assert.equal(capped.total, 3, '截断时仍报总目录数（调用方据此提示「另有 N 个目录」）');
  assert.deepEqual(groupPendingByDir(null, prefix), { list: [], total: 0 });
  // 前缀不匹配时按原样算（防御：不静默丢文件）
  assert.deepEqual(groupPendingByDir([`${prefix}src/a.js`], '').list, [{ dir: 'repos', count: 1 }]);
});

test('C3 批量推送接线：面板按钮 + 一次确认 + truncated 安全失败 + 绝不 force', () => {
  const github = fs.readFileSync(path.resolve('src/workspace/screen/GithubPanel.js'), 'utf8');
  assert.ok(github.includes('pushRepoSnapshot({'), '面板直连 Trees API 单提交链路');
  assert.ok(github.includes("t('workspace.github.push.batch')"), '批量推送按钮');
  assert.ok(github.includes('confirmPushDiff'), '一次确认框（问不到用户 = 不推送）');
  assert.ok(github.includes("t('workspace.github.push.doneBody'"), '成功报告 commit sha');
  assert.ok(github.includes("t('workspace.github.push.truncated')"), 'truncated 拒绝 + 引导 handoff');

  const push = fs.readFileSync(path.resolve('src/workspace/repoPush.js'), 'utf8');
  assert.ok(push.includes("reason: 'truncated'"), '清单不完整时拒绝推送（完整树会误删看不见的文件）');
  const rest = fs.readFileSync(path.resolve('src/workspace/github/restApi.js'), 'utf8');
  assert.ok(rest.includes('force: false'), 'updateRef 绝不 force（非快进被 GitHub 拒绝）');
});

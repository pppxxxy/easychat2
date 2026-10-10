// H1 云构建工具测试：仓库参数解析 / 工具定义契约 / execute 经注入桥走通（Node 直测）。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GET_BUILD_LOG_DEFINITION,
  parseRepoArg,
  resolveRepoArg,
  RUN_REMOTE_BUILD_DEFINITION,
} from '../src/workspace/toolDefs/ciTools.js';

test('H1 parseRepoArg / resolveRepoArg：显式优先、单仓库推断、多仓库要求写明', async () => {
  assert.deepEqual(parseRepoArg('ppp/easychat2'), { owner: 'ppp', repo: 'easychat2' });
  assert.equal(parseRepoArg('bad shape'), null);
  assert.equal(parseRepoArg('a/b/c'), null);
  assert.equal(parseRepoArg(''), null);

  const store = files => ({ async listWorkspaceFiles() { return files; } });
  // 显式参数直接用
  assert.deepEqual(
    await resolveRepoArg({ store: store([]) }, 'c1', 'o/r'),
    { owner: 'o', repo: 'r' }
  );
  // 给了但格式不对 → 不当成缺省（避免静默用错仓库）
  assert.equal(await resolveRepoArg({ store: store(['repos/o/r/main/a.js']) }, 'c1', 'bad'), null);
  // 缺省：工作区恰好一个仓库副本 → 自动推断（去重）
  assert.deepEqual(
    await resolveRepoArg({ store: store(['repos/o/r/main/a.js', 'repos/o/r/main/b.js', 'repos/o/r/']) }, 'c1', ''),
    { owner: 'o', repo: 'r' }
  );
  // 多仓库 / 零仓库 → null（调用方提示写明 owner/repo）
  assert.equal(await resolveRepoArg({ store: store(['repos/o/r/main/a.js', 'repos/o/r2/main/a.js']) }, 'c1', ''), null);
  assert.equal(await resolveRepoArg({ store: store(['plain.txt']) }, 'c1', ''), null);
  assert.equal(await resolveRepoArg({ store: { async listWorkspaceFiles() { throw new Error('x'); } } }, 'c1', ''), null);
});

test('H1 工具契约：触发有副作用需确认 / 读日志纯读；execute 经注入桥走通', async () => {
  // 定义契约
  assert.equal(RUN_REMOTE_BUILD_DEFINITION.name, 'run_remote_build');
  assert.equal(RUN_REMOTE_BUILD_DEFINITION.readOnly, false);
  assert.equal(RUN_REMOTE_BUILD_DEFINITION.requiresConfirmation, true, '远端副作用必须过确认门');
  assert.equal(GET_BUILD_LOG_DEFINITION.name, 'get_build_log');
  assert.equal(GET_BUILD_LOG_DEFINITION.readOnly, true, '读日志纯读（read 模式可用）');
  assert.equal('requiresConfirmation' in GET_BUILD_LOG_DEFINITION, false);
  assert.deepEqual(RUN_REMOTE_BUILD_DEFINITION.parameters.required, ['workflow']);

  // execute：fake store（单仓库）+ fake ci 桥
  const store = { async listWorkspaceFiles() { return ['repos/o/r/main/a.js']; } };
  const dispatched = [];
  const ci = {
    async dispatch({ owner, repo, workflow, ref }) {
      dispatched.push({ owner, repo, workflow, ref });
      return { ok: true };
    },
    async latestLog() {
      return {
        ok: true,
        run: { id: 7, status: 'completed', conclusion: 'failure', branch: 'main', sha: 'abc1234', displayTitle: 'CI', name: 'CI' },
        text: 'Error: expect 1 got 2',
      };
    },
  };
  const runOut = await RUN_REMOTE_BUILD_DEFINITION.execute(
    { store, ci },
    { workflow: 'ci.yml', ref: 'main' },
    { characterId: 'c1' }
  );
  assert.match(runOut, /已触发/, '触发成功给出下一步指引');
  assert.deepEqual(dispatched, [{ owner: 'o', repo: 'r', workflow: 'ci.yml', ref: 'main' }], '参数透传到桥');

  const logOut = await GET_BUILD_LOG_DEFINITION.execute({ store, ci }, {}, { characterId: 'c1' });
  assert.match(logOut, /#7/);
  assert.match(logOut, /failure/, '状态进入结论头');
  assert.match(logOut, /expect 1 got 2/, '日志正文在');

  // 不可用路径：无桥 / 无 token / 多仓库都如实报（不抛错）
  const noBridge = await RUN_REMOTE_BUILD_DEFINITION.execute({ store }, { workflow: 'ci.yml' }, {});
  assert.equal(noBridge.isError, true);
  const noToken = await RUN_REMOTE_BUILD_DEFINITION.execute(
    { store, ci: { async dispatch() { return { ok: false, error: 'no-token' }; } } },
    { workflow: 'ci.yml' },
    { characterId: 'c1' }
  );
  assert.match(noToken.content, /GitHub 凭据/, '未配置凭据有明确引导');
  const multi = await RUN_REMOTE_BUILD_DEFINITION.execute(
    { store: { async listWorkspaceFiles() { return ['repos/a/x/main/', 'repos/b/y/main/']; } }, ci },
    { workflow: 'ci.yml' },
    { characterId: 'c1' }
  );
  assert.match(multi.content, /多个/, '多仓库时要求写明 owner/repo');

  // 读日志：没有构建记录 → 引导先触发
  const emptyLog = await GET_BUILD_LOG_DEFINITION.execute(
    { store, ci: { async latestLog() { return { ok: true, run: null, text: '' }; } } },
    {},
    { characterId: 'c1' }
  );
  assert.match(emptyLog, /run_remote_build/, '空记录引导先触发');
});

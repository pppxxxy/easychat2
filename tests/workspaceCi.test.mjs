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

// 🔴 日志下载失败不得吞成空串后仍报 ok:true（2026-10-10）。
// ok:true 是**主动的错误断言**：上层会按「这次构建没有任何日志」呈现给模型，模型据此推理
//（例如以为 workflow 没产出、进而去改构建配置）。这里同时钉住两端：ci.js 如实报 ok:false，
// 工具层把它如实翻成「读取构建日志失败」。
test('H1 latestLog：日志下载失败 → ok:false（不折叠成「没有日志」）；工具层如实提示', async () => {
  const previousRequire = globalThis.require;
  const previousFetch = globalThis.fetch;
  // token 惰性取（ci.js 用 require 拉存储模块，避免把 AsyncStorage 拖进纯 Node 图）
  globalThis.require = () => ({
    getGithubMcpSettings: async () => ({ enabled: true, authMethod: 'pat', githubToken: 'tk' }),
  });
  const calls = [];
  globalThis.fetch = async url => {
    calls.push(String(url));
    if (String(url).endsWith('/logs')) {
      // 列表拿到了 run，但日志 zip 拉不下来（403/500/网络）——downloadRunLogs 会抛
      return {
        ok: false, status: 500, headers: { get: () => null },
        json: async () => ({ message: 'server error' }), text: async () => 'server error',
      };
    }
    return {
      ok: true, status: 200, headers: { get: () => null },
      json: async () => ({
        workflow_runs: [{
          id: 42, name: 'CI', display_title: 'CI', status: 'completed', conclusion: 'success',
          head_branch: 'main', head_sha: 'abc1234',
        }],
      }),
      text: async () => '',
    };
  };
  try {
    const { ciBridge } = await import('../src/workspace/ci.js');
    const result = await ciBridge.latestLog({ owner: 'o', repo: 'r' });
    assert.equal(result.ok, false, '下载失败必须 ok:false，不得 ok:true + 空 text');
    assert.equal(result.error, 'log-download-failed');
    assert.equal(typeof result.detail, 'string');
    assert.ok(calls.some(url => url.endsWith('/logs')), '确实走到了日志下载那一步');

    // 工具层：ok:false 被正确处理成「读取构建日志失败」（isError），不崩、不谎报「没有日志」
    const localStore = { async listWorkspaceFiles() { return ['repos/o/r/main/a.js']; } };
    const out = await GET_BUILD_LOG_DEFINITION.execute(
      { store: localStore, ci: { async latestLog() { return { ok: false, error: 'log-download-failed' }; } } },
      {},
      { characterId: 'c1' },
    );
    assert.equal(out.isError, true);
    assert.match(out.content, /失败/);
    assert.equal(/没有日志/.test(out.content), false, '不得退化成「没有日志」');
  } finally {
    if (previousRequire === undefined) delete globalThis.require; else globalThis.require = previousRequire;
    if (previousFetch === undefined) delete globalThis.fetch; else globalThis.fetch = previousFetch;
  }
});

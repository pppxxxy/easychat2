// 「带版本号的角色库写入」纯逻辑测试。
//
// 这段逻辑的价值全在两条边界上，任何一条失效都等于没做：
//   1) 写的时候必须带上**自己读到的那一版**（带错版本 = 校验形同虚设）；
//   2) 撞上别人先写时必须刷新后**重跑整个操作**，而不是拿旧数据再撞一次。
// 第 2 条最容易写错：如果 run() 闭包住旧 list，重试三次都会撞同一堵墙，
// 表面有重试、实际必然失败。所以这里专门钉「重试时会重新推导」。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const PRESET_ENV = require.resolve('@babel/preset-env');

const SRC = path.resolve('src');
const PERSIST_PATH = path.join(SRC, 'context', 'characterLibraryPersistence.js');

// 用 babel 把待测模块（以及它的相对依赖）转成 CJS 再加载，顺便把存储层换成假的。
// 与 tests/charactersMcpTools.test.mjs 同套路：显式替换依赖模块，不和 ESM loader 斗法。
function loadPersistence({ initialLibrary = [], initialRevision = 0 } = {}) {
  const state = {
    library: initialLibrary.map(item => ({ ...item })),
    revision: initialRevision,
    saves: [],
    loads: 0,
    // 让测试注入「别人抢写」：每次 save 之前调用，返回 true 表示模拟一次并发写。
    competitor: null,
  };

  const storageStub = {
    async getCharacterLibrary() {
      state.loads += 1;
      return state.library.map(item => ({ ...item }));
    },
    async getCharacterLibraryRevision() {
      return state.revision;
    },
    isCharacterLibraryConflict(error) {
      return Boolean(error && error.code === 'CHARACTER_LIBRARY_CONFLICT');
    },
    async saveCharacterLibrary(list, options) {
      if (state.competitor && state.competitor(state)) {
        // 别人先写了一版：盘上数据与版本都变了
        state.revision += 1;
        state.library = [...state.library, { id: 'someone-else', name: '别人加的卡' }];
      }
      if (options && options.expectedRevision !== undefined && options.expectedRevision !== state.revision) {
        const error = new Error('conflict');
        error.code = 'CHARACTER_LIBRARY_CONFLICT';
        throw error;
      }
      state.saves.push(list.map(item => ({ ...item })));
      state.library = list.map(item => ({ ...item }));
      state.revision += 1;
      return list;
    },
  };

  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request.endsWith('/characters.js') || request.endsWith('storage/characters')) {
      if (request.includes('storage/characters.js')) return storageStub;
    }
    if (request.endsWith('/characterState.js')) {
      return {
        async saveCharacterState(list, activeId, deletedIds, clearVectorIds, options) {
          return storageStub.saveCharacterLibrary(list, options);
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    for (const key of Object.keys(Module._cache)) {
      if (key.startsWith(`${SRC}${path.sep}`)) delete Module._cache[key];
    }
    const code = babel.transformSync(fs.readFileSync(PERSIST_PATH, 'utf8'), {
      babelrc: false,
      configFile: false,
      filename: PERSIST_PATH,
      presets: [[PRESET_ENV, { targets: { node: 'current' }, modules: 'commonjs' }]],
    }).code;
    const mod = new Module(PERSIST_PATH);
    mod.filename = PERSIST_PATH;
    mod.paths = Module._nodeModulePaths(path.dirname(PERSIST_PATH));
    mod._compile(code, PERSIST_PATH);
    mod.exports.resetLibraryRevision();
    return { mod: mod.exports, state };
  } finally {
    Module._load = originalLoad;
  }
}

test('primeLibraryRevision 记住读到的版本号', async () => {
  const { mod } = loadPersistence({ initialRevision: 7 });
  assert.equal(mod.currentLibraryRevision(), null, '初始应是「不知道」');
  assert.equal(await mod.primeLibraryRevision(), 7);
  assert.equal(mod.currentLibraryRevision(), 7);
});

test('读库会同时对齐版本号（loadCharacterLibraryWithRevision）', async () => {
  const { mod, state } = loadPersistence({ initialRevision: 3, initialLibrary: [{ id: 'a' }] });
  const list = await mod.loadCharacterLibraryWithRevision();
  assert.deepEqual(list.map(i => i.id), ['a']);
  assert.equal(mod.currentLibraryRevision(), 3);
  assert.equal(state.loads, 1, '只读一次库（版本号另走索引读，不算重复读库）');
});

test('写入带上自己读到的版本号，成功后再推进一版', async () => {
  const { mod, state } = loadPersistence({ initialRevision: 4 });
  await mod.primeLibraryRevision();
  await mod.saveCharacterLibraryTracked([{ id: 'a' }]);
  assert.equal(state.saves.length, 1);
  assert.equal(mod.currentLibraryRevision(), 5, '本地版本号要跟着推进，否则下次必然假冲突');
});

test('别人先写 → 抛冲突 → 刷新后重试会重新推导并最终成功', async () => {
  const { mod, state } = loadPersistence({ initialRevision: 1, initialLibrary: [{ id: 'base' }] });
  await mod.primeLibraryRevision();

  // 第一次 save 之前插一次「别人抢写」
  let raced = false;
  state.competitor = () => {
    if (raced) return false;
    raced = true;
    return true;
  };

  let runs = 0;
  let derived = null;
  const result = await mod.runWithLibraryConflictRetry(async () => {
    runs += 1;
    // 关键：每次运行都重新读最新库（模拟 AppContext 的 snapshotState + 刷新）
    derived = await mod.loadCharacterLibraryWithRevision();
    return mod.saveCharacterLibraryTracked([...derived, { id: 'mine' }]);
  }, async () => {
    await mod.loadCharacterLibraryWithRevision();
  });

  assert.equal(runs, 2, '必须重跑一次（第一次撞冲突）');
  assert.ok(result.some(item => item.id === 'mine'));
  assert.ok(state.library.some(item => item.id === 'someone-else'), '别人加的卡不能被我们删掉');
});

test('重试有上限：一直冲突就抛原始冲突，不会无限循环', async () => {
  const { mod, state } = loadPersistence({ initialRevision: 1 });
  await mod.primeLibraryRevision();
  state.competitor = () => true; // 每次都有人抢写

  let runs = 0;
  await assert.rejects(
    () => mod.runWithLibraryConflictRetry(async () => {
      runs += 1;
      await mod.loadCharacterLibraryWithRevision();
      return mod.saveCharacterLibraryTracked([{ id: 'mine' }]);
    }, async () => {
      await mod.loadCharacterLibraryWithRevision();
    }),
    error => error.code === 'CHARACTER_LIBRARY_CONFLICT'
  );
  assert.equal(runs, mod.__maxConflictAttemptsForTests, '重试次数正好等于上限');
});

test('非冲突错误必须原样抛出，不能被重试掩盖', async () => {
  const { mod } = loadPersistence();
  let runs = 0;
  await assert.rejects(
    () => mod.runWithLibraryConflictRetry(async () => {
      runs += 1;
      throw new Error('磁盘满了');
    }, async () => {}),
    /磁盘满了/
  );
  assert.equal(runs, 1, '非冲突错误不该触发重试');
});

test('刷新本身失败时抛出原始冲突（而不是刷新错误）', async () => {
  const { mod, state } = loadPersistence({ initialRevision: 1 });
  await mod.primeLibraryRevision();
  state.competitor = () => true;
  await assert.rejects(
    () => mod.runWithLibraryConflictRetry(
      () => mod.saveCharacterLibraryTracked([{ id: 'mine' }]),
      async () => {
        throw new Error('刷新也炸了');
      }
    ),
    error => error.code === 'CHARACTER_LIBRARY_CONFLICT',
    '必须让调用方看见真正的成因'
  );
});

test('版本号未知（null）时不传 expectedRevision，退回无校验行为', async () => {
  const { mod, state } = loadPersistence({ initialRevision: 0 });
  mod.resetLibraryRevision();
  // 让 getCharacterLibraryRevision 返回 null，模拟索引损坏
  const originalGet = mod.primeLibraryRevision;
  mod.primeLibraryRevision = async () => {
    mod.resetLibraryRevision();
    return null;
  };
  await mod.primeLibraryRevision();
  await mod.saveCharacterLibraryTracked([{ id: 'a' }]);
  assert.equal(state.saves.length, 1, '不知道版本也要能写');
  assert.equal(mod.currentLibraryRevision(), null);
  mod.primeLibraryRevision = originalGet;
});

// ── 接线锚：AppContext 的写入必须真的走版本校验 ───────────────────────────
//
// 模块本身测得再细，只要 AppContext 还在用裸的 saveCharacterLibrary / saveCharacterState，
// 版本号就没人传，整套乐观并发等于没接。AppContext 是 RN 组件、Node 里跑不起来，
// 所以按仓库既有做法钉源码。
const APP_CONTEXT_PATH = path.join(SRC, 'context', 'AppContext.js');

test('接线锚：AppContext 的变更队列必须用冲突重试包住 operation', () => {
  const source = fs.readFileSync(APP_CONTEXT_PATH, 'utf8');
  const retryAt = source.indexOf('runWithLibraryConflictRetry(operation');
  assert.ok(retryAt > 0, 'enqueueMutation 必须把 operation 交给冲突重试');
  // 重试要用「刷新角色库」作为刷新动作，否则重跑的还是旧快照。
  const tail = source.slice(retryAt, retryAt + 120);
  assert.ok(tail.includes('refreshCharactersDirect'), '重试必须配 refreshCharactersDirect');
  // 必须在队列的 then 里跑（串行语义不能丢）。
  const thenAt = source.lastIndexOf('mutationRef.current.then(', retryAt);
  assert.ok(thenAt > 0, '冲突重试必须仍在串行队列里执行');
});

test('接线锚：AppContext 不得再直接调用裸的保存函数（会丢版本号）', () => {
  const source = fs.readFileSync(APP_CONTEXT_PATH, 'utf8');
  // 注释里出现这些名字是正常的，只查真正的调用形态「名字 + 左括号」。
  assert.ok(!/[^a-zA-Z]saveCharacterLibrary\(/.test(source),
    '必须改调 saveCharacterLibraryTracked（裸调用不带 expectedRevision）');
  assert.ok(!/[^a-zA-Z]saveCharacterState\(/.test(source),
    '必须改调 saveCharacterStateTracked（裸调用不带 expectedRevision）');
  assert.ok(source.includes('saveCharacterLibraryTracked('), '保存整库要走 tracked 版');
  assert.ok(source.includes('saveCharacterStateTracked('), '保存库+活动角色要走 tracked 版');
});

test('接线锚：读库必须同时对齐版本号（否则首次写拿 null 等于不校验）', () => {
  const source = fs.readFileSync(APP_CONTEXT_PATH, 'utf8');
  assert.ok(source.includes('loadCharacterLibraryWithRevision()'),
    '启动加载与刷新都必须走这个读法');
  // 裸 getCharacterLibrary() 一旦回归，版本号就不会被 prime。
  assert.ok(!/[^a-zA-Z]getCharacterLibrary\(/.test(source),
    '不许再直接 getCharacterLibrary()（它不更新版本号）');
});

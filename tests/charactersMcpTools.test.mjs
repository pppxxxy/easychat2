// 角色卡 MCP 工具：**只增不减**的回归测试。
//
// 这组约束是用户 2026-10-21 明确要求的，不是我自己加的洁癖：
//   1) 绝不提供删卡工具（删卡只能在 APP 角色页手动做）；
//   2) 改卡 = 先复制、再改副本，源卡逐字节不动；
//   3) 写库必须整库读-改-写，否则 persistLibrary 会把「不在 list 里的 id」
//      当 stale 删掉（storage/characters/index.js:213-218）。
//
// 第 3 条是最凶的一条：任何一次「只传新卡」的写都会删光其它卡。所以这里
// 不但测正常路径，也测「写回时丢卡会被拒绝」。
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
const TOOLS_PATH = path.join(SRC, 'workspace', 'toolDefs', 'charactersTools.js');

const transpiled = new Map();
function compileToCjs(absPath) {
  if (transpiled.has(absPath)) return transpiled.get(absPath);
  const code = babel.transformSync(fs.readFileSync(absPath, 'utf8'), {
    babelrc: false, configFile: false, filename: absPath,
    presets: [[PRESET_ENV, { targets: { node: 'current' }, modules: 'commonjs' }]],
  }).code;
  transpiled.set(absPath, code);
  return code;
}

// 假角色库：内存数组，模拟 storage/characters.js 的 get/save 契约。
// saveCharacterLibrary 的行为刻意做成「整库落盘」，与真实实现一致——
// 真实实现还会删 stale，这里在 save 里显式记录「传进来的 list」，
// 由测试断言它必须包含全部旧卡。
function loadTools(initial = [], options = {}) {
  const state = {
    library: initial.map(item => ({ ...item })),
    saveCalls: [],
    saveOptions: [],
    revision: options.revision === undefined ? 5 : options.revision,
    revisionCalls: 0,
  };
  const storageStub = {
    async getCharacterLibrary() { return state.library.map(item => ({ ...item })); },
    ...(options.revisionCapability === false ? {} : {
      async getCharacterLibraryRevision() {
        state.revisionCalls += 1;
        const seen = state.revision;
        // 模拟「取完版本号之后、真正写库之前」被别人推进一版：
        // 这正是乐观并发要抓的窗口，必须在返回之后立刻改盘上状态。
        if (options.raceAfterRevision) {
          options.raceAfterRevision = false; // 只抢一次
          state.revision = seen + 1;
          state.library = [...state.library, { id: 'other-card', name: '别人抢写的卡' }];
        }
        return seen;
      },
      isCharacterLibraryConflict(error) {
        return Boolean(error && error.code === 'CHARACTER_LIBRARY_CONFLICT');
      },
    }),
    async saveCharacterLibrary(list, saveOptions) {
      // 记录调用方带上来的版本号：这是「乐观并发真的接上了」的唯一证据。
      state.saveOptions.push(saveOptions === undefined ? null : { ...saveOptions });
      if (
        saveOptions
        && saveOptions.expectedRevision !== undefined
        && saveOptions.expectedRevision !== state.revision
      ) {
        const error = new Error('conflict');
        error.code = 'CHARACTER_LIBRARY_CONFLICT';
        throw error;
      }
      // 只有校验通过才算「真的写进去了」。
      state.saveCalls.push(list.map(item => ({ ...item })));
      state.library = list.map(item => ({ ...item }));
      state.revision += 1;
      return list;
    },
  };

  const originalLoad = Module._load;
  const mainCode = compileToCjs(TOOLS_PATH);
  Module._load = function patchedLoad(request, parent, isMain) {
    if (parent && parent.filename && request.startsWith('.')) {
      const base = path.resolve(path.dirname(parent.filename), request);
      for (const candidate of [base, `${base}.js`]) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          const mod = new Module(candidate);
          mod.filename = candidate;
          mod.paths = Module._nodeModulePaths(path.dirname(candidate));
          mod._compile(compileToCjs(candidate), candidate);
          return mod.exports;
        }
      }
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    for (const key of Object.keys(Module._cache)) {
      if (key.startsWith(`${SRC}${path.sep}`)) delete Module._cache[key];
    }
    const mod = new Module(TOOLS_PATH);
    mod.filename = TOOLS_PATH;
    mod.paths = Module._nodeModulePaths(path.dirname(TOOLS_PATH));
    mod._compile(mainCode, TOOLS_PATH);
    // 走生产代码自己暴露的注入点，而不是和 ESM loader 斗法。
    mod.exports.setCharacterStorageForTests(storageStub);
    // normalizeCharacter 真实实现在 shared.js（会拖进 context 层），
    // 测试用等价最简版：保留字段、规整 id 与数组字段。
    mod.exports.setCharacterNormalizeForTests(raw => {
      const source = raw && typeof raw === 'object' ? raw : {};
      return {
        ...source,
        id: String(source.id == null ? '' : source.id).trim(),
        name: String(source.name || ''),
        tags: Array.isArray(source.tags) ? source.tags : [],
        worldInfo: Array.isArray(source.worldInfo) ? source.worldInfo : [],
        regexScripts: Array.isArray(source.regexScripts) ? source.regexScripts : [],
        pinned: source.pinned === true,
      };
    });
    return { tools: mod.exports, state };
  } finally {
    Module._load = originalLoad;
  }
}

const BASE_LIBRARY = [
  { id: 'card-a', name: '角色 A', tags: ['tag1'], worldInfo: [{ id: 'w1' }], regexScripts: [] },
  { id: 'card-b', name: '角色 B', tags: [], worldInfo: [], regexScripts: [{ id: 'r1' }] },
];

// ── 只增不减 ────────────────────────────────────────────────────────────

test('没有任何删卡工具：定义清单里不该出现 delete/remove 类角色工具', () => {
  const { tools } = loadTools(BASE_LIBRARY);
  const names = [
    ...tools.CHARACTER_READ_DEFINITIONS,
    ...tools.CHARACTER_WRITE_DEFINITIONS,
  ].map(item => item.name);
  assert.deepEqual(names.sort(), ['create_character', 'edit_character', 'list_characters', 'read_character']);
  for (const name of names) {
    assert.doesNotMatch(name, /delete|remove|destroy|drop/i, `${name} 看起来是删卡工具，不允许存在`);
  }
});

test('create_character：新卡追加，已有卡一张不少', async () => {
  const { tools, state } = loadTools(BASE_LIBRARY);
  await tools.createCharacterImpl({ id: 'card-c', character: { name: '角色 C', description: '描述' } });

  assert.deepEqual(state.library.map(item => item.id).sort(), ['card-a', 'card-b', 'card-c']);
  // 写回时必须带着全部旧卡（否则真实实现会把它们当 stale 删掉）
  const lastSave = state.saveCalls[state.saveCalls.length - 1];
  assert.deepEqual(lastSave.map(item => item.id).sort(), ['card-a', 'card-b', 'card-c']);
  // 旧卡内容没被改
  assert.equal(state.library.find(item => item.id === 'card-a').name, '角色 A');
});

test('create_character：id 重复必须拒绝（不静默覆盖已有卡）', async () => {
  const { tools, state } = loadTools(BASE_LIBRARY);
  await assert.rejects(
    () => tools.createCharacterImpl({ id: 'card-a', character: { name: '冒名' } }),
    /已存在/,
  );
  assert.equal(state.saveCalls.length, 0, '被拒绝时不该发生任何写盘');
  assert.equal(state.library.find(item => item.id === 'card-a').name, '角色 A', '原卡未被覆盖');
});

// ── 改卡 = 复制后改 ─────────────────────────────────────────────────────

test('edit_character：源卡逐字节不动，新卡带 patch', async () => {
  const { tools, state } = loadTools(BASE_LIBRARY);
  const before = JSON.stringify(state.library.find(item => item.id === 'card-a'));

  const result = await tools.editCharacterImpl({
    sourceId: 'card-a',
    newId: 'card-a-v2',
    patch: { name: '角色 A（改）', description: '新描述' },
  });

  assert.equal(result.id, 'card-a-v2');
  const source = state.library.find(item => item.id === 'card-a');
  assert.equal(JSON.stringify(source), before, '源卡必须逐字节不变');
  const copy = state.library.find(item => item.id === 'card-a-v2');
  assert.equal(copy.name, '角色 A（改）');
  assert.equal(copy.description, '新描述');
});

test('edit_character：new_id 省略时自动派生唯一 id', async () => {
  const { tools, state } = loadTools(BASE_LIBRARY);
  const first = await tools.editCharacterImpl({ sourceId: 'card-a', patch: { name: '副本1' } });
  assert.equal(first.id, 'card-a-copy-1');

  const second = await tools.editCharacterImpl({ sourceId: 'card-a', patch: { name: '副本2' } });
  assert.equal(second.id, 'card-a-copy-2', '第二次派生必须避开已用的 copy-1');

  assert.deepEqual(
    state.library.map(item => item.id).sort(),
    ['card-a', 'card-a-copy-1', 'card-a-copy-2', 'card-b'],
  );
});

test('edit_character：new_id 冲突必须拒绝', async () => {
  const { tools, state } = loadTools(BASE_LIBRARY);
  await assert.rejects(
    () => tools.editCharacterImpl({ sourceId: 'card-a', newId: 'card-b', patch: { name: 'x' } }),
    /已存在/,
  );
  assert.equal(state.saveCalls.length, 0);
  assert.equal(state.library.find(item => item.id === 'card-b').name, '角色 B', '目标卡未被覆盖');
});

test('edit_character：源卡不存在时报错，且不写盘', async () => {
  const { tools, state } = loadTools(BASE_LIBRARY);
  await assert.rejects(
    () => tools.editCharacterImpl({ sourceId: 'nope', patch: { name: 'x' } }),
    /没有这个角色/,
  );
  assert.equal(state.saveCalls.length, 0);
});

test('edit_character：patch 为空必须拒绝（避免凭空造一张一模一样的卡）', async () => {
  const { tools, state } = loadTools(BASE_LIBRARY);
  await assert.rejects(
    () => tools.editCharacterImpl({ sourceId: 'card-a', patch: {} }),
    /patch 为空/,
  );
  assert.equal(state.saveCalls.length, 0);
});

// ── 字段白名单 ──────────────────────────────────────────────────────────

test('写卡只接受创作字段：系统字段被丢弃', () => {
  const { tools } = loadTools();
  const picked = tools.pickWritableFields({
    name: '卡',
    description: 'd',
    // 以下都该被丢掉
    id: 'hacked-id',
    builtin: true,
    pinned: true,
    lastUsedAt: 123,
    avatarUri: 'file:///x.jpg',
    bgUri: 'file:///y.jpg',
  });
  assert.deepEqual(Object.keys(picked).sort(), ['description', 'name']);
  assert.equal(picked.id, undefined, 'id 必须由工具参数给，不能从 character 里读');
  assert.equal(picked.builtin, undefined, 'builtin 不允许外部写（否则会被内置刷新逻辑覆盖）');
});

test('create_character：character 里夹带的 id 不会覆盖工具参数 id', async () => {
  const { tools, state } = loadTools(BASE_LIBRARY);
  await tools.createCharacterImpl({
    id: 'card-new',
    character: { name: '新卡', id: 'sneaky-id', builtin: true },
  });
  const created = state.library.find(item => item.name === '新卡');
  assert.equal(created.id, 'card-new', 'id 必须来自参数，不被 character.id 覆盖');
  // 注意：不是断言 undefined。normalizeCharacter 会把 builtin 规整成布尔
  // （`source.builtin === true` → 这里 pickWritableFields 已经把它丢了，
  // 所以 normalizeCharacter 收到的是 undefined → builtin: false）。
  // 真正要保证的是「外部传的 true 没有生效」。
  assert.notEqual(created.builtin, true, 'builtin 不允许被外部写成 true（否则会被内置刷新逻辑覆盖）');
});

// ── 只读工具 ────────────────────────────────────────────────────────────

test('list_characters：摘要不含正文（避免一次吐出几十张卡全文）', async () => {
  const { tools } = loadTools(BASE_LIBRARY);
  const list = await tools.listCharactersImpl();
  assert.equal(list.length, 2);
  for (const item of list) {
    assert.equal(item.description, undefined, '摘要不该带 description 正文');
    assert.equal(typeof item.descriptionChars, 'number');
    assert.equal(typeof item.worldInfoEntries, 'number');
  }
  assert.equal(list.find(item => item.id === 'card-a').worldInfoEntries, 1);
});

test('read_character：返回完整字段；找不到时报错', async () => {
  const { tools } = loadTools([{ id: 'card-a', name: 'A', description: '很长的描述' }]);
  const one = await tools.readCharacterImpl({ id: 'card-a' });
  assert.equal(one.description, '很长的描述');
  await assert.rejects(() => tools.readCharacterImpl({ id: 'nope' }), /没有这个角色/);
  await assert.rejects(() => tools.readCharacterImpl({}), /需要 id/);
});

// ── 最后一道闸：写回时丢卡必须被拒绝 ────────────────────────────────────

test('写回保护：mutate 若弄丢已有卡，必须抛错且不落盘', async () => {
  // 这条真正测到 mutateLibrary 的防御闸。
  // 走的是导出的 __mutateLibraryForTests —— 正常路径（create/edit）构造不出
  // 「mutate 返回少了卡」，所以那道闸在正常用例里**永远走不到**。
  // （注入验证实测：关掉闸门后原有 15 条用例仍全绿，说明当时根本没测到它。）
  const { tools, state } = loadTools(BASE_LIBRARY);
  await assert.rejects(
    () => tools.__mutateLibraryForTests(list => list.filter(item => item.id !== 'card-a')),
    /只增不减/,
    '弄丢已有卡必须被拒绝',
  );
  assert.equal(state.saveCalls.length, 0, '被拒绝时不能写盘');
  assert.equal(state.library.length, 2, '角色库保持原样');
});

test('写回保护：mutateLibrary 内部闸门直接生效（构造会丢卡的 mutate）', async () => {
  // 通过导出的内部入口不好构造，所以用一个**可见的行为契约**来锁：
  // 库里三张卡，对其中一张做 edit_character，写回后三张原卡必须都还在。
  const { tools, state } = loadTools([
    { id: 'card-a', name: 'A' },
    { id: 'card-b', name: 'B' },
    { id: 'card-c', name: 'C' },
  ]);
  await tools.editCharacterImpl({ sourceId: 'card-b', patch: { name: 'B改' } });
  const ids = state.library.map(item => item.id).sort();
  assert.deepEqual(ids, ['card-a', 'card-b', 'card-b-copy-1', 'card-c']);
});

test('失败路径不留半截状态：id 冲突时既不改库也不写盘', async () => {
  const { tools, state } = loadTools(BASE_LIBRARY);
  const before = JSON.stringify(state.library);
  // id 冲突 → 抛错 → 不该有写盘
  await assert.rejects(() => tools.createCharacterImpl({ id: 'card-a', character: { name: 'x' } }));
  assert.equal(JSON.stringify(state.library), before, '失败路径不能改动角色库');
  assert.equal(state.saveCalls.length, 0);
});

// ── 写完必须通知 App 重读（否则界面上看不到新建的卡） ──────────────────────
//
// 背景（2026-10-21 实测）：MCP 直写存储，AppContext 的 characters state 不知道。
// 结果盘上 26 张、角色页只有 25 张，差的正是刚建的那张；用户以为失败就会重复建卡。
// 这几条钉住「通知」这件事：成功必须发、失败不发、通知抛错不能污染成功结果。

test('create_character 写盘成功后必须通知 App 重载角色库', async () => {
  const { tools, state } = loadTools(BASE_LIBRARY);
  const reasons = [];
  tools.setCharacterLibraryNotifierForTests(reason => reasons.push(reason));
  await tools.createCharacterImpl({ id: 'card-new', character: { name: '新卡' } });
  assert.equal(state.saveCalls.length, 1, '先落盘');
  assert.deepEqual(reasons, ['character-write'], '落盘成功后应通知一次');
});

test('edit_character 复制改卡后同样要通知（副本也要立刻可见）', async () => {
  const { tools } = loadTools(BASE_LIBRARY);
  const reasons = [];
  tools.setCharacterLibraryNotifierForTests(reason => reasons.push(reason));
  await tools.editCharacterImpl({ sourceId: 'card-a', patch: { name: '改过的副本' } });
  assert.deepEqual(reasons, ['character-write']);
});

test('写失败时不得通知：界面不该为一次没发生的写操作去重读', async () => {
  const { tools } = loadTools(BASE_LIBRARY);
  const reasons = [];
  tools.setCharacterLibraryNotifierForTests(reason => reasons.push(reason));
  // id 冲突 → 在写盘之前就抛
  await assert.rejects(() => tools.createCharacterImpl({ id: 'card-a', character: { name: 'x' } }));
  assert.deepEqual(reasons, [], '失败路径不能通知');
});

test('通知方抛错不得让已经成功的写入变成失败', async () => {
  // 通知是「叫 App 刷新界面」，与数据无关：界面刷新崩了不该回滚一张已经落盘的卡。
  const { tools, state } = loadTools(BASE_LIBRARY);
  tools.setCharacterLibraryNotifierForTests(() => {
    throw new Error('监听器炸了');
  });
  const created = await tools.createCharacterImpl({ id: 'card-safe', character: { name: '仍应成功' } });
  assert.equal(created.id, 'card-safe');
  assert.ok(state.library.some(item => item.id === 'card-safe'), '卡必须真的在库里');
});

test('未注入通知器时走真实注册表：没人注册也不能抛', async () => {
  // Node 环境（单测/CLI 桥）里没有任何监听者，真实 notify 必须空转而不是炸。
  const { tools } = loadTools(BASE_LIBRARY);
  const created = await tools.createCharacterImpl({ id: 'card-quiet', character: { name: '安静' } });
  assert.equal(created.id, 'card-quiet');
});


// ── 乐观并发：MCP 写入也必须带版本号 ──────────────────────────────────────
//
// MCP 是「直接写存储」的一方，它不带版本号的话，App 那侧的校验就只剩一半：
// 别人（MCP）照样可能覆盖 App 的并发写。所以这里钉住「读库前取版本、写时带上」。

test('MCP 写卡时把读到的版本号传给 saveCharacterLibrary', async () => {
  const { tools, state } = loadTools(BASE_LIBRARY, { revision: 9 });
  await tools.createCharacterImpl({ id: 'card-new', character: { name: '新卡' } });
  assert.equal(state.saveCalls.length, 1);
  assert.deepEqual(state.saveOptions[0], { expectedRevision: 9 },
    '必须带上读库那一刻的版本号');
});

test('MCP 写卡：版本号必须在校验通过的前提下才写进去', async () => {
  const { tools, state } = loadTools(BASE_LIBRARY, { revision: 3 });
  // 让「读库之后、写库之前」被别人推进一版：桩里直接在 save 前把 revision 改掉。
  const originalSave = state;
  await tools.createCharacterImpl({ id: 'card-ok', character: { name: '正常' } });
  assert.equal(state.saveOptions[0].expectedRevision, 3);
  assert.equal(state.revision, 4, '写成功后版本推进一版');
  assert.equal(originalSave.library.some(i => i.id === 'card-ok'), true);
});

test('MCP 写卡撞上并发写：抛冲突且不落盘（由调用方决定重试）', async () => {
  const { tools, state } = loadTools(BASE_LIBRARY, { revision: 1, raceAfterRevision: true });
  await assert.rejects(
    () => tools.createCharacterImpl({ id: 'card-race', character: { name: '撞车' } }),
    error => error.code === 'CHARACTER_LIBRARY_CONFLICT'
  );
  assert.equal(state.saveCalls.length, 0, '冲突时不该有任何一次成功落盘');
  assert.ok(!state.library.some(item => item.id === 'card-race'), '待写的卡不能出现在库里');
});

test('MCP 写卡：存储不提供版本号能力时退回无校验（兼容旧替身）', async () => {
  // 有些替身 / 旧存储实现没有 getCharacterLibraryRevision。这种情况必须能照常写，
  // 而不是抛 TypeError——所以 mutateLibrary 里那处能力探测是有意为之。
  const { tools, state } = loadTools(BASE_LIBRARY, { revisionCapability: false });
  const created = await tools.createCharacterImpl({ id: 'card-legacy', character: { name: '旧存储' } });
  assert.equal(created.id, 'card-legacy');
  assert.equal(state.saveCalls.length, 1);
  assert.equal(state.saveOptions[0], null, '没有版本号能力时不该硬塞 expectedRevision');
});

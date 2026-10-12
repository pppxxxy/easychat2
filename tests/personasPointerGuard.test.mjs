import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

// 本文件覆盖本批第 4/5 项（src/storage/personas.js）：
//   4）legacy 迁移把「读失败」当「没有旧资料」，并**立刻写盘提交**迁移标记；
//   5）getActivePersonaId 是第三根未做三态转换的指针键，且失败方向比会话/角色更糟
//      （那两处失败返回 ''，这里返回 personas[0].id —— 主动指向**另一个人设**并写回盘上）。
// 第 5 项的第二层是独立缺陷：**同一次操作内两次独立读取，中间失败即错位**，
// 修法不是「加三态」而是「一次操作只读一次」，所以下面用 getItem 调用计数钉死。

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const presetEnv = require.resolve('@babel/preset-env');
const sourcePath = path.resolve('src/storage.js');
const transformed = babel.transformSync(fs.readFileSync(sourcePath, 'utf8'), {
  babelrc: false,
  configFile: false,
  filename: sourcePath,
  presets: [[presetEnv, { targets: { node: 'current' }, modules: 'commonjs' }]],
}).code;

const store = new Map();
const failedGets = new Set();
const getCalls = new Map();
// 「第二次读取返回不同值」的注入：用来证明同一次操作里根本没有第二次读取
//（有的话调用方就会按另一个值去写，正是路径 A 的错位形态）。
const secondReadValue = new Map();

const AsyncStorage = {
  getItem: async key => {
    const count = (getCalls.get(key) || 0) + 1;
    getCalls.set(key, count);
    if (failedGets.has(key)) throw new Error(`read failed: ${key}`);
    if (count >= 2 && secondReadValue.has(key)) return secondReadValue.get(key);
    return store.has(key) ? store.get(key) : null;
  },
  setItem: async (key, value) => {
    store.set(key, value);
  },
  removeItem: async key => {
    store.delete(key);
  },
  multiSet: async pairs => {
    for (const [key, value] of pairs) store.set(key, value);
  },
  multiRemove: async keys => {
    for (const key of keys) store.delete(key);
  },
  getAllKeys: async () => [...store.keys()],
};

const FileSystem = {
  documentDirectory: 'file:///documents/',
  cacheDirectory: 'file:///cache/',
  EncodingType: { Base64: 'base64', UTF8: 'utf8' },
  getInfoAsync: async () => ({ exists: false }),
  makeDirectoryAsync: async () => {},
  writeAsStringAsync: async () => {},
  readAsStringAsync: async () => '',
  readDirectoryAsync: async () => [],
  deleteAsync: async () => {},
};

const SQLite = { openDatabase: () => ({ execAsync: async () => [], closeAsync: async () => {} }) };

const STORAGE_DIR = path.resolve('src/storage');

function loadStorageModule(absPath) {
  const cached = Module._cache[absPath];
  if (cached) return cached.exports;
  const code = babel.transformSync(fs.readFileSync(absPath, 'utf8'), {
    babelrc: false,
    configFile: false,
    filename: absPath,
    presets: [[presetEnv, { targets: { node: 'current' }, modules: 'commonjs' }]],
  }).code;
  const mod = new Module(absPath);
  mod.filename = absPath;
  mod.paths = Module._nodeModulePaths(path.dirname(absPath));
  Module._cache[absPath] = mod;
  try {
    mod._compile(code, absPath);
  } catch (error) {
    delete Module._cache[absPath];
    throw error;
  }
  return mod.exports;
}

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === '@react-native-async-storage/async-storage') {
    return { __esModule: true, default: AsyncStorage };
  }
  if (request === 'expo-file-system' || request === 'expo-file-system/legacy') return FileSystem;
  if (request === 'expo-sqlite') return SQLite;
  if (request.endsWith('/presets.js') || request.endsWith('/presets')) {
    return { __esModule: true, default: [] };
  }
  if (request.endsWith('/imageGen/providers') || request.endsWith('/imageGen/providers.js')) {
    return { __esModule: true, isKnownImageProvider: () => true };
  }
  if (request.endsWith('/context/characterIdentity') || request === './context/characterIdentity.js') {
    return { __esModule: true };
  }
  if (request.endsWith('/context/sessionLibrary') || request === './context/sessionLibrary.js') {
    return { __esModule: true };
  }
  if (parent && parent.filename && request.startsWith('.')) {
    const resolved = path.resolve(path.dirname(parent.filename), request);
    if (resolved.startsWith(`${STORAGE_DIR}${path.sep}`) && fs.existsSync(resolved)) {
      return loadStorageModule(resolved);
    }
  }
  return originalLoad.call(this, request, parent, isMain);
};

globalThis.__DEV__ = false;

const filename = path.resolve('src/storage.js');
const runtimeModule = new Module(filename);
runtimeModule.filename = filename;
runtimeModule.paths = Module._nodeModulePaths(path.dirname(filename));
runtimeModule._compile(transformed, filename);

const personasModule = loadStorageModule(path.resolve('src/storage/personas.js'));

const {
  getPersonas,
  createPersona,
  deletePersona,
  saveUserProfile,
  setActivePersonaId,
} = runtimeModule.exports;
const { getActivePersonaId, getActivePersonaIdStatus } = personasModule;

const PERSONAS_KEY = '@easychat2_personas';
const ACTIVE_PERSONA_KEY = '@easychat2_active_persona';
const USER_PROFILE_KEY = '@easychat2_user_profile';
const BACKUP = '__corrupt_backup';

function reset() {
  store.clear();
  failedGets.clear();
  getCalls.clear();
  secondReadValue.clear();
}

// 两个人设的盘上状态：A 与 B，活跃指向 B。
function seedTwoPersonas(activeId = 'B') {
  store.set(PERSONAS_KEY, JSON.stringify([
    { id: 'A', userName: '甲', persona: '甲设定', createdAt: 1, updatedAt: 1 },
    { id: 'B', userName: '乙', persona: '乙设定', createdAt: 1, updatedAt: 1 },
  ]));
  store.set(ACTIVE_PERSONA_KEY, JSON.stringify(activeId));
}

function personaById(id) {
  return JSON.parse(store.get(PERSONAS_KEY)).find(item => item.id === id);
}

// ---- 第 4 项：legacy 迁移不得把「读失败」当成「没有旧资料」 ----

test('迁移：USER_PROFILE_KEY 读失败时不写 PERSONAS_KEY（留待下次重试）', async () => {
  reset();
  const legacy = { userName: '我', persona: '旧资料', avatarUri: '' };
  store.set(USER_PROFILE_KEY, JSON.stringify(legacy));
  failedGets.add(USER_PROFILE_KEY);
  await assert.rejects(getPersonas(), /旧版资料读取失败/, '读不出旧资料必须抛错中止迁移');
  assert.equal(store.has(PERSONAS_KEY), false, '不得写下迁移标记：写了就永远走 ok 分支、迁移不再重跑');
  // 故障恢复后重试：旧资料必须仍能被迁移进来（磁盘上完好的数据不可达才是真正的损失）
  failedGets.delete(USER_PROFILE_KEY);
  const migrated = await getPersonas();
  assert.equal(migrated.length, 1);
  assert.equal(migrated[0].userName, '我', '重试必须读到真实旧资料');
  assert.equal(migrated[0].persona, '旧资料');
  assert.equal(JSON.parse(store.get(PERSONAS_KEY))[0].userName, '我');
});

test('迁移：USER_PROFILE_KEY 形状坏（第四态）时归 corrupt + 已备份 + 不写 PERSONAS_KEY', async () => {
  reset();
  store.set(USER_PROFILE_KEY, '[]');
  await assert.rejects(getPersonas(), /旧版资料读取失败/);
  assert.equal(store.get(`${USER_PROFILE_KEY}${BACKUP}`), '[]', '先留原始副本');
  assert.equal(store.has(PERSONAS_KEY), false, '不得提交迁移标记');
});

test('迁移：USER_PROFILE_KEY 损坏（坏 JSON）时同样中止且不写 PERSONAS_KEY', async () => {
  reset();
  store.set(USER_PROFILE_KEY, '{ 不是 JSON');
  await assert.rejects(getPersonas(), /旧版资料读取失败/);
  assert.equal(store.get(`${USER_PROFILE_KEY}${BACKUP}`), '{ 不是 JSON');
  assert.equal(store.has(PERSONAS_KEY), false);
});

test('迁移：仅 missing 才用默认值建空人设（防过度修正）', async () => {
  reset();
  const list = await getPersonas();
  assert.equal(list.length, 1);
  assert.equal(list[0].userName, '', '没有旧资料 → 空人设');
  assert.equal(list[0].persona, '');
  assert.equal(store.has(PERSONAS_KEY), true, 'missing 时照常建库');
});

test('迁移：用户名非空但其它字段缺失时照常迁移', async () => {
  reset();
  store.set(USER_PROFILE_KEY, JSON.stringify({ userName: '半截资料' }));
  const list = await getPersonas();
  assert.equal(list[0].userName, '半截资料');
  assert.equal(list[0].persona, '');
});

// ---- 第 5 项：活动人设指针的三态 ----

test('指针：corrupt（坏 JSON）→ status corrupt、不回落（值的形态与 getActiveCharacterIdStatus 同构）', async () => {
  reset();
  const list = [{ id: 'A' }, { id: 'B' }];
  store.set(ACTIVE_PERSONA_KEY, '{ 坏指针');
  const status = await getActivePersonaIdStatus(list);
  assert.equal(status.status, 'corrupt');
  assert.equal(status.value, '', 'corrupt 不得回落成 personas[0].id（那会指向另一个人设）');
  assert.equal(await getActivePersonaId(list), '', '只读包装同样不回落');
});

test('指针：getItem 抛错同样归 corrupt（不回落）', async () => {
  reset();
  const list = [{ id: 'A' }, { id: 'B' }];
  failedGets.add(ACTIVE_PERSONA_KEY);
  const status = await getActivePersonaIdStatus(list);
  assert.equal(status.status, 'corrupt');
  assert.equal(status.value, '');
});

test('指针：ok 且值在列表里 → 原值；值不在列表里 → 容错回落首个人设（行为不变）', async () => {
  reset();
  const list = [{ id: 'A' }, { id: 'B' }];
  store.set(ACTIVE_PERSONA_KEY, JSON.stringify('B'));
  const ok = await getActivePersonaIdStatus(list);
  assert.equal(ok.status, 'ok');
  assert.equal(ok.value, 'B');
  assert.equal(ok.stored, 'B');
  store.set(ACTIVE_PERSONA_KEY, JSON.stringify('已删除的 id'));
  const fallback = await getActivePersonaIdStatus(list);
  assert.equal(fallback.status, 'ok');
  assert.equal(fallback.value, 'A', '保持既有容错：值不在列表里就回落首个人设');
  assert.equal(fallback.stored, '已删除的 id', 'stored 保留盘上原值，供「确实变了才写」判定');
});

test('指针：missing → 回落首个人设且允许写回（deletePersona 场景）', async () => {
  reset();
  store.set(PERSONAS_KEY, JSON.stringify([
    { id: 'A', userName: '甲', persona: '', createdAt: 1, updatedAt: 1 },
    { id: 'B', userName: '乙', persona: '', createdAt: 1, updatedAt: 1 },
  ]));
  // 指针键从未存在过 = 真的没设过（不是读失败）：此时回落首个人设并允许写回。
  const status = await getActivePersonaIdStatus([{ id: 'A' }, { id: 'B' }]);
  assert.equal(status.status, 'missing');
  assert.equal(status.value, 'A');
  assert.equal(status.stored, '');
});

test('指针：deletePersona 在 corrupt 时**不改写** ACTIVE_PERSONA_KEY（路径 B）', async () => {
  reset();
  seedTwoPersonas();
  // 一次性把活跃人设 B 删掉：旧实现在这里读失败 → activeId = personas[0].id = 'A'
  // → setItem(ACTIVE_PERSONA_KEY, 'A')，一次瞬时读失败就永久改掉「上次用的人设」。
  store.set(ACTIVE_PERSONA_KEY, '{ 坏指针');
  const result = await deletePersona('B');
  assert.equal(result.personas.length, 1);
  assert.equal(result.activeIdPersisted, false, 'corrupt 时一律不写回');
  assert.equal(store.get(ACTIVE_PERSONA_KEY), '{ 坏指针', '盘上指针必须原样不动');
  assert.equal(store.get(`${ACTIVE_PERSONA_KEY}${BACKUP}`), '{ 坏指针', '留原始副本供人工恢复');
});

test('指针：deletePersona 在「ok 且值确实变了」时才写回', async () => {
  reset();
  seedTwoPersonas('B');
  // 删掉活跃人设 B：解析结果变成 A，确实变了 → 必须写回。
  const result = await deletePersona('B');
  assert.equal(result.activeId, 'A');
  assert.equal(result.activeIdPersisted, true);
  assert.equal(store.get(ACTIVE_PERSONA_KEY), JSON.stringify('A'));
});

test('指针：deletePersona 在「ok 且值没变」时不写回', async () => {
  reset();
  seedTwoPersonas('A');
  const result = await deletePersona('B');
  assert.equal(result.activeId, 'A');
  assert.equal(result.activeIdPersisted, false, '活跃指针没变就不该再写一次盘');
  assert.equal(store.get(ACTIVE_PERSONA_KEY), JSON.stringify('A'));
});

test('指针：saveUserProfile 在 corrupt 时整体中止（路径 A：不得把 B 的内容写进 A）', async () => {
  reset();
  seedTwoPersonas('B');
  const before = store.get(PERSONAS_KEY);
  const beforeProfile = store.has(USER_PROFILE_KEY) ? store.get(USER_PROFILE_KEY) : null;
  store.set(ACTIVE_PERSONA_KEY, '{ 坏指针');
  await assert.rejects(
    saveUserProfile({ userName: '新名字', persona: '新设定' }),
    /当前使用的人设读取失败/,
    '读不出活跃人设时必须抛错，否则内容会写到**另一个人设**上且用户看不到提示',
  );
  assert.equal(store.get(PERSONAS_KEY), before, '两个人设的内容都不得被改写');
  assert.equal(store.has(USER_PROFILE_KEY) ? store.get(USER_PROFILE_KEY) : null, beforeProfile, '不做半写');
  assert.equal(store.get(ACTIVE_PERSONA_KEY), '{ 坏指针', '指针也不得被改写');
  assert.equal(store.get(`${ACTIVE_PERSONA_KEY}${BACKUP}`), '{ 坏指针');
});

test('指针：saveUserProfile 正常路径写到活跃人设上且只读一次指针（第二层）', async () => {
  reset();
  seedTwoPersonas('B');
  // 第二层缺陷的复现注入：若这次操作里有**第二次**读取，它会拿到 A —— 结果就会写错人设。
  secondReadValue.set(ACTIVE_PERSONA_KEY, JSON.stringify('A'));
  await saveUserProfile({ userName: '新名字', persona: '新设定' });
  assert.equal(personaById('B').userName, '新名字', '必须写进第一次读到的 B');
  assert.equal(personaById('B').persona, '新设定');
  assert.equal(personaById('A').userName, '甲', 'A 不得被 B 的内容整段覆盖（路径 A 的数据丢失）');
  assert.equal(personaById('A').persona, '甲设定');
  assert.equal(
    getCalls.get(ACTIVE_PERSONA_KEY),
    1,
    '第二层修法不是「加三态」而是「一次操作只读一次」：整段 saveUserProfile 只能读一次指针',
  );
});

test('指针：deletePersona 同样只读一次指针（第二层）', async () => {
  reset();
  seedTwoPersonas('B');
  secondReadValue.set(ACTIVE_PERSONA_KEY, JSON.stringify('A'));
  const result = await deletePersona('B');
  assert.equal(result.activeId, 'A', '按第一次读到的 B（=被删的那条）解析出 remaining[0]');
  assert.equal(result.activeIdPersisted, true);
  assert.equal(store.get(ACTIVE_PERSONA_KEY), JSON.stringify('A'));
  assert.equal(getCalls.get(ACTIVE_PERSONA_KEY), 1, '整段 deletePersona 只能读一次指针');
});

test('指针：正常保存/切换的既有行为不变（防过度修正）', async () => {
  reset();
  seedTwoPersonas('A');
  await saveUserProfile({ userName: '我', persona: '设定' });
  assert.equal(personaById('A').userName, '我');
  assert.equal(personaById('B').userName, '乙');
  const created = await createPersona({ userName: '丙' });
  assert.equal(await setActivePersonaId(created.id), created.id);
  assert.equal(store.get(ACTIVE_PERSONA_KEY), JSON.stringify(created.id));
  assert.equal(await getActivePersonaId(await getPersonas()), created.id);
});

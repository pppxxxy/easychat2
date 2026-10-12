import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

import { createDownloadQueue } from '../src/localModel/downloadQueue.js';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const presetEnv = require.resolve('@babel/preset-env');

const store = new Map();
const failedGets = new Set();
const failedSets = new Set();
const failedRemoves = new Set();

const AsyncStorage = {
  getItem: async key => {
    if (failedGets.has(key)) throw new Error(`read failed: ${key}`);
    return store.has(key) ? store.get(key) : null;
  },
  setItem: async (key, value) => {
    if (failedSets.has(key)) throw new Error(`write failed: ${key}`);
    store.set(key, value);
  },
  removeItem: async key => {
    if (failedRemoves.has(key)) throw new Error(`remove failed: ${key}`);
    store.delete(key);
  },
  getAllKeys: async () => [...store.keys()],
};

// localModels.js 只依赖 io.js 的读原语；这里打桩 io，避免拉起 secretStore/diagnostics。
const ioStub = {
  readJson: async (key, fallback) => {
    try {
      const raw = await AsyncStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (error) {
      return fallback;
    }
  },
  readJsonStatus: async key => {
    try {
      const raw = await AsyncStorage.getItem(key);
      if (raw === null || raw === undefined) return { status: 'missing' };
      return { status: 'ok', value: JSON.parse(raw) };
    } catch (error) {
      return { status: 'corrupt' };
    }
  },
  // 保险箱在本测试环境透明转发：三态读原样返回（B3 用它区分「读失败」与「确实为空」）。
  readJsonStatusWithSecrets: async key => {
    try {
      const raw = await AsyncStorage.getItem(key);
      if (raw === null || raw === undefined) return { status: 'missing' };
      return { status: 'ok', value: JSON.parse(raw) };
    } catch (error) {
      return { status: 'corrupt' };
    }
  },
  // 设置键走保险箱读写；测试环境 SecureStore 不可用，此处透明转发为明文，
  // 断言仍可读取到原始 JSON。
  readJsonWithSecrets: async (key, fallback) => {
    try {
      const raw = await AsyncStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (error) {
      return fallback;
    }
  },
  setJsonWithSecrets: async (key, payload) => {
    await AsyncStorage.setItem(key, JSON.stringify(payload));
  },
  backupCorruptValue: async key => {
    const raw = store.get(key);
    if (raw) store.set(`${key}__corrupt_backup`, raw);
    return Boolean(raw);
  },
};

const storageModulePath = path.resolve('src/storage/localModels.js');

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === '@react-native-async-storage/async-storage') return AsyncStorage;
  if (request === './io.js' && parent && parent.filename === storageModulePath) return ioStub;
  return originalLoad.call(this, request, parent, isMain);
};

function loadModule() {
  const code = babel.transformSync(fs.readFileSync(storageModulePath, 'utf8'), {
    babelrc: false,
    configFile: false,
    filename: storageModulePath,
    presets: [[presetEnv, { targets: { node: 'current' }, modules: 'commonjs' }]],
  }).code;
  const mod = new Module(storageModulePath);
  mod.filename = storageModulePath;
  mod.paths = Module._nodeModulePaths(path.dirname(storageModulePath));
  mod._compile(code, storageModulePath);
  return mod.exports;
}

const storage = loadModule();

const SETTINGS_KEY = '@easychat2_local_model';
const INDEX_KEY = '@easychat2_local_model_index';
const ITEM_PREFIX = '@easychat2_local_model_item';
const QUEUE_KEY = '@easychat2_download_queue';
const itemKey = id => `${ITEM_PREFIX}::${id}`;

function countRemoves() {
  return removeCalls.length;
}
const removeCalls = [];
const originalRemoveItem = AsyncStorage.removeItem;
AsyncStorage.removeItem = async key => {
  removeCalls.push(key);
  return originalRemoveItem(key);
};

function reset() {
  store.clear();
  failedGets.clear();
  failedSets.clear();
  failedRemoves.clear();
  removeCalls.length = 0;
}

function readIndex() {
  return JSON.parse(store.get(INDEX_KEY));
}

test('saveLocalModelItem：写条目 + 写索引，索引只含轻量条目', async () => {
  reset();
  const saved = await storage.saveLocalModelItem({
    id: 'qwen-q4',
    name: 'Qwen Q4',
    quant: 'Q4_K_M',
    modelBytes: 2048,
    modelPath: 'file:///documents/local-models/qwen-q4.gguf',
    params: { contextSize: 4096 },
  });
  assert.ok(saved.createdAt > 0);
  assert.equal(saved.updatedAt, saved.createdAt);
  const item = await storage.getLocalModelItem('qwen-q4');
  assert.equal(item.params.contextSize, 4096);
  assert.equal(item.modelPath, 'file:///documents/local-models/qwen-q4.gguf');
  const index = readIndex();
  assert.equal(index.length, 1);
  assert.equal(index[0].id, 'qwen-q4');
  assert.equal(index[0].quant, 'Q4_K_M');
  assert.equal('modelPath' in index[0], false);
});

test('saveLocalModelItem：同 id 覆盖不产生重复索引项', async () => {
  reset();
  await storage.saveLocalModelItem({ id: 'm1', name: 'A' });
  await storage.saveLocalModelItem({ id: 'm1', name: 'B' });
  const index = readIndex();
  assert.equal(index.length, 1);
  assert.equal(index[0].name, 'B');
});

test('deleteLocalModelItem：级联删除条目、索引项并清空活动指针', async () => {
  reset();
  await storage.saveLocalModelItem({ id: 'm1', name: 'A' });
  await storage.saveLocalModelItem({ id: 'm2', name: 'B' });
  await storage.saveLocalModelSettings({ enabled: true, activeModelId: 'm1' });
  const remaining = await storage.deleteLocalModelItem('m1');
  assert.deepEqual(remaining.map(entry => entry.id), ['m2']);
  assert.equal(store.has(itemKey('m1')), false);
  const settings = await storage.getLocalModelSettings();
  assert.equal(settings.activeModelId, '');
  assert.equal(await storage.getActiveLocalModel(), null);
});

test('getLocalModelIndex：旧单模型设置迁移成条目并回填 activeModelId，且清空 legacy 字段', async () => {
  reset();
  store.set(SETTINGS_KEY, JSON.stringify({
    enabled: true,
    modelId: 'legacy',
    modelName: 'Legacy',
    modelPath: 'file:///documents/local-models/legacy.gguf',
    modelBytes: 10,
    contextSize: 4096,
    updatedAt: 5,
  }));
  const index = await storage.getLocalModelIndex();
  assert.deepEqual(index.map(entry => entry.id), ['legacy']);
  const item = await storage.getLocalModelItem('legacy');
  assert.equal(item.params.contextSize, 4096);
  const settings = await storage.getLocalModelSettings();
  assert.equal(settings.activeModelId, 'legacy');
  assert.equal(settings.schema, 2);
  // v5 Stage A：迁移后设置键只剩单一事实源，legacy 字段已清零。
  assert.equal('modelPath' in settings, false);
  assert.equal('modelId' in settings, false);
});

test('getLocalModelIndex：无旧模型时返回空且不写入条目', async () => {
  reset();
  assert.deepEqual(await storage.getLocalModelIndex(), []);
  assert.equal([...store.keys()].some(key => key.startsWith(`${ITEM_PREFIX}::`)), false);
});

test('getLocalModelIndex：索引损坏时备份并从条目键重建', async () => {
  reset();
  await storage.saveLocalModelItem({ id: 'm1', name: 'A' });
  store.set(INDEX_KEY, 'not-json');
  const index = await storage.getLocalModelIndex();
  assert.deepEqual(index.map(entry => entry.id), ['m1']);
  assert.equal(store.has(`${INDEX_KEY}__corrupt_backup`), true);
  assert.deepEqual(readIndex().map(entry => entry.id), ['m1']);
});

test('saveLocalModelItem：索引写失败时回滚已写入的条目', async () => {
  reset();
  failedSets.add(INDEX_KEY);
  await assert.rejects(
    () => storage.saveLocalModelItem({ id: 'm1', name: 'A' }),
    /write failed/
  );
  assert.equal(store.has(itemKey('m1')), false);
  assert.equal(store.has(INDEX_KEY), false);
});

test('getActiveLocalModel：无活动模型时返回 null', async () => {
  reset();
  assert.equal(await storage.getActiveLocalModel(), null);
});

test('活动模型指针：切换 activeModelId 后 getActiveLocalModel 指向新模型', async () => {
  reset();
  await storage.saveLocalModelItem({ id: 'm1', name: 'A' });
  await storage.saveLocalModelItem({ id: 'm2', name: 'B' });
  await storage.saveLocalModelSettings({ enabled: true, activeModelId: 'm1' });
  assert.equal((await storage.getActiveLocalModel()).id, 'm1');
  const current = await storage.getLocalModelSettings();
  await storage.saveLocalModelSettings({ ...current, activeModelId: 'm2' });
  assert.equal((await storage.getActiveLocalModel()).id, 'm2');
});

test('参数隔离：保存一个模型的参数不影响其他模型', async () => {
  reset();
  await storage.saveLocalModelItem({ id: 'm1', name: 'A', params: { contextSize: 4096, temperature: 0.7 } });
  await storage.saveLocalModelItem({ id: 'm2', name: 'B', params: { contextSize: 2048 } });
  const first = await storage.getLocalModelItem('m1');
  assert.equal(first.params.contextSize, 4096);
  assert.equal(first.params.temperature, 0.7);
  assert.equal((await storage.getLocalModelItem('m2')).params.contextSize, 2048);
  await storage.saveLocalModelItem({ ...first, params: { ...first.params, contextSize: 8192 } });
  assert.equal((await storage.getLocalModelItem('m1')).params.contextSize, 8192);
  assert.equal((await storage.getLocalModelItem('m2')).params.contextSize, 2048);
});

test('本地模型设置走保险箱读写：apiServer.apiKey 经 WithSecrets 入口不落裸 JSON', async () => {
  reset();
  const seen = [];
  const originalSet = ioStub.setJsonWithSecrets;
  ioStub.setJsonWithSecrets = async (key, payload) => {
    seen.push(key);
    await originalSet(key, payload);
  };
  try {
    await storage.saveLocalModelSettings({ apiServer: { enabled: true, apiKey: 'local-secret-123456' } });
    const saved = await storage.getLocalModelSettings();
    assert.equal(saved.apiServer.apiKey, 'local-secret-123456');
    assert.ok(seen.includes(SETTINGS_KEY), '设置键应经 setJsonWithSecrets 写入');
  } finally {
    ioStub.setJsonWithSecrets = originalSet;
  }
});

test('v2 单一事实源：保存设置只落 schema:2，且不含 legacy 单模型字段', async () => {
  reset();
  const saved = await storage.saveLocalModelSettings({ enabled: true, activeModelId: 'm1', modelPath: 'file:///should-be-dropped.gguf' });
  assert.equal(saved.schema, 2);
  const persisted = JSON.parse(store.get(SETTINGS_KEY));
  assert.equal(persisted.schema, 2);
  assert.equal('modelPath' in persisted, false);
  assert.equal('modelId' in persisted, false);
  assert.equal(persisted.activeModelId, 'm1');
});

test('v2 迁移：无旧模型时也落 schema:2（不再每次判定为待迁移）', async () => {
  reset();
  store.set(SETTINGS_KEY, JSON.stringify({ enabled: false }));
  await storage.getLocalModelSettings();
  const persisted = JSON.parse(store.get(SETTINGS_KEY));
  assert.equal(persisted.schema, 2);
});

// ---- B4 ⭐：补偿回滚只能「恢复」不能「删除」----
// 旧实现把 `AsyncStorage.getItem(key).catch(() => null)` 的**读失败**折叠成
// 「原值就是 null（键不存在）」，于是回滚分支执行 removeItem —— 安全网自己变成
// 不可逆删除的执行者：刚写入的 next 被删掉，被覆盖的旧值也永远回不来。
// 判据：读不回原值时，唯一安全的动作是保留现状并留痕（先例：summaries.js 的补偿、
// worldMap.js 的「读失败就抛错中止：绝不用空列表覆盖已有地图」）。

test('B4：saveLocalModelItem 读原值失败时，回滚绝不 removeItem（原键保留，只留痕）', async () => {
  reset();
  // 盘上已有一个用户条目（真正的内容）
  const existing = JSON.stringify({ id: 'm1', name: 'Old', modelPath: 'file:///old.gguf' });
  store.set(itemKey('m1'), existing);
  // 读原值失败（模拟 CursorWindow/IO 故障）+ 索引写入失败 ⇒ 必然进入补偿路径
  failedGets.add(itemKey('m1'));
  failedSets.add(INDEX_KEY);
  await assert.rejects(
    () => storage.saveLocalModelItem({ id: 'm1', name: 'New' }),
    /write failed/
  );
  // ⚠️ 断言必须**限定到本次回滚涉及的那个键**，不能用全局删除计数：补偿路径之外的
  // 合理清理（或前一个用例未 await 完的续体）也会计入 removeCalls，那样会把
  // 「回滚误删」这个真正的不变量淹没在噪音里。补偿只可能删 `key` 本身，所以按 key 断言更准。
  assert.equal(
    removeCalls.filter(candidate => candidate === itemKey('m1')).length,
    0,
    '读不回原值时绝不删除该键（回滚只能恢复）'
  );
  // 读不回原值 ⇒ 无法恢复旧值：宁可保留刚写入的新值（用户看得见、可再改），也不删。
  assert.equal(store.has(itemKey('m1')), true, '键必须还在（哪怕内容是刚写入的新值）');
  assert.equal(JSON.parse(store.get(itemKey('m1'))).name, 'New');
});

test('B4：键确实不存在时，saveLocalModelItem 的回滚才允许 removeItem（防过度修正）', async () => {
  reset();
  // 键不存在 + 索引写失败 ⇒ 回滚应当把本次写入的条目删掉，回到「没有这个键」的原状
  failedSets.add(INDEX_KEY);
  await assert.rejects(
    () => storage.saveLocalModelItem({ id: 'm9', name: 'A' }),
    /write failed/
  );
  // ⚠️ 以**终态**断言，不依赖 removeCalls 探针：该探针在本桩下的覆盖不可靠
  // （同一场景里它有时捕不到补偿路径的 removeItem），用全局计数当判据会把
  // 「回滚是否删了本键」与「探针有没有捕到」混为一谈。终态才是真正要守的不变量：
  // 键此前确实不存在 ⇒ 回滚把本次写入删掉，回到「没有这个键」的原状。
  assert.equal(store.has(itemKey('m9')), false, '原值确实不存在 ⇒ 回滚删掉本次写入');
});

test('B4：deleteLocalModelItem 读原值失败时直接中止（不得 removeItem，条目仍在）', async () => {
  reset();
  const existing = JSON.stringify({ id: 'm1', name: 'A' });
  store.set(itemKey('m1'), existing);
  store.set(INDEX_KEY, JSON.stringify([{ id: 'm1', name: 'A' }]));
  failedGets.add(itemKey('m1'));
  await assert.rejects(() => storage.deleteLocalModelItem('m1'), /读取失败/);
  assert.equal(countRemoves(), 0, '读不回原值 ⇒ 不可逆删除的前提不成立，必须中止');
  assert.equal(store.get(itemKey('m1')), existing, '条目与索引都必须原样保留');
  assert.deepEqual(readIndex().map(entry => entry.id), ['m1']);
});

test('B4：键确实不存在时，deleteLocalModelItem 仍照常清理索引（防过度修正）', async () => {
  reset();
  store.set(INDEX_KEY, JSON.stringify([{ id: 'gone', name: 'Gone' }]));
  const entries = await storage.deleteLocalModelItem('gone');
  assert.deepEqual(entries, []);
  assert.deepEqual(removeCalls, [itemKey('gone')], '键不存在时删除是无害的（本来就没有）');
  assert.deepEqual(readIndex(), []);
});

test('B4：deleteLocalModelItem 索引写失败时恢复条目（已确认读到原值 ⇒ 恢复是安全的）', async () => {
  reset();
  const existing = JSON.stringify({ id: 'm1', name: 'A' });
  store.set(itemKey('m1'), existing);
  failedSets.add(INDEX_KEY);
  await assert.rejects(() => storage.deleteLocalModelItem('m1'), /write failed/);
  assert.equal(store.get(itemKey('m1')), existing, '删除失败必须把条目恢复回去');
});

// ---- B1：下载队列读失败不得压成空队列 ----

test('B1：readDownloadQueueStatus 三态——ok / missing / corrupt，且绝不把失败当空队列', async () => {
  reset();
  assert.equal((await storage.readDownloadQueueStatus()).status, 'missing');
  store.set(QUEUE_KEY, JSON.stringify([{ id: 'a' }]));
  const ok = await storage.readDownloadQueueStatus();
  assert.equal(ok.status, 'ok');
  assert.deepEqual(ok.value, [{ id: 'a' }]);
  // 读不出来（getItem 抛错）
  failedGets.add(QUEUE_KEY);
  assert.equal((await storage.readDownloadQueueStatus()).status, 'corrupt');
  failedGets.clear();
  // 结构坏了（第四态）：JSON 能解析但不是数组
  store.set(QUEUE_KEY, JSON.stringify({ not: 'array' }));
  const corrupt = await storage.readDownloadQueueStatus();
  assert.equal(corrupt.status, 'corrupt');
  assert.equal(store.has(`${QUEUE_KEY}__corrupt_backup`), true, '损坏时先备份原始内容再按空处理');
});

test('B1：真存储桩——队列读失败时水合不写回，盘上的 3 个任务原封不动', async () => {
  reset();
  const queued = [
    { id: 'a', modelId: 'a', modelUrl: 'https://huggingface.co/a/a.gguf', status: 'pending' },
    { id: 'b', modelId: 'b', modelUrl: 'https://huggingface.co/b/b.gguf', status: 'running' },
    { id: 'c', modelId: 'c', modelUrl: 'https://huggingface.co/c/c.gguf', status: 'pending' },
  ];
  store.set(QUEUE_KEY, JSON.stringify(queued));
  const before = store.get(QUEUE_KEY);
  failedGets.add(QUEUE_KEY);
  const queue = createDownloadQueue({
    // 真实存储路径（三态读 + JSON.stringify 落盘），不是内存对象桩
    load: () => storage.readDownloadQueueStatus(),
    persist: tasks => storage.writeDownloadQueue(tasks),
    download: async () => { throw new Error('不应发起下载'); },
    cancel: async () => true,
    getFreeDiskBytes: async () => 0,
  });
  await queue.hydrate();
  assert.equal(store.get(QUEUE_KEY), before, '读失败时绝不能把空队列写回存储');
  assert.deepEqual(queue.getSnapshot().tasks, [], '本次水合看不到任务（诚实降级）');
  // 读恢复后，下一次水合把任务原样读回：数据从未丢失
  failedGets.delete(QUEUE_KEY);
  const recovered = createDownloadQueue({
    load: () => storage.readDownloadQueueStatus(),
    persist: tasks => storage.writeDownloadQueue(tasks),
    download: async () => { throw new Error('不应发起下载'); },
    cancel: async () => true,
    getFreeDiskBytes: async () => 0,
  });
  await recovered.hydrate();
  assert.deepEqual(recovered.getSnapshot().tasks.map(task => task.id), ['a', 'b', 'c']);
});

// ---- B3：三态设置读（面板据此判断密钥是「未知」还是「确实为空」）----

test('B3：getLocalModelSettingsStatus 读失败时返回 corrupt 且 settings 为 null（不得退化成空密钥）', async () => {
  reset();
  store.set(SETTINGS_KEY, JSON.stringify({ schema: 2, apiServer: { apiKey: 'user-key' } }));
  const ok = await storage.getLocalModelSettingsStatus();
  assert.equal(ok.status, 'ok');
  assert.equal(ok.settings.apiServer.apiKey, 'user-key');
  // 读失败：getLocalModelSettings 会把失败吞成默认设置（apiKey:''），三态读必须区分出来
  failedGets.add(SETTINGS_KEY);
  const corrupt = await storage.getLocalModelSettingsStatus();
  assert.equal(corrupt.status, 'corrupt');
  assert.equal(corrupt.settings, null, '读失败不得给出「可以据此判空」的设置对象');
  failedGets.clear();
  assert.equal((await storage.getLocalModelSettings()).apiServer.apiKey, 'user-key', '原密钥没被任何读路径改写');
});


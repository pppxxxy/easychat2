import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

// 本文件覆盖本批第 1/2/3 项（settings/{thinking,sampling,memorySummary}、imageGen、onboarding）。
// 共同根因：`readJsonStatus` 名义三态，但 `ok` 只保证 JSON.parse 成功 —— 值可以是
// null / 原语 / 数组（**第四态：合法 JSON 但形状不是预期对象**），每个调用点都必须自己判形状。
// 测试口径：行为测试为主（真实调用存储层 + 真实 io.js 的 backupCorruptValue 路径），
// 断言「读失败/形状坏 → 已备份 + 不覆盖盘上原值」，并防过度修正（missing / 合法形状行为不变）。

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

const AsyncStorage = {
  getItem: async key => {
    getCalls.set(key, (getCalls.get(key) || 0) + 1);
    if (failedGets.has(key)) throw new Error(`read failed: ${key}`);
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

// storage.js 会 require 拆出的 src/storage/*.js；这些模块是 ESM，若走 require(esm)
// 其内部依赖会绕过 Module._load 打桩。这里按需把它们转成 CJS 再加载（同 proactiveSettings.test.mjs）。
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
  // 形态与 tests/characterCleanupDiagnostics.test.mjs 一致：`{ __esModule: true, default }`，
  // 因为 storage/diagnostics.js 是 `require('…').default` 取值的。
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
// 刻意**不还原** Module._load：diagnostics.js 用惰性 require 取 AsyncStorage（见其 :26-36），
// 还原之后那次 require 会去加载真实的 RN 包、取不到内存实现，诊断就「没有留下」——本批第 3 项
// 的断言正好要验这条路径。同型先例：tests/characterCleanupDiagnostics.test.mjs 也不还原。

const {
  getThinkingSettings,
  saveThinkingSettings,
  getSamplingSettings,
  saveSamplingSettings,
  getMemorySummarySettings,
  saveMemorySummarySettings,
  isDisclaimerAcknowledged,
  isOnboardingDone,
  acknowledgeDisclaimer,
  completeOnboarding,
} = runtimeModule.exports;

// 新导出（本批新增）不在 barrel 里 —— 从模块本身取（loadStorageModule 命中 Module._cache，
// 与 barrel 用的是同一个模块实例）。
const imageGen = loadStorageModule(path.resolve('src/storage/settings/imageGen.js'));
const { getDiagnostics, __resetDiagnosticsForTests } = loadStorageModule(path.resolve('src/storage/diagnostics.js'));
// memorySummary 的归一化函数（用于从生产同一条路径派生「首次使用」的默认值，
// 避免把默认值形状手抄成第二份真相 —— 见 SETTINGS_CASES 里 memorySummary 那条的注释）。
const { normalizeMemorySummary } = loadStorageModule(path.resolve('src/storage/settings/memorySummary.js'));

const THINKING_KEY = '@easychat2_thinking';
const SAMPLING_KEY = '@easychat2_sampling';
const MEMORY_SUMMARY_KEY = '@easychat2_memory_summary';
const IMAGE_GEN_KEY = '@easychat2_image_gen';
const DISCLAIMER_ACK_KEY = '@easychat2_disclaimer_ack';
const ONBOARDING_DONE_KEY = '@easychat2_onboarding_done';
const BACKUP = '__corrupt_backup';

// ⚠️ 两线合并（2026-10-12）修掉的**测试隔离缺陷**：
// recordDiagnostic 的写入是「入 mutationQueue → 异步落 AsyncStorage」，而旧 reset() 只**同步**
// 清内存与 store。于是前一个用例**排队中**的写入会在 reset() 之后才落进 store，
// 后一个用例于是读到别人的诊断（onboarding 两条因此误判「没留下诊断」：单独跑必过、全量跑必红）。
// ⇒ reset 改为 async：先让出若干 tick 把 mutationQueue 排空，**再**清内存与 store。
async function reset() {
  for (let i = 0; i < 8; i += 1) await new Promise(resolve => setImmediate(resolve));
  __resetDiagnosticsForTests();
  store.clear();
  failedGets.clear();
  getCalls.clear();
}

// 第四态的四个样本：合法 JSON，但都不是「普通对象」。
const FOURTH_STATE_SAMPLES = ['null', '[]', '"x"', '123'];

async function readDiagnostics() {
  // recordDiagnostic 内部不 await（调用点不该被诊断拖慢），它的写入走 mutationQueue
  // 异步落 AsyncStorage。⚠️ 两线合并（2026-10-12）暴露的**测试隔离缺陷**：
  // 前一个用例排在队列里的写入会在 reset() 之后才落进 store ⇒ 后一个用例读到别人的
  // 诊断（onboarding 两条因此误判「没留下诊断」；单独跑必过、全量跑必红）。
  // ⇒ ① 先给足 tick 让本用例的写入入队并落地；
  //    ② 再按**调用方给的判据**筛选，只认本用例关心的条目（不把别人的当自己的）。
  const wanted = arguments.length > 0 ? arguments[0] : null;
  // ① 让出三轮 setImmediate：足以让 mutationQueue 的 promise 链推进并完成落盘。
  for (let i = 0; i < 6; i += 1) await new Promise(resolve => setImmediate(resolve));
  const all = (await getDiagnostics()) || [];
  if (typeof wanted !== 'function') return all;
  // ② 若本用例的条目尚未落地，再轮询一小段时间（不无限等）。
  const deadline = Date.now() + 1000;
  let entries = all;
  while (Date.now() < deadline && !entries.some(wanted)) {
    await new Promise(resolve => setImmediate(resolve));
    entries = (await getDiagnostics()) || [];
  }
  return entries;
}

// ---- 第 1 项：thinking / sampling / memorySummary 三处同构的「读失败→默认→写回」 ----

const SETTINGS_CASES = [
  {
    name: 'thinking',
    key: THINKING_KEY,
    getter: getThinkingSettings,
    saver: saveThinkingSettings,
    payload: { enabled: true, level: 'high', display: 'open' },
    defaults: { enabled: false, level: 'medium', display: 'fold' },
  },
  {
    name: 'sampling',
    key: SAMPLING_KEY,
    getter: getSamplingSettings,
    saver: saveSamplingSettings,
    payload: { maxTokens: { enabled: true, value: 4096 } },
    defaults: {
      maxTokens: { enabled: false, value: 8024 },
      temperature: { enabled: false, value: 1 },
      topP: { enabled: false, value: 1 },
      topK: { enabled: false, value: 0 },
    },
    // sampling 的归一化会补齐其余字段（payload 只带一个字段）。
    normalized: {
      maxTokens: { enabled: true, value: 4096 },
      temperature: { enabled: false, value: 1 },
      topP: { enabled: false, value: 1 },
      topK: { enabled: false, value: 0 },
    },
  },
  {
    name: 'memorySummary',
    key: MEMORY_SUMMARY_KEY,
    getter: getMemorySummarySettings,
    saver: saveMemorySummarySettings,
    payload: { enabled: false, threshold: 10 },
    // ⚠️ 两线合并（2026-10-12）：默认值形状被 main 侧扩过（新增 configId / maxEntries /
    // historyRounds），写死字面量会随字段增加而失真。改为从归一化函数**派生**：
    // normalizeMemorySummary(null) 就是「首次使用」的权威默认值，且与生产走同一条路径
    // （不是手抄的第二份真相）。字段再增也不必修这里。
    defaults: normalizeMemorySummary(null),
  },
];

for (const item of SETTINGS_CASES) {
  test(`${item.name}：键结构损坏（坏 JSON）时 getter 抛错 + 已备份 + 保存拒绝覆盖`, async () => {
    await reset();
    const raw = '{ 不是 JSON';
    store.set(item.key, raw);
    await assert.rejects(item.getter(), /读取失败/, '读不出来必须抛错，不能回落默认值让界面显示「我没设过」');
    assert.equal(store.get(`${item.key}${BACKUP}`), raw, '原始字节必须先留副本');
    // 保存路径同样拒绝：否则「随手改一个字段」就整键覆盖损坏原值（不可逆、无备份）。
    await assert.rejects(item.saver(item.payload), /读取失败/, '写路径必须拒写');
    assert.equal(store.get(item.key), raw, '盘上原值不得被默认值覆盖');
  });

  test(`${item.name}：第四态（合法 JSON 但形状不是对象）同样归 corrupt + 已备份 + 保存拒写`, async () => {
    await reset();
    for (const sample of FOURTH_STATE_SAMPLES) {
      store.delete(`${item.key}${BACKUP}`);
      store.set(item.key, sample);
      await assert.rejects(item.getter(), /读取失败/, `形状坏（${sample}）不得被折叠成默认值`);
      assert.equal(store.get(`${item.key}${BACKUP}`), sample, `形状坏（${sample}）必须归 corrupt 并备份`);
      await assert.rejects(item.saver(item.payload), /读取失败/, `形状坏（${sample}）时写路径必须拒写`);
      assert.equal(store.get(item.key), sample, `形状坏（${sample}）时盘上原值不得被覆盖`);
    }
  });

  test(`${item.name}：getItem 抛错按 corrupt 处理（同样抛错 + 保存拒写）`, async () => {
    await reset();
    store.set(item.key, JSON.stringify(item.payload));
    failedGets.add(item.key);
    await assert.rejects(item.getter(), /读取失败/);
    await assert.rejects(item.saver(item.payload), /读取失败/);
    failedGets.delete(item.key);
    assert.equal(store.get(item.key), JSON.stringify(item.payload), '读失败期间一个字节都不该写');
  });

  test(`${item.name}：missing 仍回落默认值、合法形状行为不变（防过度修正）`, async () => {
    await reset();
    assert.deepEqual(await item.getter(), item.defaults, '键从未存在过 = 首次使用，照旧回落默认值');
    const saved = await item.saver(item.payload);
    // ⚠️ 两线合并（2026-10-12）：不能拿 payload 当 expected —— saver 会**归一化**
    //（补齐 main 侧新增的字段），所以「存进去的」未必逐字等于「传进来的」。
    // 权威期望值是 saver 的返回值本身；再断言「读回来」与它一致，才是在测往返一致性。
    assert.deepEqual(await item.getter(), saved, '合法形状读回必须与写入结果一致（往返一致）');
  });
}

// ---- 第 2 项：imageGen 的第四态漏判 + 写路径拒写 ----

test('imageGen：第四态归 corrupt + 已备份，且写路径拒绝覆盖（唯一漏网的读-改-写配置域）', async () => {
    await reset();
  for (const sample of FOURTH_STATE_SAMPLES) {
    store.delete(`${IMAGE_GEN_KEY}${BACKUP}`);
    store.set(IMAGE_GEN_KEY, sample);
    const status = await imageGen.getImageGenSettingsStatus();
    assert.equal(status.status, 'corrupt', `形状坏（${sample}）必须归 corrupt`);
    assert.equal(store.get(`${IMAGE_GEN_KEY}${BACKUP}`), sample, `形状坏（${sample}）必须备份原始值`);
    // 读路径对外体验保持原样（给 UI 一份默认值），但绝不意味着可以写回。
    const read = await imageGen.getImageGenSettings();
    assert.deepEqual(read, { activeProvider: '', providers: {} });
    await assert.rejects(
      imageGen.saveImageGenSettings({ activeProvider: 'volcengine', providers: { volcengine: { apiKey: 'k' } } }),
      /读取失败/,
      '写路径必须拒写：否则用户改一个字段就把整个 providers 清空且没有任何备份',
    );
    assert.equal(store.get(IMAGE_GEN_KEY), sample, `形状坏（${sample}）时盘上原值不得被覆盖`);
  }
});

test('imageGen：坏 JSON 仍走 corrupt（原有行为不回退）', async () => {
    await reset();
  store.set(IMAGE_GEN_KEY, '{ 不是 JSON');
  const status = await imageGen.getImageGenSettingsStatus();
  assert.equal(status.status, 'corrupt');
  assert.equal(store.get(`${IMAGE_GEN_KEY}${BACKUP}`), '{ 不是 JSON');
  await assert.rejects(imageGen.saveImageGenSettings({ activeProvider: '', providers: {} }), /读取失败/);
  assert.equal(store.get(IMAGE_GEN_KEY), '{ 不是 JSON');
});

test('imageGen：missing 回落默认值、合法形状读写行为不变（防过度修正）', async () => {
    await reset();
  const missing = await imageGen.getImageGenSettingsStatus();
  assert.equal(missing.status, 'missing');
  assert.deepEqual(missing.value, { activeProvider: '', providers: {} });
  assert.deepEqual(await imageGen.getImageGenSettings(), { activeProvider: '', providers: {} });
  const payload = { activeProvider: 'volcengine', providers: { volcengine: { baseUrl: 'https://x', apiKey: 'k' } } };
  const saved = await imageGen.saveImageGenSettings(payload);
  assert.equal(saved.activeProvider, 'volcengine');
  assert.equal(saved.providers.volcengine.baseUrl, 'https://x');
  assert.equal(saved.providers.volcengine.apiKey, 'k');
  const ok = await imageGen.getImageGenSettingsStatus();
  assert.equal(ok.status, 'ok', '合法形状必须判成 ok（防过度修正）');
  assert.equal(ok.value.activeProvider, 'volcengine');
  assert.equal(ok.value.providers.volcengine.baseUrl, 'https://x');
  assert.equal(ok.value.providers.volcengine.apiKey, 'k');
});

// ---- 第 3 项：onboarding 的裸 getItem 无 catch（遗漏族第三、四例） ----

test('onboarding：getItem 抛错时返回 false（不是 rejected promise）并留下诊断', async () => {
    await reset();
  failedGets.add(DISCLAIMER_ACK_KEY);
  const acknowledged = await isDisclaimerAcknowledged();
  assert.equal(acknowledged, false, '读不出对免责声明必须 fail-secure（按「未确认」处理），但不得 reject');
  // 按**本用例的判据**轮询等待，避免读到仍在前一条用例写入队列里的诊断（跨用例串味）。
  const hasDisclaimer = entry => `${entry.message} ${entry.context}`.includes('免责声明');
  const entries = await readDiagnostics(hasDisclaimer);
  assert.ok(
    entries.some(hasDisclaimer),
    `读失败必须留下诊断（区分「新用户」与「存储故障」），实际诊断：${JSON.stringify(entries)}`,
  );
});

test('onboarding：引导完成状态读失败同样返回 false 并留下诊断', async () => {
    await reset();
  failedGets.add(ONBOARDING_DONE_KEY);
  const done = await isOnboardingDone();
  assert.equal(done, false, '读不出按「未完成」处理，但不得 reject');
  const hasOnboarding = entry => `${entry.message} ${entry.context}`.includes('新手引导');
  const entries = await readDiagnostics(hasOnboarding);
  assert.ok(
    entries.some(hasOnboarding),
    `读失败必须留下诊断，实际诊断：${JSON.stringify(entries)}`,
  );
});

test('onboarding：正常路径读回裸字符串语义不变（防过度修正）', async () => {
    await reset();
  assert.equal(await isDisclaimerAcknowledged(), false, '键不存在 → 未确认');
  await acknowledgeDisclaimer();
  assert.equal(store.get(DISCLAIMER_ACK_KEY), '4', '这两个键存的是裸字符串，不是 JSON');
  assert.equal(await isDisclaimerAcknowledged(), true);
  store.set(DISCLAIMER_ACK_KEY, '3');
  assert.equal(await isDisclaimerAcknowledged(), false, '旧版本号不算已确认');
  assert.equal(await isOnboardingDone(), false, '键不存在 → 未完成');
  await completeOnboarding();
  assert.equal(store.get(ONBOARDING_DONE_KEY), 'true');
  assert.equal(await isOnboardingDone(), true);
});

test('onboarding：读取用的是裸 getItem（不能套 readJsonStatus，那会对裸字符串做 JSON.parse）', () => {
  const source = fs.readFileSync(path.resolve('src/storage/settings/onboarding.js'), 'utf8')
    // 剥注释：上面那段注释里就写着 readJsonStatus 这个反例名，不剥会假红（口径同 tts.test.mjs）。
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(line => !line.trim().startsWith('//'))
    .join('\n');
  assert.match(source, /recordDiagnostic\(/, '读失败必须留诊断');
  assert.equal(source.includes('readJsonStatus'), false, '裸字符串键不得套 readJsonStatus');
  assert.match(source, /catch \(error\) \{\s*recordDiagnostic\(/, '必须 try/catch 包住 getItem');
});

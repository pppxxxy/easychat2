// 图片识别（OCR）配置存储 + 识别结果缓存：行为测试。
//
// 用真实模块 + 仓库既有打桩范式（见 tests/screenWatch.test.mjs）：babel 转译源码、
// Module._load 注入假的 AsyncStorage 与 io.js，然后编译执行真实模块。断言打的是
// 真实导出函数的行为，不是源码字符串。
//
// 覆盖的关键判定（改回错写法就会变红）：
// - 归一化：越界值被夹紧、非法来源回落到 main、缺省字段有默认值；
// - 损坏存储：先备份原始值再回落默认（不能直接覆盖，否则用户填过的提示词丢了）；
// - 缓存键：内容 hash / 配置 / 模型 / 提示词 任一项变化都算另一条缓存；
// - 缓存裁剪：超上限时按最近使用保留（改错方向就会把新写的挤掉）；
// - 缓存是派生数据：写失败不抛错、读损坏不备份。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const presetEnv = require.resolve('@babel/preset-env');

const store = new Map();
const corruptBackups = [];
const AsyncStorage = {
  getItem: async key => (store.has(key) ? store.get(key) : null),
  setItem: async (key, value) => { store.set(key, value); },
  removeItem: async key => { store.delete(key); },
  getAllKeys: async () => [...store.keys()],
};
const ioStub = {
  readJsonStatus: async key => {
    try {
      const raw = await AsyncStorage.getItem(key);
      if (raw === null || raw === undefined) return { status: 'missing' };
      return { status: 'ok', value: JSON.parse(raw) };
    } catch (error) {
      return { status: 'corrupt' };
    }
  },
  setJson: async (key, value) => { await AsyncStorage.setItem(key, JSON.stringify(value)); },
  // 派生数据（缓存）走 setJsonRaw：明确不含密钥，不做保险箱遍历。
  setJsonRaw: async (key, value) => { await AsyncStorage.setItem(key, JSON.stringify(value)); },
  setJsonWithSecrets: async (key, value) => { await AsyncStorage.setItem(key, JSON.stringify(value)); },
  backupCorruptValue: async key => { corruptBackups.push(key); return true; },
};

const sourcePath = path.resolve('src/storage/settings/imageRecognition.js');
const transformed = babel.transformSync(fs.readFileSync(sourcePath, 'utf8'), {
  babelrc: false,
  configFile: false,
  filename: sourcePath,
  presets: [[presetEnv, { targets: { node: 'current' }, modules: 'commonjs' }]],
}).code;
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === '@react-native-async-storage/async-storage') return AsyncStorage;
  if (request.endsWith('/io.js')) return ioStub;
  return originalLoad.call(this, request, parent, isMain);
};
const runtime = new Module(sourcePath);
runtime.filename = sourcePath;
runtime.paths = Module._nodeModulePaths(path.dirname(sourcePath));
try {
  runtime._compile(transformed, sourcePath);
} finally {
  Module._load = originalLoad;
}
const mod = runtime.exports;

test('默认值：关闭、无配置、默认提示词非空、不附原图、看屏幕走主模型', () => {
  const defaults = mod.normalizeImageRecognitionSettings(null);
  assert.equal(defaults.enabled, false, '默认必须是关闭：不改变既有行为');
  assert.equal(defaults.apiConfigId, '');
  assert.equal(defaults.model, '');
  assert.ok(defaults.descriptionPrompt.length > 0, '默认描述提示词不能为空');
  assert.ok(defaults.descriptionPrompt.includes('不要推测'), '默认提示词必须约束不编造');
  assert.equal(defaults.maxOutputTokens, mod.DEFAULT_MAX_OUTPUT_TOKENS);
  assert.equal(defaults.timeoutSeconds, mod.DEFAULT_TIMEOUT_SECONDS);
  assert.equal(defaults.concurrency, mod.DEFAULT_CONCURRENCY);
  assert.equal(defaults.attachOriginal, false);
  assert.equal(defaults.screenWatchSource, 'main', '看屏幕默认走主模型（既有行为）');
});

test('归一化：越界数值夹紧、非法来源回落、字符串裁剪', () => {
  const normalized = mod.normalizeImageRecognitionSettings({
    enabled: 'yes',
    apiConfigId: 123,
    model: '  gpt-4o-mini  ',
    maxOutputTokens: 999999,
    timeoutSeconds: 1,
    concurrency: 99,
    attachOriginal: 1,
    screenWatchSource: 'nonsense',
  });
  assert.equal(normalized.enabled, false, '只有 === true 才算开启（字符串 "yes" 不算）');
  assert.equal(normalized.apiConfigId, '123');
  assert.equal(normalized.model, 'gpt-4o-mini', '模型名去空白');
  assert.equal(normalized.maxOutputTokens, mod.MAX_OUTPUT_TOKENS_LIMIT, '输出上限夹到上限');
  assert.equal(normalized.timeoutSeconds, mod.MIN_TIMEOUT_SECONDS, '超时夹到下限');
  assert.equal(normalized.concurrency, mod.MAX_CONCURRENCY, '并发夹到上限');
  assert.equal(normalized.attachOriginal, false, '非 true 一律按关闭');
  assert.equal(normalized.screenWatchSource, 'main', '非法来源回落 main');
});

test('归一化：合法来源保留（ocr 不被回落掉）', () => {
  assert.equal(mod.normalizeImageRecognitionSettings({ screenWatchSource: 'ocr' }).screenWatchSource, 'ocr');
  assert.equal(mod.normalizeImageRecognitionSettings({ concurrency: 3 }).concurrency, 3);
  assert.equal(mod.normalizeImageRecognitionSettings({ enabled: true }).enabled, true);
});

test('读写往返：保存后能原样读回（含提示词与看屏幕来源）', async () => {
  store.clear();
  corruptBackups.length = 0;
  const saved = await mod.saveImageRecognitionSettings({
    enabled: true,
    apiConfigId: 'cfg-a',
    model: 'qwen-vl-plus',
    descriptionPrompt: '自定义提示词：只抄可见文字。',
    maxOutputTokens: 256,
    timeoutSeconds: 45,
    concurrency: 1,
    attachOriginal: true,
    screenWatchSource: 'ocr',
  });
  const loaded = await mod.getImageRecognitionSettings();
  assert.deepEqual(loaded, saved);
  assert.equal(loaded.descriptionPrompt, '自定义提示词：只抄可见文字。');
  assert.equal(loaded.screenWatchSource, 'ocr');
  // 存储里只有配置 id，没有任何密钥字段（密钥纪律：不引入第二套密钥存储）。
  // 注意不要用 `apiKey` 裸子串匹配：本模块的字段名是 apiConfigId，不含 apiKey。
  const raw = store.get(mod.IMAGE_RECOGNITION_KEY);
  assert.equal(/"apiKey"|"secret"|"token"/i.test(raw), false, '配置里不得出现任何密钥字段');
});

test('损坏存储：先备份原始值再回落默认（不静默覆盖）', async () => {
  store.clear();
  corruptBackups.length = 0;
  store.set(mod.IMAGE_RECOGNITION_KEY, '{broken');
  const loaded = await mod.getImageRecognitionSettings();
  assert.equal(loaded.enabled, false);
  assert.ok(loaded.descriptionPrompt.length > 0);
  assert.deepEqual(corruptBackups, [mod.IMAGE_RECOGNITION_KEY], '损坏值必须先另存一份');
});

test('缓存键：四元组任一项变化都算另一条缓存', () => {
  const base = { contentHash: 'h1', configId: 'c1', model: 'm1', promptHash: 'p1' };
  const key = mod.imageRecognitionCacheKey(base);
  assert.ok(key);
  for (const field of ['contentHash', 'configId', 'model', 'promptHash']) {
    const other = { ...base, [field]: `${base[field]}-x` };
    assert.notEqual(mod.imageRecognitionCacheKey(other), key, `${field} 变化必须换键`);
  }
  assert.equal(mod.imageRecognitionCacheKey({ ...base }), key, '同输入同键');
  assert.equal(mod.imageRecognitionCacheKey({ ...base, contentHash: '' }), '', '无内容 hash 不给键');
});

test('缓存读写：命中返回描述，未命中返回空串', async () => {
  store.clear();
  const key = mod.imageRecognitionCacheKey({ contentHash: 'h', configId: 'c', model: 'm', promptHash: 'p' });
  assert.equal(await mod.readImageRecognitionCache(key), '', '未写入时为空');
  assert.equal(await mod.writeImageRecognitionCache(key, '  画面里有一张表格  '), true);
  assert.equal(await mod.readImageRecognitionCache(key), '画面里有一张表格', '命中并去空白');
  assert.equal(await mod.readImageRecognitionCache(''), '', '空键不查');
  assert.equal(await mod.writeImageRecognitionCache('', 'x'), false, '空键不写');
  assert.equal(await mod.writeImageRecognitionCache(key, '   '), false, '空描述不写');
});

test('缓存裁剪：超上限按最近使用保留（新写的不能被旧条目挤掉）', () => {
  const entries = {};
  for (let index = 0; index < 5; index += 1) {
    entries[`k${index}`] = { description: `d${index}`, at: index + 1 };
  }
  const pruned = mod.pruneImageRecognitionCache(entries, 3);
  assert.deepEqual(Object.keys(pruned).sort(), ['k2', 'k3', 'k4'], '保留 at 最大的三条');
  // 未超上限时原样保留
  const small = mod.pruneImageRecognitionCache({ a: { description: 'x', at: 1 } }, 10);
  assert.deepEqual(Object.keys(small), ['a']);
  // 空描述条目被丢弃（不是有效缓存）
  const withJunk = mod.pruneImageRecognitionCache({ a: { description: '', at: 1 }, b: { description: 'y', at: 2 } }, 10);
  assert.deepEqual(Object.keys(withJunk), ['b']);
});

test('缓存上限：写入超过 limit 条后只留最新的 limit 条', async () => {
  store.clear();
  // 每条之间等 5ms：裁剪按 at（毫秒）排序，同一毫秒内写入会让「谁更新」无法判定。
  for (let index = 0; index < 5; index += 1) {
    await mod.writeImageRecognitionCache(`key-${index}`, `desc-${index}`, { limit: 3 });
    await new Promise(resolve => { setTimeout(resolve, 5); });
  }
  const table = JSON.parse(store.get(mod.IMAGE_RECOGNITION_CACHE_KEY)).entries;
  assert.equal(Object.keys(table).length, 3, '只留 3 条');
  assert.ok(table['key-4'], '最新写入的必须留下');
  assert.equal(await mod.readImageRecognitionCache('key-0'), '', '最旧的已被裁掉');
});

test('清空缓存：清掉后读不到，且不影响配置键', async () => {
  store.clear();
  await mod.saveImageRecognitionSettings({ enabled: true, model: 'm' });
  const key = mod.imageRecognitionCacheKey({ contentHash: 'h', configId: 'c', model: 'm', promptHash: 'p' });
  await mod.writeImageRecognitionCache(key, '描述');
  await mod.clearImageRecognitionCache();
  assert.equal(await mod.readImageRecognitionCache(key), '');
  const settings = await mod.getImageRecognitionSettings();
  assert.equal(settings.enabled, true, '清缓存不得动配置');
  assert.equal(settings.model, 'm');
});

test('缓存损坏：按「没有缓存」处理且不备份（派生数据不值得留损坏副本）', async () => {
  store.clear();
  corruptBackups.length = 0;
  store.set(mod.IMAGE_RECOGNITION_CACHE_KEY, 'not json');
  const key = mod.imageRecognitionCacheKey({ contentHash: 'h', configId: 'c', model: 'm', promptHash: 'p' });
  assert.equal(await mod.readImageRecognitionCache(key), '');
  assert.deepEqual(corruptBackups, [], '缓存损坏不留备份');
  // 仍能正常写入
  assert.equal(await mod.writeImageRecognitionCache(key, '新描述'), true);
  assert.equal(await mod.readImageRecognitionCache(key), '新描述');
});

// 引擎测试里缓存是内存桩（真实模块经 storage/io.js 拉进 expo-file-system/legacy，
// 那条链在 Node 下由 ESM 加载器接管、Module._load 拦不住）。所以「引擎 + 真实缓存
// 存储」的接缝在这里补一条集成断言：缓存键由真实函数算出、写入真实模块、能读回。
test('集成接缝：真实缓存存储的键与读写在引擎使用方式下闭环', async () => {
  store.clear();
  const cacheKey = mod.imageRecognitionCacheKey({
    contentHash: 'hash-from-engine',
    configId: 'cfg-ocr',
    model: 'ocr-model',
    promptHash: 'prompt-hash',
  });
  assert.ok(cacheKey, '四元组齐全时必须给键');
  assert.equal(await mod.readImageRecognitionCache(cacheKey), '', '未写入时为空');
  await mod.writeImageRecognitionCache(cacheKey, '画面里有一张表格');
  assert.equal(await mod.readImageRecognitionCache(cacheKey), '画面里有一张表格');
  // 换个模型（引擎侧就是换 model 进四元组）：必须读不到旧结果
  const otherKey = mod.imageRecognitionCacheKey({
    contentHash: 'hash-from-engine',
    configId: 'cfg-ocr',
    model: 'other-model',
    promptHash: 'prompt-hash',
  });
  assert.notEqual(otherKey, cacheKey);
  assert.equal(await mod.readImageRecognitionCache(otherKey), '', '换模型不得复用旧结果');
});

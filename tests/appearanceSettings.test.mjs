// 外观设置（主题 / 字号 / 语言）共用一个存储键的读写与归一化。
//
// 回归重点：`@easychat2_appearance` 由三份设置共享，任何一个写入方若不带上
// 其余字段，normalizeAppearance 会把缺失项归一回默认值——表现为「改主题把语言
// 重置了」。这里锁定归一化的向后兼容与三字段共存。

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

const AsyncStorage = {
  getItem: async key => (store.has(key) ? store.get(key) : null),
  setItem: async (key, value) => { store.set(key, value); },
  removeItem: async key => { store.delete(key); },
  getAllKeys: async () => [...store.keys()],
};

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
  readJsonWithSecrets: async (key, fallback) => ioStub.readJson(key, fallback),
  setJsonWithSecrets: async (key, payload) => {
    await AsyncStorage.setItem(key, JSON.stringify(payload));
    return payload;
  },
  readJsonStatusWithSecrets: async key => ioStub.readJsonStatus(key),
  utf8ByteLength: text => Buffer.byteLength(String(text || ''), 'utf8'),
  createMutationQueue: () => {
    let single = Promise.resolve();
    const buckets = new Map();
    return {
      enqueue(task, key = '') {
        const bucket = String(key || '');
        const tail = bucket ? (buckets.get(bucket) || Promise.resolve()) : single;
        const next = tail.then(task, task);
        if (bucket) buckets.set(bucket, next.catch(() => {}));
        else single = next.catch(() => {});
        return next;
      },
      settle() {
        const tails = [single, ...buckets.values()];
        return Promise.all(tails.map(tail => tail.catch(() => {}))).then(() => undefined);
      },
    };
  },
  CORRUPT_BACKUP_SUFFIX: '__corrupt_backup',
  backupCorruptValue: async () => {},
  readLargeAsyncStorageValue: async () => null,
  getSqliteModule: () => null,
};

const sourcePath = path.resolve('src/storage/settings.js');
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
runtime._compile(transformed, sourcePath);
Module._load = originalLoad;

const settings = runtime.exports;
const APPEARANCE_KEY = '@easychat2_appearance';

test('外观归一化：旧数据缺 localeId 时补默认语言，不重置主题与字号', async () => {
  // 旧版本只写 themeId/fontScaleId，升级后读取必须原样保留这两项
  store.set(APPEARANCE_KEY, JSON.stringify({ themeId: 'blue', fontScaleId: 'large' }));
  const loaded = await settings.getAppearanceSettings();
  assert.equal(loaded.themeId, 'blue');
  assert.equal(loaded.fontScaleId, 'large');
  assert.equal(loaded.localeId, 'zh-CN', '缺 localeId 应补默认语言');
});

test('外观归一化：非法语言回退默认，合法语言原样保留', async () => {
  store.set(APPEARANCE_KEY, JSON.stringify({ themeId: 'dark', fontScaleId: 'default', localeId: 'en' }));
  assert.equal((await settings.getAppearanceSettings()).localeId, 'en');
  // 未登记的语言（如尚未支持的 ja）不得写进状态，避免界面拿到空词条表
  store.set(APPEARANCE_KEY, JSON.stringify({ themeId: 'dark', fontScaleId: 'default', localeId: 'ja' }));
  assert.equal((await settings.getAppearanceSettings()).localeId, 'zh-CN');
  store.set(APPEARANCE_KEY, JSON.stringify({ themeId: 'dark', fontScaleId: 'default', localeId: 42 }));
  assert.equal((await settings.getAppearanceSettings()).localeId, 'zh-CN');
});

test('外观三字段共存：语言写入后主题与字号不被抹掉', async () => {
  store.set(APPEARANCE_KEY, JSON.stringify({ themeId: 'pink', fontScaleId: 'xlarge', localeId: 'zh-CN' }));
  await settings.saveAppearanceSettings({ themeId: 'pink', fontScaleId: 'xlarge', localeId: 'en' });
  const raw = JSON.parse(store.get(APPEARANCE_KEY));
  assert.equal(raw.localeId, 'en');
  assert.equal(raw.themeId, 'pink');
  assert.equal(raw.fontScaleId, 'xlarge');
  // 再读回：三字段都还在
  const loaded = await settings.getAppearanceSettings();
  assert.deepEqual(loaded, { themeId: 'pink', fontScaleId: 'xlarge', localeId: 'en' });
});

test('外观键损坏或缺失时返回完整默认值（含语言）', async () => {
  store.delete(APPEARANCE_KEY);
  assert.deepEqual(await settings.getAppearanceSettings(), {
    themeId: 'dark', fontScaleId: 'default', localeId: 'zh-CN',
  });
  store.set(APPEARANCE_KEY, '{ not json');
  assert.deepEqual(await settings.getAppearanceSettings(), {
    themeId: 'dark', fontScaleId: 'default', localeId: 'zh-CN',
  });
  store.set(APPEARANCE_KEY, JSON.stringify([1, 2, 3]));
  assert.deepEqual(await settings.getAppearanceSettings(), {
    themeId: 'dark', fontScaleId: 'default', localeId: 'zh-CN',
  });
  store.clear();
});

test('LOCALE_IDS 与 i18n 模块的语言清单保持一致', async () => {
  const { LOCALE_IDS: storageIds } = settings;
  const i18n = await import('../src/i18n/index.js');
  assert.deepEqual([...storageIds].sort(), [...i18n.LOCALE_IDS].sort(),
    '存储层接受的语言必须与词条表支持的语言一致，否则能选中却无词条');
});

test('patchAppearanceSettings：改主题不重置语言，改语言不重置主题（核心回归）', async () => {
  store.clear();
  // 用户先设成英文 + 粉色主题
  await settings.patchAppearanceSettings({ themeId: 'pink', fontScaleId: 'large', localeId: 'en' });
  assert.deepEqual(await settings.getAppearanceSettings(),
    { themeId: 'pink', fontScaleId: 'large', localeId: 'en' });

  // ThemeContext 只提交主题字段——语言与字号必须原样保留
  const afterTheme = await settings.patchAppearanceSettings({ themeId: 'blue' });
  assert.equal(afterTheme.localeId, 'en', '改主题不得重置语言');
  assert.equal(afterTheme.fontScaleId, 'large', '改主题不得重置字号');

  // I18nContext 只提交语言字段——主题与字号必须原样保留
  const afterLocale = await settings.patchAppearanceSettings({ localeId: 'zh-CN' });
  assert.equal(afterLocale.themeId, 'blue', '改语言不得重置主题');
  assert.equal(afterLocale.fontScaleId, 'large', '改语言不得重置字号');

  // 对比：直接 saveAppearanceSettings 只带单字段就会重置其余项（这正是要避免的用法）
  const naive = await settings.saveAppearanceSettings({ themeId: 'dark' });
  assert.equal(naive.localeId, 'zh-CN', '整体写会回落默认语言（说明写入方必须用 patch）');
});

test('patchAppearanceSettings：无补丁 / 非法补丁不破坏现有值', async () => {
  store.clear();
  await settings.patchAppearanceSettings({ themeId: 'crimson', fontScaleId: 'small', localeId: 'en' });
  const noPatch = await settings.patchAppearanceSettings();
  assert.deepEqual(noPatch, { themeId: 'crimson', fontScaleId: 'small', localeId: 'en' });
  const badPatch = await settings.patchAppearanceSettings(null);
  assert.deepEqual(badPatch, { themeId: 'crimson', fontScaleId: 'small', localeId: 'en' });
  // 补丁里带非法值时该项归一，其余项不受影响
  const badValue = await settings.patchAppearanceSettings({ localeId: 'ja' });
  assert.equal(badValue.localeId, 'zh-CN', '非法语言归一为默认');
  assert.equal(badValue.themeId, 'crimson', '其余字段不受影响');
  store.clear();
});

test('音乐片段设置：默认 30 秒 / 16kHz，非法值归一，读写往返', async () => {
  store.delete('@easychat2_music_clip');
  assert.deepEqual(await settings.getMusicClipSettings(), { clipSeconds: 30, sampleRate: 16000 },
    '缺省 30 秒 / 16kHz');

  const saved = await settings.saveMusicClipSettings({ clipSeconds: 60, sampleRate: 44100 });
  assert.deepEqual(saved, { clipSeconds: 60, sampleRate: 44100 });
  assert.deepEqual(await settings.getMusicClipSettings(), { clipSeconds: 60, sampleRate: 44100 });

  // 非白名单值必须归一回默认，避免把任意数字当采样率传进 WebView
  const bad = await settings.saveMusicClipSettings({ clipSeconds: 45, sampleRate: 12345 });
  assert.deepEqual(bad, { clipSeconds: 30, sampleRate: 16000 }, '非法值归一为默认');

  store.set('@easychat2_music_clip', '{ not json');
  assert.deepEqual(await settings.getMusicClipSettings(), { clipSeconds: 30, sampleRate: 16000 },
    '损坏回退默认');
  store.delete('@easychat2_music_clip');
});

test('聊天选项 bubbleStyle：白名单归一，非法回退圆润', async () => {
  store.delete('@easychat2_chat_options');
  const def = await settings.getChatOptions();
  assert.equal(def.bubbleStyle, 'rounded', '缺省圆润');

  for (const style of ['rounded', 'card', 'plain']) {
    const saved = await settings.saveChatOptions({ ...def, bubbleStyle: style });
    assert.equal(saved.bubbleStyle, style, `合法值 ${style} 保留`);
  }
  const bad = await settings.saveChatOptions({ ...def, bubbleStyle: 'neon' });
  assert.equal(bad.bubbleStyle, 'rounded', '非法值归一为 rounded');

  // 写 bubbleStyle 不得抹掉其它聊天选项
  const next = await settings.saveChatOptions({ ...def, bubbleStyle: 'card', streaming: false, timeAware: true });
  assert.equal(next.streaming, false);
  assert.equal(next.timeAware, true);
  assert.equal(next.bubbleStyle, 'card');
  store.delete('@easychat2_chat_options');
});

test('折叠卡状态：只接受显式布尔，忽略未知/非法值，损坏回退空对象', async () => {
  store.delete('@easychat2_ui_sections');
  assert.deepEqual(await settings.getUiSections(), {}, '缺失时返回空对象');
  store.set('@easychat2_ui_sections', JSON.stringify({
    api: false,
    persona: true,
    bogus: true,
    workspace: 'yes',
  }));
  assert.deepEqual(await settings.getUiSections(), { api: false, persona: true });
  store.set('@easychat2_ui_sections', '{ not json');
  assert.deepEqual(await settings.getUiSections(), {}, '损坏时回退空对象');
  store.delete('@easychat2_ui_sections');
});

test('折叠卡状态：保存后读回一致，未知 id 不落库', async () => {
  store.clear();
  await settings.saveUiSections({ api: true, experience: false, nope: true });
  assert.deepEqual(JSON.parse(store.get('@easychat2_ui_sections')), { api: true, experience: false });
  assert.deepEqual(await settings.getUiSections(), { api: true, experience: false });
  assert.ok(settings.UI_SECTION_IDS.includes('experience'));
  assert.ok(settings.UI_SECTION_IDS.includes('extensions'));
  store.clear();
});

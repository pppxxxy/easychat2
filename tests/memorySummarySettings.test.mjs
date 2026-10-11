// 记忆总结设置（开关 / 自动触发阈值 / 记忆长度）的存储契约，以及发送前的历史窗口解析。
//
// 回归重点：这三个字段现在由两个互不知晓的界面编辑（设置页的角色预设面板编辑开关与
// 阈值，聊天页「总结」面板还编辑记忆长度）。任一写入方若整体写，缺失字段会被归一化
// 回默认值——表现为「在聊天页设好记忆长度，回设置页切一下开关就被重置成 30」。
// 这里锁定 patch 语义、记忆长度的归一化，以及「总结开启时不按记忆长度裁剪」的口径。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

import { translate } from '../src/i18n/index.js';

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

const SETTINGS_DIR = path.resolve('src/storage/settings');
const SETTINGS_BARREL = path.resolve('src/storage/settings.js');
const MEMORY_KEY = '@easychat2_memory_summary';

function compileToCjs(absPath) {
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
  // 写入 Module._cache：多个子模块 import 同一叶子时拿到同一实例（匹配真实 ESM 单例语义）。
  Module._cache[absPath] = mod;
  try {
    mod._compile(code, absPath);
  } catch (error) {
    delete Module._cache[absPath];
    throw error;
  }
  return mod.exports;
}

// historyWindow 用例要模拟「设置读失败」，用一个可切换的替身注入它的 '../storage/settings.js'。
let historySettingsOverride = null;
// 先声明后赋值：打桩函数里要引用它，避免编译 settings 期间命中 TDZ。
let settings = null;

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === '@react-native-async-storage/async-storage') return AsyncStorage;
  if (request.endsWith('/io.js')) return ioStub;
  const parentFile = (parent && parent.filename) || '';
  if (request.startsWith('.')) {
    const resolved = path.resolve(path.dirname(parentFile), request);
    // historyWindow.js 只认「读设置」这一个能力：按用例注入替身或真身。
    if (resolved === SETTINGS_BARREL && /historyWindow\.js$/.test(parentFile)) {
      return historySettingsOverride || settings;
    }
    if (resolved.startsWith(`${SETTINGS_DIR}${path.sep}`) && fs.existsSync(resolved)) {
      return compileToCjs(resolved);
    }
  }
  return originalLoad.call(this, request, parent, isMain);
};
settings = compileToCjs(SETTINGS_BARREL);
const historyWindow = compileToCjs(path.resolve('src/chat/historyWindow.js'));
Module._load = originalLoad;

const rounds = count => {
  const list = [];
  for (let i = 0; i < count; i += 1) {
    list.push({ id: `u${i}`, role: 'user' });
    list.push({ id: `a${i}`, role: 'assistant' });
  }
  return list;
};

test('记忆总结归一化：旧数据缺记忆长度时补默认 30，不重置开关与阈值', async () => {
  store.set(MEMORY_KEY, JSON.stringify({ enabled: false, threshold: 12 }));
  const loaded = await settings.getMemorySummarySettings();
  assert.deepEqual(loaded, { enabled: false, threshold: 12, configId: '', maxEntries: 100, historyRounds: 30 });
  assert.equal(settings.DEFAULT_MEMORY_LENGTH, 30, '默认记忆长度就是 30');
});

test('记忆总结归一化：非法/越界记忆长度回落到默认或上限', async () => {
  const cases = [
    [0, 30], [-5, 30], ['abc', 30], [null, 30], [7.9, 7], [99999, settings.MEMORY_LENGTH_MAX],
  ];
  for (const [raw, expected] of cases) {
    store.set(MEMORY_KEY, JSON.stringify({ enabled: true, threshold: 40, historyRounds: raw }));
    assert.equal((await settings.getMemorySummarySettings()).historyRounds, expected, `historyRounds=${String(raw)}`);
  }
  assert.equal(settings.MEMORY_LENGTH_MAX, 200, '上限防手输大数把整段历史塞进请求');
});

test('记忆长度整体写（save）：读回一致；损坏值回退默认', async () => {
  store.delete(MEMORY_KEY);
  assert.deepEqual(await settings.getMemorySummarySettings(), { enabled: true, threshold: 40, configId: '', maxEntries: 100, historyRounds: 30 });
  const saved = await settings.saveMemorySummarySettings({ enabled: false, threshold: 20, historyRounds: 12 });
  assert.deepEqual(saved, { enabled: false, threshold: 20, configId: '', maxEntries: 100, historyRounds: 12 });
  assert.deepEqual(JSON.parse(store.get(MEMORY_KEY)), { enabled: false, threshold: 20, configId: '', maxEntries: 100, historyRounds: 12 });
  store.set(MEMORY_KEY, '{ not json');
  assert.deepEqual(await settings.getMemorySummarySettings(), { enabled: true, threshold: 40, configId: '', maxEntries: 100, historyRounds: 30 });
  store.clear();
});

test('patch：设置页只提交开关与阈值时，聊天页设的记忆长度不被抹掉（核心回归）', async () => {
  store.clear();
  // 聊天页「总结」面板先把记忆长度改成 8
  await settings.patchMemorySummarySettings({ enabled: false, threshold: 40, historyRounds: 8 });
  assert.deepEqual(await settings.getMemorySummarySettings(), { enabled: false, threshold: 40, configId: '', maxEntries: 100, historyRounds: 8 });

  // 设置页的角色预设面板随后只提交它编辑的两个字段
  const afterToggle = await settings.patchMemorySummarySettings({ enabled: true, threshold: 25 });
  assert.equal(afterToggle.historyRounds, 8, '改开关不得重置记忆长度');
  assert.equal(afterToggle.threshold, 25);
  assert.equal(afterToggle.enabled, true);

  // 反向：聊天页只改记忆长度，开关与阈值原样保留
  const afterLength = await settings.patchMemorySummarySettings({ historyRounds: 3 });
  assert.equal(afterLength.enabled, true, '改记忆长度不得重置开关');
  assert.equal(afterLength.threshold, 25, '改记忆长度不得重置阈值');
  assert.equal(afterLength.historyRounds, 3);

  // 对比：整体写只带单字段就会回落默认（说明写入方必须走 patch）
  const naive = await settings.saveMemorySummarySettings({ enabled: false });
  assert.equal(naive.historyRounds, 30, '整体写回落默认记忆长度');
  store.clear();
});

test('patch：无补丁 / 非法补丁不破坏现有值，非法字段单独归一', async () => {
  store.clear();
  await settings.patchMemorySummarySettings({ enabled: false, threshold: 15, historyRounds: 9 });
  assert.deepEqual(await settings.patchMemorySummarySettings(), { enabled: false, threshold: 15, configId: '', maxEntries: 100, historyRounds: 9 });
  assert.deepEqual(await settings.patchMemorySummarySettings(null), { enabled: false, threshold: 15, configId: '', maxEntries: 100, historyRounds: 9 });
  const bad = await settings.patchMemorySummarySettings({ historyRounds: -1 });
  assert.equal(bad.historyRounds, 30, '非法值归一为默认');
  assert.equal(bad.threshold, 15, '其余字段不受影响');
  assert.equal(bad.enabled, false);
  store.clear();
});

test('resolveHistoryWindow：总结关闭时按记忆长度只留最近 N 轮', async () => {
  const history = rounds(5);
  store.set(MEMORY_KEY, JSON.stringify({ enabled: false, threshold: 40, historyRounds: 2 }));
  const planned = await historyWindow.resolveHistoryWindow({ historyMessages: history, boundary: null });
  assert.deepEqual(planned.trimmedHistory.map(item => item.id), ['u3', 'a3', 'u4', 'a4']);
  assert.equal(planned.appliedRounds, 2);
  store.clear();
});

test('resolveHistoryWindow：总结开启时保持原状（摘要 + 全部历史），记忆长度不生效', async () => {
  const history = rounds(5);
  store.set(MEMORY_KEY, JSON.stringify({ enabled: true, threshold: 40, historyRounds: 1 }));
  const planned = await historyWindow.resolveHistoryWindow({ historyMessages: history, boundary: null });
  assert.strictEqual(planned.trimmedHistory, history, '开启态整段保留');
  assert.equal(planned.appliedRounds, 0);
  // 有摘要边界时仍按边界裁剪（这条路径一个字都没改）
  const bounded = await historyWindow.resolveHistoryWindow({ historyMessages: history, boundary: 'u3' });
  assert.deepEqual(bounded.trimmedHistory.map(item => item.id), ['a3', 'u4', 'a4']);
  store.clear();
});

test('resolveHistoryWindow：设置读失败时按「总结开启」处理，绝不改变发送内容', async () => {
  const history = rounds(5);
  historySettingsOverride = {
    getMemorySummarySettings: async () => { throw new Error('storage down'); },
  };
  try {
    const planned = await historyWindow.resolveHistoryWindow({ historyMessages: history, boundary: null });
    assert.strictEqual(planned.trimmedHistory, history);
    assert.equal(planned.appliedRounds, 0);
  } finally {
    historySettingsOverride = null;
  }
});

// ---- 接线契约（源码锚点）：本仓 UI 无法在 Node 里渲染，按既有约定钉住关键调用 ----

const readSource = rel => fs.readFileSync(path.resolve(rel), 'utf8');

test('聊天页三点菜单的「总结」打开设置面板，而不是直接触发总结', () => {
  const chatScreen = readSource('src/ChatScreen.js');
  assert.ok(chatScreen.includes('const [summarySheetOpen, setSummarySheetOpen] = useState(false);'),
    '面板可见性由 ChatScreen 持有');
  const summaryItem = chatScreen.slice(chatScreen.indexOf("key: 'summary'"), chatScreen.indexOf("key: 'scrubber'"));
  assert.ok(summaryItem.includes('onPress: () => setSummarySheetOpen(true)'), '「总结」条目改为打开面板');
  assert.ok(!summaryItem.includes('onPress: onSummarize'), '不再直接总结：面板里还有设置可改');
  assert.ok(chatScreen.includes('<MemorySummarySheet'), '渲染面板');
  assert.ok(chatScreen.includes('onSummarize={onSummarize}'), '面板复用既有的手动总结回调');
  assert.ok(chatScreen.includes('summarizing={summarizing}'), '总结中要禁用面板里的开始按钮');
});

test('面板：开关 + 阈值 + 记忆长度（仅关闭态可见），写入走 patch', () => {
  const sheet = readSource('src/chat/MemorySummarySheet.js');
  assert.ok(sheet.includes('getMemorySummarySettings()'), '打开时读现值');
  assert.ok(sheet.includes('patchMemorySummarySettings({'), '写入走局部更新，避免抹掉设置页编辑的字段');
  assert.ok(sheet.includes("t('preset.memory.thresholdLabel')"), '自动触发阈值沿用同一份设置与文案');
  assert.ok(sheet.includes("t('chat.summary.settings.lengthLabel')"), '记忆长度有独立标签');
  // 开启态隐藏记忆长度输入框，只留说明（改了也不生效，不能让人以为有用）
  assert.ok(/\{enabled \? \(\s*<Text style=\{styles\.chatSettingsHint\}>\{t\('chat\.summary\.settings\.lengthDisabled'\)\}/.test(sheet));
  assert.ok(sheet.includes("t('chat.summary.confirm.action')"), '面板里也能顺手总结一次');
  assert.ok(sheet.includes('MEMORY_LENGTH_MAX'), '上限与存储层同源');
});

test('发送链路：历史窗口只在一个地方解析，且带上了记忆长度口径', () => {
  const send = readSource('src/chat/useChatSend.js');
  assert.ok(send.includes('await resolveHistoryWindow({ historyMessages, boundary })'), '单一裁剪入口');
  assert.ok(!send.includes('trimHistoryByBoundary('), '不再直接调用边界裁剪（改由 planHistoryWindow 串起来）');
  const historyWindowSource = readSource('src/chat/historyWindow.js');
  assert.ok(historyWindowSource.includes('planHistoryWindow'), '异步模块只负责读设置，裁剪口径在纯函数里');
  assert.ok(historyWindowSource.includes('catch (error)'), '读失败要有兜底分支');
});

test('设置页的角色预设面板改用 patch（否则会抹掉聊天页设的记忆长度）', () => {
  const preset = readSource('src/PresetPanel.js');
  assert.ok(preset.includes('patchMemorySummarySettings({'), '改用局部更新');
  assert.ok(!preset.includes('saveMemorySummarySettings('), '不再整体写');
});

test('「更多」菜单的「其他」分组外提后条目不变', async () => {
  const { buildMoreMenuSystemItems } = await import('../src/chat/moreMenuItems.js');
  const items = buildMoreMenuSystemItems({
    t: key => key,
    characterId: 'c1',
    openSessionStats: () => {},
    setMemoryProvenanceOpen: () => {},
    setNoticeOpen: () => {},
    setHubOpen: () => {},
    setChatSettingsOpen: () => {},
  });
  assert.deepEqual(items.map(item => item.key), ['memory-provenance', 'session-stats', 'notice', 'local-logs', 'settings']);
  assert.deepEqual([...new Set(items.map(item => item.section))], ['chat.menu.section.other']);
  assert.deepEqual(items.map(item => item.icon),
    ['git-network-outline', 'stats-chart-outline', 'megaphone-outline', 'document-text-outline', 'settings-outline']);
  assert.equal(items[0].disabled, false, '有角色时记忆溯源可用');
  assert.equal(buildMoreMenuSystemItems({ t: key => key, characterId: '' })[0].disabled, true,
    '没有角色时记忆溯源不可用');
  assert.ok(readSource('src/ChatScreen.js').includes('...buildMoreMenuSystemItems({'), 'ChatScreen 仍在拼接这组条目');
});

test('面板新增文案在两种语言里都有（缺 key 会渲染成 key 本身）', () => {
  const keys = [
    'chat.summary.settings.title',
    'chat.summary.settings.lengthLabel',
    'chat.summary.settings.lengthHint',
    'chat.summary.settings.lengthDisabled',
    'chat.summary.settings.lengthInvalid.title',
    'chat.summary.settings.lengthInvalid.body',
  ];
  for (const locale of ['zh-CN', 'en']) {
    for (const key of keys) {
      assert.notEqual(translate(locale, key), key, `${locale} 缺 ${key}`);
    }
  }
  assert.equal(translate('zh-CN', 'chat.summary.settings.lengthHint', { rounds: 30 }).includes('30'), true,
    '记忆长度提示要带上当前轮数');
});

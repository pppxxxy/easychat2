import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

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
const AsyncStorage = {
  getItem: async key => (store.has(key) ? store.get(key) : null),
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
// 其内部依赖会绕过 Module._load 打桩。这里按需把它们转成 CJS 再加载。
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
  // 写入 Module._cache，让多个子模块 import 同一 sessionCore 时拿到同一实例
  // （匹配真实 ESM 单例语义，避免模块级共享状态被复制成多份）。
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
  if (request === '@react-native-async-storage/async-storage') return AsyncStorage;
  if (request === 'expo-file-system' || request === 'expo-file-system/legacy') return FileSystem;
  if (request === 'expo-sqlite') return SQLite;
  if (request.endsWith('/presets.js') || request.endsWith('/presets')) {
    return { __esModule: true, default: [] };
  }
  if (request.endsWith('/imageGen/providers') || request === './imageGen/providers.js') {
    return { __esModule: true, isKnownImageProvider: () => true };
  }
  if (request.endsWith('/cardForge/forge') || request === './cardForge/forge.js') {
    return {
      __esModule: true,
      FORGE_FIELDS: ['description'],
      FORGE_QUESTIONS: [],
      MAX_PRESERVED_TEXT: 500000,
      MAX_PRESERVED_ITEMS: 2000,
    };
  }
  if (request.endsWith('/moments/moments') || request === './moments/moments.js') {
    return { __esModule: true, removeMomentsBySessionIds: async () => {} };
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
Module._load = originalLoad;

const {
  getProactiveSettings,
  saveProactiveSettings,
  bindProactiveSlotSession,
  makeProactiveSlotId,
  PROACTIVE_MODES,
  getPersonas,
  createPersona,
  deletePersona,
  setActivePersonaId,
  getActivePersonaId,
  saveUserProfile,
  getApiConfigs,
  saveApiConfigs,
} = runtimeModule.exports;

const KEY = '@easychat2_proactive_settings';

test.beforeEach(() => store.clear());

test('同一角色可保存多个时间槽', async () => {
  const saved = await saveProactiveSettings({
    apiConfigId: 'cfg-1',
    model: 'model-a',
    slots: [
      { slotId: 's1', roleId: 'role-a', hour: 8, minute: 0, mode: 'WORK' },
      { slotId: 's2', roleId: 'role-a', hour: 21, minute: 30, mode: 'EXACT' },
    ],
  });
  assert.equal(saved.slots.length, 2);
  assert.deepEqual(saved.slots.map(item => item.hour), [8, 21]);
  const loaded = await getProactiveSettings();
  assert.equal(loaded.slots.length, 2);
  assert.equal(loaded.apiConfigId, 'cfg-1');
  assert.equal(loaded.model, 'model-a');
  assert.equal(loaded.slots[1].mode, 'EXACT');
});

test('缺失字段回退默认值且非法值被纠正', async () => {
  const saved = await saveProactiveSettings({
    slots: [
      { roleId: 'role-a', hour: 99, minute: -3, mode: 'NOPE' },
      { roleId: '', hour: 9, minute: 10 },
    ],
  });
  // roleId 为空的槽被丢弃
  assert.equal(saved.slots.length, 1);
  const slot = saved.slots[0];
  assert.equal(slot.hour, 8);
  assert.equal(slot.minute, 0);
  assert.ok(PROACTIVE_MODES.includes(slot.mode));
  assert.equal(slot.mode, 'WORK');
  assert.equal(slot.enabled, true);
});

test('slotId 缺省时稳定派生，显式值被保留', async () => {
  const saved = await saveProactiveSettings({
    slots: [
      { roleId: 'role-a', hour: 7, minute: 5 },
      { slotId: 'keep-me', roleId: 'role-b', hour: 7, minute: 6 },
    ],
  });
  assert.equal(saved.slots[0].slotId, 'slot-0-role-a-7-5');
  assert.equal(saved.slots[1].slotId, 'keep-me');
});

test('损坏数据先备份再返回空设置，不静默覆盖', async () => {
  store.set(KEY, '{not-json');
  const loaded = await getProactiveSettings();
  assert.deepEqual(loaded.slots, []);
  assert.equal(store.get(`${KEY}__corrupt_backup`), '{not-json');
  // 备份存在时原值未被默认值覆盖
  assert.equal(store.get(KEY), '{not-json');
});

test('makeProactiveSlotId 生成的 id 唯一', () => {
  assert.notEqual(makeProactiveSlotId(), makeProactiveSlotId());
});

test('互动面板：折叠选择 API/模型/角色 + 权限状态勾叉问号', () => {
  const panel = fs.readFileSync(path.resolve('src/ProactivePanel.js'), 'utf8');
  // 折叠选择器，避免一次性罗列大量 API/模型/角色
  assert.ok(panel.includes('CollapsibleSelect'));
  assert.ok(panel.includes('消息来源（API）'));
  assert.ok(panel.includes('具体模型'));
  assert.ok(panel.includes('选择角色'));
  // 权限状态：勾/叉/问号三态
  assert.ok(panel.includes('getPermissionStatus'));
  assert.ok(panel.includes("'checkmark-circle'"));
  assert.ok(panel.includes("'close-circle'"));
  assert.ok(panel.includes("'help-circle'"));
  assert.ok(panel.includes('permissionRow'));
});

test('消息类型：槽可保存 messageType 与 customPrompt，非法值回退默认', async () => {
  const saved = await saveProactiveSettings({
    slots: [
      { roleId: 'role-a', hour: 8, minute: 0, messageType: 'CARE' },
      { roleId: 'role-b', hour: 9, minute: 0, messageType: 'CUSTOM', customPrompt: '问我吃了吗' },
      { roleId: 'role-c', hour: 10, minute: 0, messageType: 'BOGUS' },
    ],
  });
  assert.equal(saved.slots[0].messageType, 'CARE');
  assert.equal(saved.slots[1].messageType, 'CUSTOM');
  assert.equal(saved.slots[1].customPrompt, '问我吃了吗');
  // 非法类型回退默认，避免原生 MessageType.valueOf 抛错
  assert.equal(saved.slots[2].messageType, 'DEFAULT');
  const loaded = await getProactiveSettings();
  assert.equal(loaded.slots[1].messageType, 'CUSTOM');
});

test('互动面板：提供默认/关心心情/问好/自定义四种消息类型与自定义输入框', () => {
  const panel = fs.readFileSync(path.resolve('src/ProactivePanel.js'), 'utf8');
  assert.ok(panel.includes('MESSAGE_TYPE_OPTIONS'));
  for (const label of ['默认', '关心心情', '问好', '自定义']) {
    assert.ok(panel.includes(label), `缺少消息类型选项 ${label}`);
  }
  // 选「自定义」时才出现提示词输入框
  assert.ok(panel.includes("slot.messageType === 'CUSTOM'"));
  assert.ok(panel.includes('customPrompt'));
});

test('主动消息落库：存储导出 appendProactiveMessage，桥接消费并 ack', () => {
  assert.equal(typeof runtimeModule.exports.appendProactiveMessage, 'function');
  const app = fs.readFileSync(path.resolve('App.js'), 'utf8');
  assert.ok(app.includes('consumePendingMessages'));
  assert.ok(app.includes('ingestProactiveMessages'));
  assert.ok(app.includes('ackPendingMessages'));
  // 跳转前先落库，保证点通知进入即可见
  const bridge = app.match(/function ProactiveMessageBridge[\s\S]*?\n}\n/)[0];
  const ingestIndex = bridge.indexOf('await ingestPending()');
  const switchIndex = bridge.indexOf('await switchCharacter(roleId)');
  assert.ok(ingestIndex > 0 && switchIndex > 0, '缺少落库或切换调用');
  assert.ok(ingestIndex < switchIndex, '必须先落库再切换角色');
});

test('找不到角色的待写消息不 ack 删除，改为保留重试', () => {
  const app = fs.readFileSync(path.resolve('App.js'), 'utf8');
  const ctx = fs.readFileSync(path.resolve('src/context/AppContext.js'), 'utf8');
  // ingest 返回 deferred 名单
  assert.ok(ctx.includes('deferred'), 'AppContext 应返回 deferred');
  // 角色不在库时进 deferred（而非 skipped）
  const roleMissing = ctx.match(/角色当前不在库[\s\S]{0,120}/);
  assert.ok(roleMissing, '未找到角色缺失分支');
  assert.ok(roleMissing[0].includes('deferred.push'), '角色缺失应保留重试');
  // App.js 只 ack written + skipped，不含 deferred
  const bridge = app.match(/function ProactiveMessageBridge[\s\S]*?\n}\n/)[0];
  assert.ok(!/acked\s*=\s*\[[^\]]*deferred/.test(bridge), 'deferred 不得被 ack');
  assert.match(bridge, /const acked = \[\.\.\.written, \.\.\.skipped\]/);
});

test('通知跳转精确切到消息实际落到的会话', () => {
  const ctx = fs.readFileSync(path.resolve('src/context/AppContext.js'), 'utf8');
  const app = fs.readFileSync(path.resolve('App.js'), 'utf8');
  // 落库结果带 roleId → sessionId 映射
  assert.ok(ctx.includes('targetSessions'), '落库应返回 targetSessions');
  assert.match(ctx, /targetSessions\[roleId\] = result\.sessionId/);
  // 桥接用该 sessionId 切会话，而非只 switchCharacter
  const bridge = app.match(/function ProactiveMessageBridge[\s\S]*?\n}\n/)[0];
  assert.ok(bridge.includes('switchSession'), '应切到具体会话');
  assert.match(bridge, /targetSessions\[roleId\]/);
  const switchCharIndex = bridge.indexOf('await switchCharacter(roleId)');
  const switchSessIndex = bridge.indexOf('switchSession(targetSessionId)');
  assert.ok(switchCharIndex > 0 && switchSessIndex > 0);
  assert.ok(switchCharIndex < switchSessIndex, '先切角色再切会话');
});

test('回前台补消费：AppState 变 active 时消费待写队列', () => {
  const app = fs.readFileSync(path.resolve('App.js'), 'utf8');
  const bridge = app.match(/function ProactiveMessageBridge[\s\S]*?\n}\n/)[0];
  // 到点时 App 可能只是切到后台（进程未死），这条路径此前无消费入口
  assert.ok(bridge.includes('AppState'), '应监听 AppState');
  assert.ok(bridge.includes("addEventListener('change'"), '应监听前后台切换');
  assert.match(bridge, /cameToForeground/, '应判定为回到前台才消费');
  assert.match(bridge, /cameToForeground\)\s*ingestPending\(\)\.catch/, '回到前台消费一次');
});

test('启动消费结果直接交给 openRole，避免同批消息重复消费', () => {
  const app = fs.readFileSync(path.resolve('App.js'), 'utf8');
  const bridge = app.match(/function ProactiveMessageBridge[\s\S]*?\n}\n/)[0];
  // 启动一轮消费后把 targetSessions 传给 openRole，openRole 不再二次 ingest
  assert.match(bridge, /openRole = useCallback\(async \(roleId, ingestResult = null\)/);
  assert.match(bridge, /const \{ targetSessions \} = ingestResult \|\| await ingestPending\(\)/);
  assert.match(bridge, /await openRole\(roleId, ingestResult\)/);
});

test('事件路径拿不到 targetSessions 时回退缓存映射，且并发消费合并为一次', () => {
  const app = fs.readFileSync(path.resolve('App.js'), 'utf8');
  const bridge = app.match(/function ProactiveMessageBridge[\s\S]*?\n}\n/)[0];
  // 冷启动：启动 effect 先消费并 ack 清队列，事件路径再消费只能拿到空；
  // 必须缓存 roleId→sessionId 供其复用，否则只切角色、停在默认会话看不到新消息。
  assert.ok(bridge.includes('targetSessionRef'), '应有落库会话缓存');
  assert.match(bridge, /targetSessionRef\.current\[roleId\]/, '应回退到缓存映射');
  // 启动 effect 与 onOpenRole 事件会并发消费同一队列：共享 in-flight Promise
  assert.ok(bridge.includes('ingestInFlightRef'), '应有并发互斥');
  assert.match(bridge, /if \(ingestInFlightRef\.current\) return ingestInFlightRef\.current/);
});

test('落库结果写入诊断日志（release 可见，免 adb）', () => {
  const app = fs.readFileSync(path.resolve('App.js'), 'utf8');
  const bridge = app.match(/function ProactiveMessageBridge[\s\S]*?\n}\n/)[0];
  assert.ok(bridge.includes('recordDiagnostic'), '应记录诊断');
  assert.ok(bridge.includes('主动消息消费'), '应含可读的结果说明');
});

test('互动面板：有主动消息的角色带星标，并说明横幅通知设置', () => {
  const panel = fs.readFileSync(path.resolve('src/ProactivePanel.js'), 'utf8');
  // 星标：存在时间槽的角色在选项 label 前加 ★
  assert.ok(panel.includes("slots.some(slot => slot.roleId === item.id) ? '★ '"));
  assert.ok(panel.includes('表示该角色已设置主动消息'));
  // 横幅通知说明
  assert.ok(panel.includes('横幅通知'));
  assert.ok(panel.includes('静默通知'));
});

test('衔接对话：槽可保存 sessionTargetId，非法/缺失回退空串', async () => {
  const saved = await saveProactiveSettings({
    slots: [
      { roleId: 'role-a', hour: 8, minute: 0, sessionTargetId: 'sess-1' },
      { roleId: 'role-b', hour: 9, minute: 0 },
    ],
  });
  assert.equal(saved.slots[0].sessionTargetId, 'sess-1');
  assert.equal(saved.slots[1].sessionTargetId, '', '缺省应为空串（新建对话）');
});

test('bindProactiveSlotSession：仅更新指定槽的绑定，保留其它编辑', async () => {
  await saveProactiveSettings({
    slots: [
      { slotId: 's1', roleId: 'role-a', hour: 8, minute: 0 },
      { slotId: 's2', roleId: 'role-a', hour: 9, minute: 0, sessionTargetId: 'keep' },
    ],
  });
  const ok = await bindProactiveSlotSession('s1', 'new-session');
  assert.equal(ok, true);
  const loaded = await getProactiveSettings();
  assert.equal(loaded.slots.find(item => item.slotId === 's1').sessionTargetId, 'new-session');
  assert.equal(loaded.slots.find(item => item.slotId === 's2').sessionTargetId, 'keep');
  // 未命中的槽返回 false，不误报
  assert.equal(await bindProactiveSlotSession('nope', 'x'), false);
  // 空参数直接拒绝
  assert.equal(await bindProactiveSlotSession('', 'x'), false);
  assert.equal(await bindProactiveSlotSession('s1', ''), false);
});

test('互动面板：每个槽可选择衔接的历史对话或新建对话', () => {
  const panel = fs.readFileSync(path.resolve('src/ProactivePanel.js'), 'utf8');
  assert.ok(panel.includes("label: '新建对话'"));
  assert.ok(panel.includes('sessionTargetId'));
  assert.ok(panel.includes('sessionOptions'));
  // 候选只取该角色的单聊会话
  assert.match(panel, /item\.type !== 'group' && item\.characterId === activeRoleId/);
});

test('互动面板：时间槽不自动按时间排序，改为按钮显式触发', () => {
  const panel = fs.readFileSync(path.resolve('src/ProactivePanel.js'), 'utf8');
  // roleSlots 只过滤、不再 sort：编辑时间时不会立即跳位
  const roleSlotsBlock = panel.match(
    /const roleSlots = useMemo\([\s\S]*?\[slots, activeRoleId\]\s*\)/
  );
  assert.ok(roleSlotsBlock, '未找到 roleSlots 定义');
  assert.equal(roleSlotsBlock[0].includes('.sort('), false, 'roleSlots 不应再自动 sort');
  assert.match(roleSlotsBlock[0], /slots\.filter\(item => item\.roleId === activeRoleId\)/);
  // 提供显式的排序按钮与处理函数
  assert.ok(panel.includes('sortSlotsByTime'));
  assert.ok(panel.includes('按时间排序'));
});
const PERSONAS_KEY = '@easychat2_personas';
const ACTIVE_PERSONA_KEY = '@easychat2_active_persona';

test('人设：并发创建不会丢写（读-改-写入同一队列）', async () => {
  await getPersonas(); // 触发迁移：建立默认人设
  await Promise.all([createPersona({ userName: '甲' }), createPersona({ userName: '乙' })]);
  const list = await getPersonas();
  assert.equal(list.length, 3);
  assert.deepEqual(
    list.map(item => item.userName).sort(),
    ['', '乙', '甲'],
  );
  // 落盘与内存一致
  const stored = JSON.parse(store.get(PERSONAS_KEY));
  assert.equal(stored.length, 3);
});

test('人设：切换活跃人设后持久化，且非法 id 回退到首个人设', async () => {
  const list = await getPersonas();
  const target = list[0].id;
  assert.equal(await setActivePersonaId(target), target);
  assert.equal(await getActivePersonaId(list), target);
  // 非法 id 回退首个
  assert.equal(await setActivePersonaId('nope'), list[0].id);
  assert.equal(store.get(ACTIVE_PERSONA_KEY), JSON.stringify(list[0].id));
});

test('人设：并发创建与保存资料互不覆盖', async () => {
  const before = await getPersonas();
  await Promise.all([
    createPersona({ userName: '新人' }),
    saveUserProfile({ userName: '我', persona: '设定', avatarUri: 'file://a.png' }),
  ]);
  const after = await getPersonas();
  // 新创建的人设不丢（并发 RMW 未互相覆盖）
  assert.equal(after.length, before.length + 1);
  // 资料写在「当时的活跃人设」上；createPersona 会把新人设设为活跃，
  // 因此资料落到活跃人设（可能是新建那条），但仍要有且仅有一条带设定的记录。
  const configured = after.filter(item => item.persona === '设定' && item.userName === '我');
  assert.equal(configured.length, 1);
  const activeId = await getActivePersonaId(after);
  assert.equal(configured[0].id, activeId);
});

test('人设：删除走队列且保留至少一个', async () => {
  const list = await getPersonas();
  // 至少保留一个：只剩默认时删除报错
  await assert.rejects(deletePersona(list[0].id), /至少保留一个人设/);
  const extra = await createPersona({ userName: '多余' });
  const result = await deletePersona(extra.id);
  assert.equal(result.personas.length, 1);
  assert.equal(result.personas.some(item => item.id === extra.id), false);
  // 非末位时删不存在的人设才会命中「人设不存在」
  await createPersona({ userName: '再来一个' });
  await assert.rejects(deletePersona('missing-id'), /人设不存在/);
});

const API_CONFIGS_KEY = '@easychat2_api_configs';

test('API 配置：并发保存被队列串行化，最后一次写入为准', async () => {
  const first = await saveApiConfigs(
    [{ id: 'a', name: 'A', baseUrl: 'https://a/v1', model: 'ma', apiKey: 'k1' }],
    'a',
  );
  assert.equal(first.configs.length, 1);
  // 两次并发保存：若不串行，可能出现交错的半写状态
  await Promise.all([
    saveApiConfigs([{ id: 'b', name: 'B', baseUrl: 'https://b/v1', model: 'mb', apiKey: 'k2' }], 'b'),
    saveApiConfigs([{ id: 'c', name: 'C', baseUrl: 'https://c/v1', model: 'mc', apiKey: 'k3' }], 'c'),
  ]);
  const loaded = await getApiConfigs();
  // 落盘结果必须是两次完整写入之一（不存在混合/半写）
  assert.equal(loaded.configs.length, 1);
  assert.ok(['b', 'c'].includes(loaded.configs[0].id));
  assert.equal(loaded.activeId, loaded.configs[0].id);
  // 存储中的 payload 形状完整
  const stored = JSON.parse(store.get(API_CONFIGS_KEY));
  assert.equal(stored.configs.length, 1);
  assert.ok(['b', 'c'].includes(stored.configs[0].id));
});

test('API 配置：保存后读回 activeId 回退到首条（非法 id）', async () => {
  const saved = await saveApiConfigs(
    [
      { id: 'x', name: 'X', baseUrl: 'https://x/v1', model: 'mx', apiKey: 'kx' },
      { id: 'y', name: 'Y', baseUrl: 'https://y/v1', model: 'my', apiKey: 'ky' },
    ],
    'missing',
  );
  assert.equal(saved.activeId, 'x');
  const loaded = await getApiConfigs();
  assert.equal(loaded.activeId, 'x');
  assert.deepEqual(loaded.configs.map(item => item.id), ['x', 'y']);
});

test('API 配置：空列表保存回退默认配置', async () => {
  const saved = await saveApiConfigs([], '');
  assert.equal(saved.configs.length, 1);
  assert.equal(saved.configs[0].id, 'default');
  assert.equal(saved.activeId, 'default');
});

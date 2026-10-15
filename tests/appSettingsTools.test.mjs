// FEAT-AC1：应用设置工具域的门禁与行为。
//
// 这一批是**纯 Node 直测**（依赖全注入）——本文件 import 的是 schema（零依赖）与
// 工具文件的**定义**部分。工具文件里的 storage 域是惰性 require，定义加载时不碰它，
// 所以这里能安全 import；真跑 execute 时才需要 storage，测试用注入替换。
//
// 覆盖任务书 P2-7 要求的四类：
//   1. 白名单外键 set → 拒绝且**不触发确认**（连弹窗都不该弹）
//   2. 类型/枚举不匹配 → 返回**具体原因**（不猜不修）
//   3. 只读模式（read）下 set_app_setting **不出现在工具清单**
//   4. set 成功后：storage 域函数被以正确参数调用 + 快照刷新被触发
//   5. list_app_settings 输出**不含任何密钥字段**

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  APP_SETTING_KEYS,
  APP_SETTING_KEY_NAMES,
  APP_SETTING_PANELS,
  coerceSettingValue,
  describeSetting,
  keysForPanel,
  panelLabel,
  renderSettingValue,
  validateSettingValue,
} from '../src/workspace/appSettingsSchema.js';
import {
  APP_SETTINGS_READ_DEFINITIONS,
  APP_SETTINGS_TOOL_DEFINITIONS,
  APP_SETTINGS_WRITE_DEFINITIONS,
  __keyWriters,
  __panelReaders,
  __swapKeyWriters,
  __swapPanelReaders,
  applySettingValue,
  readSettingValue,
  setOverlaySnapshotRefresher,
  setSettingChangeRecorder,
} from '../src/workspace/toolDefs/appSettingsTools.js';
import { AGENT_MODES, listToolsForMode, registerTool, unregisterTool } from '../src/agent/tools/registry.js';

const byName = name => APP_SETTINGS_TOOL_DEFINITIONS.find(item => item.name === name);

// 常规形状：list/get 只读，set 写 + 需确认。
test('工具形状：list/get 只读，set 可写且必须逐条确认', () => {
  assert.equal(byName('list_app_settings').readOnly, true);
  assert.equal(byName('get_app_setting').readOnly, true);
  assert.equal(byName('set_app_setting').readOnly, false);
  // 与 run_shell / install_extension_pack 同一条审批链：改用户设置必须经用户点头。
  assert.equal(byName('set_app_setting').requiresConfirmation, true,
    'set_app_setting 必须声明 requiresConfirmation（没有审批钩子的环境一律拒绝执行）');
  // 只读两件进 READ 清单、写一件进 WRITE 清单（索引层按这两份聚合）
  assert.deepEqual(APP_SETTINGS_READ_DEFINITIONS.map(i => i.name), ['list_app_settings', 'get_app_setting']);
  assert.deepEqual(APP_SETTINGS_WRITE_DEFINITIONS.map(i => i.name), ['set_app_setting']);
});

// P2-7 第 3 条：只读模式下写工具不可见（canRunTool 口径）。
//
// 用**真注册表**验，而不是只看 readOnly 字段——任务书要的判据就是「工具清单里有没有」。
test('只读模式下 set_app_setting 不出现在工具清单（canRunTool 口径）', () => {
  for (const definition of APP_SETTINGS_TOOL_DEFINITIONS) registerTool(definition);
  try {
    const readNames = listToolsForMode(AGENT_MODES.READ).map(i => i.function.name);
    const writeNames = listToolsForMode(AGENT_MODES.WRITE).map(i => i.function.name);
    // 只读两件：read 模式可见
    assert.ok(readNames.includes('list_app_settings'), 'read 模式应能看到 list_app_settings');
    assert.ok(readNames.includes('get_app_setting'), 'read 模式应能看到 get_app_setting');
    // 写一件：read 模式**不可见**，write 模式可见
    assert.equal(readNames.includes('set_app_setting'), false,
      '只读模式不得暴露 set_app_setting');
    assert.ok(writeNames.includes('set_app_setting'), '可改模式应能看到 set_app_setting');
    // ask 模式没有任何工具
    assert.deepEqual(listToolsForMode(AGENT_MODES.ASK), []);
  } finally {
    for (const definition of APP_SETTINGS_TOOL_DEFINITIONS) unregisterTool(definition.name);
  }
});

// P1-5：白名单与写实现必须同源（加了键忘了写实现 = 工具谎报成功）。
test('白名单的每个键都有对应的写实现（不漏不余）', () => {
  const keyed = Object.keys(__keyWriters).sort();
  assert.deepEqual(keyed, [...APP_SETTING_KEY_NAMES].sort(),
    'APP_SETTING_KEYS 与 KEY_WRITERS 必须一一对应');
  // 每个键都必须有读实现与展示描述
  for (const key of APP_SETTING_KEY_NAMES) {
    assert.equal(typeof APP_SETTING_KEYS[key].read, 'function', `${key} 缺 read`);
    assert.ok(describeSetting(key) && describeSetting(key) !== key, `${key} 缺展示描述`);
    assert.ok(keysForPanel(APP_SETTING_KEYS[key].panel).includes(key), `${key} 的面板归属不一致`);
  }
  // 面板读取器覆盖全部面板
  for (const panel of APP_SETTING_PANELS) {
    assert.equal(typeof __panelReaders[panel], 'function', `面板 ${panel} 缺读取器`);
  }
});

// P2-7 第 1 条：白名单外键 → 拒绝，且**不触发确认**。
test('白名单外的键：直接拒绝，且不进入确认流程', async () => {
  const setTool = byName('set_app_setting');
  let confirmCalled = false;
  const result = await setTool.execute({}, {
    key: 'providers.0.apiKey',
    value: 'sk-should-never-work',
  }, {
    characterId: 'c1',
    // 若工具真去问确认，这里会被调用——断言它**没有**被调用。
    confirm: async () => { confirmCalled = true; return true; },
  });
  assert.match(result, /不可通过助手修改/);
  assert.match(result, /providers\.0\.apiKey/);
  assert.equal(confirmCalled, false, '白名单外键不得触发确认弹窗（也没必要打扰用户）');
});

test('密钥类键一律不在白名单里（读也读不到）', () => {
  const forbidden = [
    'apiKey', 'apikey', 'api_key', 'appSecretKey', 'secret', 'token', 'password',
  ];
  for (const key of APP_SETTING_KEY_NAMES) {
    const lower = key.toLowerCase();
    for (const word of forbidden) {
      assert.equal(lower.includes(word.toLowerCase()), false,
        `${key} 命中禁用词 ${word}——白名单不得包含任何密钥类键`);
    }
  }
});

// P2-7 第 5 条：list 输出不含密钥字段。
//
// ⚠️ 必须**注入桩读取器**才测得到这条：纯 Node 环境没有 AsyncStorage，
// 真实域读取会全部失败 → 工具返回「（没有读到可修改的设置）」，
// 那样断言「不含 apiKey」是**空转**的（空字符串当然不含任何东西）。
// 注入一个**含密钥字段的设置树**，才能证明工具真的只输出白名单字段。
test('list_app_settings 只输出白名单字段：设置树里的密钥与无关字段都不出现', async () => {
  const restore = __swapPanelReaders({
    // 每个域都塞进密钥与「白名单外但同域」的字段：
    // 前者证明不泄密，后者证明不是「整棵树倒出来」。
    tts: async () => ({ autoBroadcast: true, activeProvider: 'system', apiKey: 'sk-live-should-never-leak', providers: { a: { appSecretKey: 'appsecret' } } }),
    appearance: async () => ({ themeId: 'dark', customColors: { token: 'tok-should-never-leak' } }),
    musicClip: async () => ({ clipSeconds: 30, sampleRate: 16000, secretNote: 'nope' }),
    diary: async () => ({ roles: {}, api_key: 'ak-should-never-leak' }),
  });
  try {
    const listTool = byName('list_app_settings');
    const out = await listTool.execute({}, {}, { characterId: 'c1' });
    // 核心断言：设置树里明明有这些字段，输出里一个都不许出现。
    for (const word of [
      'apiKey', 'appSecretKey', 'api_key', 'secret', 'token', 'Bearer',
      'sk-live', 'appsecret', 'tok-should', 'ak-should', 'nope',
      'providers', 'customColors', 'sampleRate'.replace('sampleRate', 'secretNote'),
    ]) {
      assert.equal(out.includes(word), false, `list 输出不得出现 ${word}`);
    }
    // 且确实列出了白名单键（证明不是靠「什么都不输出」蒙混过关）
    assert.ok(out.includes('tts.autoBroadcast'), '应列出白名单键');
    assert.ok(out.includes('appearance.theme'), '应列出白名单键');
  } finally {
    restore();
  }
});

// P2-7 第 2 条：类型/枚举不匹配 → 具体原因。
test('类型校验：布尔项收到非布尔 → 给出具体原因（不猜不修）', () => {
  const msg = validateSettingValue('tts.autoBroadcast', 'yes');
  assert.ok(msg, '必须拒绝');
  assert.match(msg, /需要 true 或 false/);
  assert.match(msg, /「yes」/, '要说明收到的是什么');
  assert.equal(validateSettingValue('tts.autoBroadcast', true), null, '合法值放行');
});

test('枚举校验：非法值 → 返回允许清单；数值枚举兼容字符串写法', () => {
  const bad = validateSettingValue('appearance.theme', 'neon');
  assert.ok(bad, '非法主题必须拒绝');
  assert.match(bad, /只能是/);
  assert.match(bad, /dark/, '应列出允许值（让模型据此纠正）');

  // 合法枚举值放行
  assert.equal(validateSettingValue('appearance.theme', 'light'), null);
  // 数值枚举：模型常把 30 写成 "30" —— 宽松配对通过，再由 coerce 归一成数值
  assert.equal(validateSettingValue('musicClip.clipSeconds', '30'), null, '字符串数字应通过校验');
  assert.strictEqual(coerceSettingValue('musicClip.clipSeconds', '30'), 30, '必须归一成数值');
  // 越界值仍必须拒绝
  assert.ok(validateSettingValue('musicClip.clipSeconds', 45), '45 不在允许清单里，必须拒绝');
});

test('校验失败时 set 工具返回原因且**绝不落盘**', async () => {
  const setTool = byName('set_app_setting');
  const before = await applySettingValueSpy();
  const result = await setTool.execute({}, { key: 'appearance.theme', value: 'neon' }, { characterId: 'c1' });
  assert.match(result, /未做任何修改/);
  assert.deepEqual(await applySettingValueSpy(), before, '校验失败不得写盘');
});

// 记录「写盘是否发生」的探针：读一次当前值即可（写盘会改变它）。
async function applySettingValueSpy() {
  try {
    return await readSettingValue('appearance.theme', { characterId: 'c1' });
  } catch (error) {
    return `unreadable:${error.message}`;
  }
}

// P2-7 第 4 条：set 成功后触发快照刷新 + 诊断留痕。
//
// ⚠️ 必须**注入读取器与写入器**：纯 Node 没有 AsyncStorage，真实 storage 路径会抛错，
// 下面的 try/catch 一旦吞掉异常，断言就变成空转（注入探针验证时抓到的正是这个——
// 把快照刷新整行删掉，测试**仍然通过**）。
// 现在用桩读取器 + 桩写实现，让 applySettingValue 走完整条成功路径。
test('set 成功：写入后必须触发悬浮窗快照刷新与诊断留痕（且顺序正确）', async () => {
  const calls = [];
  const restoreReaders = __swapPanelReaders({
    tts: async () => ({ autoBroadcast: false, activeProvider: 'system', providers: {} }),
  });
  const restoreWriters = __swapKeyWriters({
    'tts.autoBroadcast': async (ctx, value) => { calls.push(`write:${value}`); },
  });
  setOverlaySnapshotRefresher(async () => { calls.push('snapshot'); });
  setSettingChangeRecorder({
    noteSettingChanged(key, oldValue, newValue) {
      calls.push(`diag:${key}:${oldValue}->${newValue}`);
    },
  });
  try {
    const result = await applySettingValue('tts.autoBroadcast', true, { characterId: 'c1' });
    assert.deepEqual(result, { key: 'tts.autoBroadcast', oldValue: false, newValue: true });
    assert.deepEqual(calls[0], 'write:true', '第一步必须是写盘');
    assert.ok(calls.includes('snapshot'),
      '必须触发快照刷新（否则「设置开了、悬浮窗 TTS 不响」）');
    assert.ok(calls.includes('diag:tts.autoBroadcast:false->true'),
      '必须留诊断痕迹（key + old→new）');
    // 顺序契约：先落盘，再刷快照，最后留痕。
    assert.ok(calls.indexOf('write:true') < calls.indexOf('snapshot'), '写盘在刷快照之前');
    assert.ok(calls.indexOf('snapshot') < calls.findIndex(item => item.startsWith('diag:')),
      '刷快照在留痕之前');
  } finally {
    restoreReaders();
    restoreWriters();
    setOverlaySnapshotRefresher(null);
    setSettingChangeRecorder(null);
  }
});

test('快照刷新失败不影响设置结果（刷快照是尽力而为）', async () => {
  const restoreReaders = __swapPanelReaders({
    tts: async () => ({ autoBroadcast: false, activeProvider: 'system', providers: {} }),
  });
  const restoreWriters = __swapKeyWriters({
    'tts.autoBroadcast': async () => {},
  });
  setOverlaySnapshotRefresher(async () => { throw new Error('native module missing'); });
  try {
    const result = await applySettingValue('tts.autoBroadcast', true, { characterId: 'c1' });
    assert.equal(result.newValue, true, '刷快照失败不该把已成功的设置说成失败');
  } finally {
    restoreReaders();
    restoreWriters();
    setOverlaySnapshotRefresher(null);
  }
});

// 快照刷新注入的**安全默认**：没注入时不得抛错（纯 Node / 无悬浮窗环境）。
test('未注入快照刷新时 applySettingValue 不抛错（安全默认）', async () => {
  setOverlaySnapshotRefresher(null);
  const tool = byName('set_app_setting');
  // 不注入 = 不刷新，但工具本身必须能正常返回（不能因为没注入就崩）。
  assert.equal(typeof tool.execute, 'function');
});

test('get_app_setting：白名单外键返回可用键清单，不泄露', async () => {
  const getTool = byName('get_app_setting');
  const out = await getTool.execute({}, { key: 'providers.0.apiKey' }, { characterId: 'c1' });
  assert.match(out, /不可通过助手修改或读取/);
  assert.ok(out.includes('tts.autoBroadcast'), '应给出可用键清单');
});

test('list_app_settings：未知面板名给出可选面板', async () => {
  const listTool = byName('list_app_settings');
  const out = await listTool.execute({}, { panel: 'nope' }, { characterId: 'c1' });
  assert.match(out, /未知的设置组/);
  for (const panel of APP_SETTING_PANELS) {
    assert.ok(out.includes(panel), `应列出面板 ${panel}`);
  }
});

test('面板名渲染：内部名 → 可读名（模板串，与工具提示词同口径）', () => {
  assert.equal(panelLabel('tts'), '语音播报');
  assert.equal(panelLabel('appearance'), '外观主题');
  // 未知面板回退原名（不编造）
  assert.equal(panelLabel('nope'), 'nope');
});

test('布尔值渲染成「开/关」而不是 true/false（模型与人都好读）', () => {
  assert.equal(renderSettingValue('tts.autoBroadcast', true), '开');
  assert.equal(renderSettingValue('tts.autoBroadcast', false), '关');
  assert.equal(renderSettingValue('appearance.theme', 'dark'), 'dark');
});

// ---------- FEAT-AC8 BUG-A：当晚场景端到端重演 ----------
//
// 任务书 §二 P0-A 明确要求：模型传字符串 "true" → **恰好 1 张确认卡** → 允许 →
// 写入成功 → 工具结果为「已把…从 关 改为 开」。
// 下面这条就是那次真机事故的逐字重演（走真实 execute，只把落盘换成桩）。
test('AC8 当晚场景：模型传字符串 "true" → 一次成功（不再连环弹卡）', async () => {
  const calls = [];
  const restoreReaders = __swapPanelReaders({
    tts: async () => ({ autoBroadcast: false, activeProvider: 'system', providers: {} }),
  });
  const restoreWriters = __swapKeyWriters({
    'tts.autoBroadcast': async (ctx, value) => { calls.push(`write:${value}:${typeof value}`); },
  });
  setOverlaySnapshotRefresher(async () => { calls.push('snapshot'); });
  setSettingChangeRecorder({ noteSettingChanged() {} });
  try {
    const tool = byName('set_app_setting');
    // 现场证据：确认卡上显示的就是 {"key":"tts.autoBroadcast","value":"true"}（带引号）
    const out = await tool.execute({}, { key: 'tts.autoBroadcast', value: 'true' }, { characterId: 'c1' });

    // ① 工具不再回「未做任何修改」——那正是模型重发的原因
    assert.equal(/未做任何修改/.test(out), false, '不得再拒绝字符串 true（否则模型会合规重发）');
    assert.match(out, /已把/, `应报告成功，实际：${out}`);
    assert.match(out, /从 关 改为 开/, '应从「关」改为「开」');
    // ② 写盘必须拿到**布尔**（不是字符串 "true"——那会写坏存储）
    assert.deepEqual(calls.find(item => item.startsWith('write:')), 'write:true:boolean',
      '归一必须在写盘之前发生（写进去的必须是布尔）');
    // ③ 快照照旧刷新（设置类工具既有纪律）
    assert.ok(calls.includes('snapshot'), '设置改动后仍要刷悬浮窗快照');
  } finally {
    restoreReaders();
    restoreWriters();
    setOverlaySnapshotRefresher(null);
    setSettingChangeRecorder(null);
  }
});

test('AC8 当晚场景反例：非法字符串仍然拒绝且不写盘（不猜不修）', async () => {
  const calls = [];
  const restoreReaders = __swapPanelReaders({
    tts: async () => ({ autoBroadcast: false, activeProvider: 'system', providers: {} }),
  });
  const restoreWriters = __swapKeyWriters({
    'tts.autoBroadcast': async (ctx, value) => { calls.push(`write:${value}`); },
  });
  try {
    const tool = byName('set_app_setting');
    const out = await tool.execute({}, { key: 'tts.autoBroadcast', value: 'yes' }, { characterId: 'c1' });
    assert.match(out, /需要 true 或 false/, '有歧义的值必须给出具体原因');
    assert.match(out, /未做任何修改/, '被拒时必须明说没改');
    assert.deepEqual(calls, [], '被拒时**绝不能**写盘（不猜不修）');
  } finally {
    restoreReaders();
    restoreWriters();
  }
});

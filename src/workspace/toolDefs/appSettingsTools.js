// FEAT-AC1：应用设置工具域（list / get / set + 强制确认）——**脏层**。
//
// 用户诉求：悬浮窗里说「帮我打开语音播报」，助手应该真的去开，而不是回答
// 「语音播报在 设置→功能扩展 里，你自己去开」。
//
// 为什么需要这个域：工作区 agent 原有的工具**全部是文件沙盒域**（列/读/搜/写/改文件、
// 符号、引用、跑命令、git、构建、docx、子代理、workflow、扩展包）——这是有意的安全
// 边界。而 APP 设置存在 app 自己的存储域（AsyncStorage 的 @easychat2_* 键），
// 没有任何工具碰得到它。所以助手说「你去设置里自己打开」是**沙盒边界内的如实相告**，
// 不是模型笨、也不是设计要推倒——缺的就是这一个域。
//
// 文件分工（重要）：
//  · appSettingsSchema.js —— 白名单、类型校验、归一、文案渲染（**纯**，Node 直测）
//  · 本文件             —— 读盘 / 落盘 / 工具定义（**脏**，import storage 域）
// 之所以拆：storage 域依赖 expo-file-system，在 Node 里 import 不了；合在一起会让
// 白名单与校验这类真正有风险的判定全部无法单测（M2.5 / FIX-7 都是这一个原因）。
//
// 设计纪律（三条，都有本仓先例）：
//  1. **单一事实源**：白名单只有 schema 里一张表；本文件的读写实现按**同名键**注册，
//     单测断言「每个键都有读写实现」（防止加了键忘了实现）。
//  2. **不直写存储**：写入一律走各域既有 save/patch 函数。各域 normalizer 存在的
//     理由就是防脏数据；绕过它直接写 AsyncStorage 会把脏数据种进去。
//  3. **密钥不可达**：providers.*.apiKey / appSecretKey 这类字段一律不进白名单，
//     读也不读（它们本就落盘为安全存储引用）。

import {
  APP_SETTING_KEYS,
  APP_SETTING_KEY_NAMES,
  APP_SETTING_PANELS,
  DIARY_DEFAULT_ROLE,
  coerceSettingValue,
  describeSetting,
  keysForPanel,
  panelLabel,
  renderSettingValue,
  validateSettingValue,
} from '../appSettingsSchema.js';

// ⚠️ storage 域用 **require 惰性加载**，不用静态 import。
//
// 为什么（这是本仓既有约束，先例见 toolDefs/importTool.js:42）：
// 这些域最终依赖 `expo-file-system/legacy`（storage/io.js），在 Node 里
// import 不了。而本工具文件的定义要经 tools.js（索引层）聚合——**14 个测试
// import 那个索引层**，一旦这里静态 import，整批测试会以
// ERR_MODULE_NOT_FOUND 直接崩（我刚写静态 import 时就是这么断的）。
// 惰性 require 让「读工具定义」不需要真的加载 storage；只有真执行工具时才碰它。
let storageModules = null;
function storage() {
  if (!storageModules) {
    storageModules = {
      tts: require('../../storage/settings/tts.js'),
      chatOptions: require('../../storage/settings/chatOptions.js'),
      diary: require('../../storage/diary.js'),
    };
  }
  return storageModules;
}

// 面板 → 该域的读取函数。**每个面板只读一次**（list 用），避免逐键重复读盘。
const PANEL_READERS = {
  tts: () => storage().tts.getTtsSettings(),
  appearance: () => storage().chatOptions.getAppearanceSettings(),
  musicClip: () => storage().chatOptions.getMusicClipSettings(),
  diary: () => storage().diary.getDiarySettings(),
};

// 键 → 写实现。键名与 schema 一一对应（单测钉住「不漏不余」）。
const KEY_WRITERS = {
  'tts.autoBroadcast': async (ctx, value, current) => {
    await storage().tts.saveTtsSettings({ ...current, autoBroadcast: value });
  },
  'tts.activeProvider': async (ctx, value, current) => {
    await storage().tts.saveTtsSettings({ ...current, activeProvider: value });
  },
  'appearance.theme': async (ctx, value) => {
    await storage().chatOptions.patchAppearanceSettings({ themeId: value });
  },
  'musicClip.clipSeconds': async (ctx, value, current) => {
    await storage().chatOptions.saveMusicClipSettings({ ...current, clipSeconds: value });
  },
  'musicClip.sampleRate': async (ctx, value, current) => {
    await storage().chatOptions.saveMusicClipSettings({ ...current, sampleRate: value });
  },
  'diary.enabled': async (ctx, value, current) => {
    const roles = { ...((current && current.roles) || {}) };
    const id = (ctx && ctx.characterId) || DIARY_DEFAULT_ROLE;
    roles[id] = { ...(roles[id] || {}), enabled: value };
    await storage().diary.saveDiarySettings({ ...current, roles });
  },
};

// 测试可见：供单测断言「白名单的每个键都有写实现」。
export const __keyWriters = KEY_WRITERS;
export const __panelReaders = PANEL_READERS;

/**
 * 临时替换面板读取器（**仅测试用**）。
 *
 * 为什么需要：纯 Node 环境没有 AsyncStorage，真实读取会全部失败，工具就返回
 * 「（没有读到可修改的设置）」——那样做「输出不含密钥」的断言是**空转**的
 * （空字符串当然不含任何东西）。注入一个**含密钥的恶意设置树**，才能证明
 * 工具真的只输出白名单字段。返回一个还原函数。
 */
export function __swapPanelReaders(overrides) {
  const backup = {};
  for (const [panel, reader] of Object.entries(overrides || {})) {
    if (!(panel in PANEL_READERS)) continue;
    backup[panel] = PANEL_READERS[panel];
    PANEL_READERS[panel] = reader;
  }
  return () => {
    for (const [panel, reader] of Object.entries(backup)) PANEL_READERS[panel] = reader;
  };
}

/**
 * 临时替换键的写实现（**仅测试用**）。与 __swapPanelReaders 同理：
 * 纯 Node 没有 AsyncStorage，真实写实现会抛错，于是「写成功之后的编排」
 *（刷快照 / 留痕）根本走不到，断言会空转。返回还原函数。
 */
export function __swapKeyWriters(overrides) {
  const backup = {};
  for (const [key, writer] of Object.entries(overrides || {})) {
    if (!(key in KEY_WRITERS)) continue;
    backup[key] = KEY_WRITERS[key];
    KEY_WRITERS[key] = writer;
  }
  return () => {
    for (const [key, writer] of Object.entries(backup)) KEY_WRITERS[key] = writer;
  };
}

// 诊断留痕的**注入点**：诊断模块依赖 AsyncStorage，纯 Node 单测不该被拖进来。
// 缺省无操作；宿主（工作区面板）注入真实实现；测试注入桩以断言被调用。
let settingChangeRecorder = { noteSettingChanged() {} };

/** 替换诊断留痕实现（宿主 / 测试注入）。 */
export function setSettingChangeRecorder(recorder) {
  settingChangeRecorder = recorder || { noteSettingChanged() {} };
}

// FEAT-AC1 P0-3 第 2 条：**悬浮窗配置快照刷新**的注入点。
//
// 为什么必须刷：悬浮窗原生大脑的 TTS 开关来自配置快照（overlayConfig.js 读
// tts.autoBroadcast 生成 → writeOverlayConfig）。agent 改了设置却不刷快照，
// 就会出现「设置里开了、悬浮窗 TTS 不响」的经典脱节。
//
// 为什么用注入而不是在这里直接 import overlayConfig.js：那条静态链会拖进
// react-native / expo-file-system，纯 Node 单测就崩了（与本文件 storage 域同一原因）。
// 宿主（工作区面板 / 聊天页装配处）注入真实实现。
let overlaySnapshotRefresher = null;

/** 注入快照刷新实现（宿主）。传 null 恢复为「不刷新」（Node 单测的缺省）。 */
export function setOverlaySnapshotRefresher(refresher) {
  overlaySnapshotRefresher = typeof refresher === 'function' ? refresher : null;
}


/**
 * 读取全部（或某面板的）设置值。
 *
 * 域读取失败**不拖垮整体**：那一个面板跳过，其余照常——读数只是给模型看，
 * 不该因为某个域损坏就让整个工具失败。
 */
export async function readAllSettings({ panel = '', ctx = {} } = {}) {
  const wanted = panel && PANEL_READERS[panel] ? [panel] : APP_SETTING_PANELS;
  const values = {};
  for (const name of wanted) {
    let settings = null;
    try {
      settings = await PANEL_READERS[name]();
    } catch (error) {
      continue;
    }
    for (const key of keysForPanel(name)) {
      try {
        values[key] = APP_SETTING_KEYS[key].read(settings, ctx);
      } catch (error) {
        // 单键取值失败（域结构损坏）不拖垮其余键。
      }
    }
  }
  return values;
}

/** 单个键的当前值（读盘）。抛错 = 该域不可读（调用方给如实提示）。 */
export async function readSettingValue(key, ctx = {}) {
  const spec = APP_SETTING_KEYS[key];
  if (!spec) return undefined;
  const settings = await PANEL_READERS[spec.panel]();
  return spec.read(settings, ctx);
}

/**
 * 改一个键。**前置校验由调用方（工具）完成**；这里只负责读旧值 + 落盘 + 留痕 + 刷快照。
 * 返回 { key, oldValue, newValue }（供工具渲染结果与弹窗复用）。
 */
export async function applySettingValue(key, newValue, ctx = {}) {
  const spec = APP_SETTING_KEYS[key];
  if (!spec) throw new Error(`该键不可通过助手修改：${key}`);
  const writer = KEY_WRITERS[key];
  if (!writer) throw new Error(`设置 ${key} 还没有实现写入（白名单与写实现不同步）`);
  const current = await PANEL_READERS[spec.panel]();
  const oldValue = spec.read(current, ctx);
  await writer(ctx, newValue, current);
  // FEAT-AC1 P0-3 第 2 条：落盘成功后立刻刷悬浮窗配置快照。
  // 放在**写成功之后**（不是之前）：快照读的是存储真值，先把值写进去再刷才有意义。
  // 失败静默——设置已经改成功了，刷快照失败不该把这个结果说成失败。
  try {
    if (overlaySnapshotRefresher) await overlaySnapshotRefresher();
  } catch (error) {}
  try {
    settingChangeRecorder.noteSettingChanged(key, oldValue, newValue);
  } catch (error) {}
  return { key, oldValue, newValue };
}

// ---------- 工具定义 ----------

// 工具输出的渲染：一行一键，带面板分组与可读值。
function renderSettingsList(values) {
  const lines = [];
  for (const panel of APP_SETTING_PANELS) {
    const keys = keysForPanel(panel).filter(name => Object.prototype.hasOwnProperty.call(values, name));
    if (keys.length === 0) continue;
    lines.push(`【${panelLabel(panel)}】`);
    for (const key of keys) {
      lines.push(`  ${key} = ${renderSettingValue(key, values[key])}　（${describeSetting(key)}）`);
    }
  }
  return lines.length ? lines.join('\n') : '（没有读到可修改的设置）';
}

const LIST_APP_SETTINGS_TOOL = {
  name: 'list_app_settings',
  description: '列出 APP 的设置项（当前值）。这是**只读**工具。'
    + '可用于回答「播报开了吗」「现在什么主题」这类问题，也可在改设置前先确认现状。'
    + '可修改的设置项是一份固定白名单（见 set_app_setting）；API 密钥等敏感字段不在其中、也不会出现在这里。'
    + `可选 panel 参数只看某一组：${APP_SETTING_PANELS.map(p => `${p}（${panelLabel(p)}）`).join('、')}。`,
  readOnly: true,
  parameters: {
    type: 'object',
    properties: {
      panel: {
        type: 'string',
        description: `可选：只看某组设置。取值 ${APP_SETTING_PANELS.join(' / ')} 之一。`,
      },
    },
  },
  execute: async (options, args, ctx) => {
    const panel = typeof args.panel === 'string' ? args.panel.trim() : '';
    if (panel && !PANEL_READERS[panel]) {
      return `未知的设置组「${panel}」。可选：${APP_SETTING_PANELS.map(p => `${p}（${panelLabel(p)}）`).join('、')}`;
    }
    const values = await readAllSettings({ panel, ctx });
    return renderSettingsList(values);
  },
};

const GET_APP_SETTING_TOOL = {
  name: 'get_app_setting',
  description: '读取**单个** APP 设置项的当前值（只读工具）。'
    + `key 必须在可修改白名单内（${APP_SETTING_KEY_NAMES.join(' / ')}）；白名单外的键（尤其密钥类）读不到。`,
  readOnly: true,
  parameters: {
    type: 'object',
    properties: {
      key: { type: 'string', description: `设置键，如 ${APP_SETTING_KEY_NAMES[0]}。` },
    },
    required: ['key'],
  },
  execute: async (options, args, ctx) => {
    const key = typeof args.key === 'string' ? args.key.trim() : '';
    if (!APP_SETTING_KEYS[key]) {
      return `该键不可通过助手修改或读取：${key || '(空)'}。可用键：${APP_SETTING_KEY_NAMES.join(' / ')}`;
    }
    const spec = APP_SETTING_KEYS[key];
    let value;
    try {
      value = await readSettingValue(key, ctx);
    } catch (error) {
      return `读取「${panelLabel(spec.panel)}」设置失败：${String((error && error.message) || error)}`;
    }
    return `${key} = ${renderSettingValue(key, value)}`;
  },
};

const SET_APP_SETTING_TOOL = {
  name: 'set_app_setting',
  description: '修改**一个** APP 设置项。这是写操作，**执行前会弹确认框让用户批准**。'
    + `key 必须是白名单内的（${APP_SETTING_KEY_NAMES.join(' / ')}）；`
    + '白名单外的键（尤其 API 密钥）一律拒绝修改。'
    + '布尔项传 true/false，枚举项传允许值之一（错误传值会返回允许清单，请据此纠正后再试）。'
    + '用户拒绝时返回「用户已拒绝」，此时不要重试，改用文字说明即可。',
  // 写工具：只在「可改」模式出现（registry 的 canRunTool 按 readOnly 过滤）。
  readOnly: false,
  // 与 run_shell / install_extension_pack 同一条审批链：改用户设置必须经用户点头。
  requiresConfirmation: true,
  parameters: {
    type: 'object',
    properties: {
      key: { type: 'string', description: `设置键，如 ${APP_SETTING_KEY_NAMES[0]}。` },
      value: {
        description: '新值。布尔项传 true / false；枚举项传允许值之一。',
        // 刻意不写 type：类型随键而变（bool / string / number 都有）。
      },
    },
    required: ['key', 'value'],
  },
  execute: async (options, args, ctx) => {
    const key = typeof args.key === 'string' ? args.key.trim() : '';
    // 白名单外：直接返回错误，**不进入确认流程**（也没必要打扰用户）。
    if (!APP_SETTING_KEYS[key]) {
      return `该键不可通过助手修改：${key || '(空)'}。可用键：${APP_SETTING_KEY_NAMES.join(' / ')}`;
    }
    const invalid = validateSettingValue(key, args.value);
    if (invalid) return `${invalid}。未做任何修改。`;
    const value = coerceSettingValue(key, args.value);
    let result;
    try {
      result = await applySettingValue(key, value, ctx);
    } catch (error) {
      return `修改失败（设置未生效）：${String((error && error.message) || error)}`;
    }
    return `已把「${describeSetting(key)}」（${key}）从 ${renderSettingValue(key, result.oldValue)}`
      + ` 改为 ${renderSettingValue(key, result.newValue)}。`;
  },
};

export const APP_SETTINGS_TOOL_DEFINITIONS = Object.freeze([
  LIST_APP_SETTINGS_TOOL,
  GET_APP_SETTING_TOOL,
  SET_APP_SETTING_TOOL,
]);

// 按模式分组的两份清单：索引层的聚合次序是契约（只读在前、写在写区），
// 所以在这里就分好，而不是让 tools.js 自己 filter（filter 会把次序责任
// 摊到索引层，两处各写一份筛选口径又是漂移源）。
export const APP_SETTINGS_READ_DEFINITIONS = Object.freeze(
  APP_SETTINGS_TOOL_DEFINITIONS.filter(item => item.readOnly === true)
);
export const APP_SETTINGS_WRITE_DEFINITIONS = Object.freeze(
  APP_SETTINGS_TOOL_DEFINITIONS.filter(item => item.readOnly !== true)
);

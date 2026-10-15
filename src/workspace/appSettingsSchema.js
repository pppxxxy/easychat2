// FEAT-AC1：应用设置白名单的**纯逻辑层**（零 RN 依赖，Node 直测）。
//
// 为什么必须单独一个文件（这是本仓反复踩过的同一课）：
// 工具文件要 import storage 域（saveTtsSettings / patchAppearanceSettings …），
// 而那些域依赖 `expo-file-system/legacy`（io.js）——在 Node 里根本 import 不了。
// 于是整个工具文件连带白名单、校验、归一逻辑全都无法单测（M2.5 的
// overlayThreadParse.js、FIX-7 的 modelCapabilities.js 都是同一个原因拆出来的）。
//
// 拆法：**值域与校验（纯）留在这里；读盘与落盘（脏）注入进工具文件**。
// 于是「白名单外的键能否拒绝」「类型/枚举不匹配能否给出具体原因」这类
// 真正有风险的判定，全部可以在 Node 里直测。

import { TTS_PROVIDERS } from '../tts/providers.js';
import { THEMES } from '../theme/themes.js';
import { describeValue } from './schemaValue.js';

// 值的可读短串渲染走共享实现（与 musicToolSchema / reminderSchema 同一口径，
// 避免三处各写一份必然漂移）。对外仍以 describeValue 名义导出。
export { describeValue };

// 面板名与键描述：**在函数里用模板串渲染**，与 toolDefs/ 下 123 处工具 description 同口径。
//
// 为什么不在模块级常量里写中文（本仓 local-i18n/no-hardcoded-chinese-text 门禁）：
// 该规则禁止**模块级导出常量**出现中文——那是「会被渲染层读走的 UI 文案」的形态
//（先例：chatConstants.js 的 THINKING_PLACEHOLDER）。它**有意不覆盖模板串**，
// 因为模板串与模型提示词在 AST 上同形（见 eslint-rules/no-hardcoded-chinese.mjs
// 「已知盲区」一段）。而本文件这些文字全部是**发给模型的工具输出/提示词**，
// 仓库既有口径就是「工具描述不进 i18n，界面文案才走词条」（readTools.js 顶部注释）。
//
// 面向**用户**的确认弹窗不走这里：那条路径由 UI 层渲染
//（toolApproval.js 的 describeToolApproval 只显示 i18n 标题 + JSON args）。
function panelName(name) {
  return ({
    tts: `语音播报`,
    appearance: `外观主题`,
    musicClip: `音乐片段`,
    diary: `日记`,
  })[name] || name;
}

// 音乐片段的数值枚举：**从契约常量取**。放在这里而不是 import chatOptions.js
// ——那个文件会拉 expo-file-system。值与它保持同源由单测钉住
//（见 tests/appSettingsTools.test.mjs 的「枚举与设置域一致」用例）。
export const MUSIC_CLIP_SECONDS = Object.freeze([15, 30, 60]);
export const MUSIC_CLIP_SAMPLE_RATES = Object.freeze([16000, 24000, 44100]);

// 每个角色的日记开关：diary 域的设置形态是 { roles: { <characterId>: { enabled } } }。
export const DIARY_DEFAULT_ROLE = 'default';

// 键 → 描述（模板串，见上方说明）。单独一张表而不是写进 APP_SETTING_KEYS：
// 描述是**展示文案**，与「键的能力（panel/type/枚举/取值）」分开，
// 这样校验逻辑的单测不必关心文案，改文案也不会动到能力定义。
const KEY_DESCRIPTIONS = {
  'tts.autoBroadcast': `角色回复后是否自动语音播报（悬浮窗与 app 内共用这个开关）`,
  'tts.activeProvider': `语音播报使用的引擎（系统引擎或已内置的服务商）`,
  'appearance.theme': `界面主题配色`,
  'musicClip.clipSeconds': `发给模型的音乐片段时长上限（秒）`,
  'musicClip.sampleRate': `发给模型的音乐片段采样率（Hz）`,
  'diary.enabled': `是否为当前角色开启日记（每个角色独立）`,
};

/** 键的展示描述（模板串渲染，供工具输出与确认文案复用）。 */
export function describeSetting(key) {
  return KEY_DESCRIPTIONS[key] || key;
}

/**
 * FEAT-AC1 P1-5：设置白名单（**唯一事实源**，冻结）。
 *
 * 每键：{ panel, type, enumValues?, read }
 *  · read(settings, ctx) —— 从**已读出的域设置对象**里取值（纯函数，便于单测）
 *  · 展示描述见 describeSetting(key)；写入实现在工具文件里按**同名键**注册
 *    （它要 import storage 域，属脏层），单测断言「每个键都有对应的写实现」。
 */
export const APP_SETTING_KEYS = Object.freeze({
  'tts.autoBroadcast': Object.freeze({
    panel: 'tts',
    type: 'boolean',
    read: (settings) => settings && settings.autoBroadcast === true,
  }),
  'tts.activeProvider': Object.freeze({
    panel: 'tts',
    type: 'enum',
    // 合法值**从声明表派生**，不手抄：新增播报源时这里自动跟随
    //（手抄清单会漂移——本仓 2026-10-11 的能力卡就因此漏过新工具）。
    enumValues: Object.freeze(TTS_PROVIDERS.map(item => item.id)),
    read: (settings) => (settings && settings.activeProvider) || 'system',
  }),
  'appearance.theme': Object.freeze({
    panel: 'appearance',
    type: 'enum',
    // 同上：主题清单从 THEMES 派生，不手抄。
    enumValues: Object.freeze(THEMES.map(item => item.id)),
    read: (settings) => (settings && settings.themeId) || 'dark',
  }),
  'musicClip.clipSeconds': Object.freeze({
    panel: 'musicClip',
    type: 'enum',
    enumValues: MUSIC_CLIP_SECONDS,
    read: (settings) => Number(settings && settings.clipSeconds),
  }),
  'musicClip.sampleRate': Object.freeze({
    panel: 'musicClip',
    type: 'enum',
    enumValues: MUSIC_CLIP_SAMPLE_RATES,
    read: (settings) => Number(settings && settings.sampleRate),
  }),
  'diary.enabled': Object.freeze({
    panel: 'diary',
    type: 'boolean',
    read: (settings, ctx) => {
      const roles = (settings && settings.roles) || {};
      const id = (ctx && ctx.characterId) || DIARY_DEFAULT_ROLE;
      return !!(roles[id] && roles[id].enabled === true);
    },
  }),
});

export const APP_SETTING_KEY_NAMES = Object.freeze(Object.keys(APP_SETTING_KEYS));

/** 所有面板名（按白名单出现顺序，去重）。 */
export const APP_SETTING_PANELS = Object.freeze(
  [...new Set(APP_SETTING_KEY_NAMES.map(name => APP_SETTING_KEYS[name].panel))]
);

/** 面板的展示名字（模板串渲染，见文件顶部的口径说明）。 */
export function panelLabel(panel) {
  return panelName(panel);
}

/** 某面板下的键名清单（list 的过滤与 set 的分组都用它）。 */
export function keysForPanel(panel) {
  return APP_SETTING_KEY_NAMES.filter(name => APP_SETTING_KEYS[name].panel === panel);
}

/**
 * 布尔字段的字符串宽容：'true' / 'false'（trim 后、大小写不敏感）→ 布尔。
 *
 * 为什么必须宽容（FEAT-AC8 BUG-A 的根因，已对码核实）：
 * set_app_setting 的 value 参数**刻意不声明 type**（类型随键而变，见工具定义），
 * 于是模型把布尔序列化成字符串 `"true"` 并不违规——确认卡上显示
 * `{"key":"tts.autoBroadcast","value":"true"}`（JSON 里布尔不带引号、字符串才带）
 * 就是现场证据。而校验层原先严格要求 `typeof value === 'boolean'`，
 * 字符串一律拒 ⇒ 工具返回「未做任何修改」⇒ 模型**合规地重发** ⇒ 确认卡连环弹
 * （用户一轮点了 4 次允许 + 1 次拒绝）。
 *
 * 这不是「放松校验」：字符串 'true' 的**语义无歧义**，与枚举的 "30" → 30 是同一类
 * 归一（那段注释早就写着「模型常把数值写成字符串，为这个差异拒绝一次会让它多绕一轮」
 * ——同样的宽容此前唯独没给布尔）。真正有歧义的（'yes' / '1' / '' / 'on'）**仍然拒**。
 */
export function parseBooleanString(value) {
  if (typeof value !== 'string') return undefined;
  const text = value.trim().toLowerCase();
  if (text === 'true') return true;
  if (text === 'false') return false;
  return undefined;
}

/**
 * 类型/枚举校验：返回 null = 通过；返回字符串 = 拒绝原因（给模型与用户看）。
 *
 * 校验失败**不猜不修**：静默把非法值归一成默认值会让模型以为改成功了
 *（真值被改成了别的东西），而用户看到的是「设置没生效」。
 */
export function validateSettingValue(key, value) {
  const spec = APP_SETTING_KEYS[key];
  if (!spec) return `该键不可通过助手修改：${key || '(空)'}`;
  if (spec.type === 'boolean') {
    // 布尔与布尔字符串都放行（后者由 coerceSettingValue 归一）；
    // 其余（'yes' / '1' / '' / 数字）仍拒——语义有歧义的不猜。
    if (typeof value === 'boolean' || parseBooleanString(value) !== undefined) return null;
    return `${key} 需要 true 或 false，收到的是 ${describeValue(value)}`;
  }
  if (spec.type === 'enum') {
    const allowed = spec.enumValues || [];
    // 数值枚举与字符串枚举都支持（musicClip 是数值）。
    // 宽松配对（"30" 与 30 视为同值）是有意的：模型常把数值写成字符串，
    // 为这个差异拒绝一次会让它多绕一轮。规范化交给 coerceSettingValue。
    const matched = allowed.some(item => item === value || String(item) === String(value));
    if (!matched) {
      return `${key} 只能是 ${allowed.join(' / ')} 之一，收到的是 ${describeValue(value)}`;
    }
    return null;
  }
  return `未知的设置类型：${spec.type}`;
}

/**
 * 值的规范化：把 "30" 归一成 30（数值枚举）、'true' 归一成 true（布尔），其余原样。
 * 与 validateSettingValue 的放行口径**必须成对**——只放宽校验不归一，
 * 会把字符串写进存储（`autoBroadcast: 'false'` 是 truthy，比拒绝更糟）。
 */
export function coerceSettingValue(key, value) {
  const spec = APP_SETTING_KEYS[key];
  if (!spec) return value;
  if (spec.type === 'boolean') {
    const parsed = parseBooleanString(value);
    return parsed === undefined ? value : parsed;
  }
  if (spec.type !== 'enum') return value;
  const allowed = spec.enumValues || [];
  const matched = allowed.find(item => item === value || String(item) === String(value));
  return matched === undefined ? value : matched;
}

/** 值的可读渲染（工具输出与诊断留痕共用同一口径）。 */
export function renderSettingValue(key, value) {
  const spec = APP_SETTING_KEYS[key];
  if (spec && spec.type === 'boolean') return value ? `开` : `关`;
  return String(value);
}

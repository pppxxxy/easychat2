// 聊天选项 / 外观 / 设置页分区 / 内联配图 / 音乐片段设置存储。
// 从 src/storage/settings.js 原样外提（无行为变化）。

import AsyncStorage from '@react-native-async-storage/async-storage';

import { normalizeImagePosition } from '../../imageGen/inlineImagePrompt.js';
import { normalizeHiddenToolNotices } from '../../chat/toolNoticeVisibility.js';
import { BUBBLE_STYLES, THEMES } from '../../theme/themes.js';
import { tActive } from '../../i18n/index.js';
import { backupCorruptValue, readJson, readJsonStatus } from '../io.js';
import { normalizeImageProviderId } from './imageProvider.js';

const CHAT_OPTIONS_KEY = '@easychat2_chat_options';
const APPEARANCE_KEY = '@easychat2_appearance';
const INLINE_IMAGE_KEY = '@easychat2_inline_image';
const MUSIC_CLIP_KEY = '@easychat2_music_clip';
const UI_SECTIONS_KEY = '@easychat2_ui_sections';

// 写路径守卫（变体①：拒绝写回 / 抛错）。
// 参考 src/storage/worldMap.js:34-40（updateWorldMap）：「读失败就抛错中止：绝不用空列表
// 覆盖已有地图」；同型见 src/storage/cardForge.js:182-186（saveCardForgeInternal）。
//
// 为什么本模块需要它：这 5 个键的 get 全是「读不出来就回落默认值」，而 save 是**整键覆盖**。
// 于是任何一次读失败都会把用户填过的设置静默重置成默认——本模块的读路径行为保持不变
// （损坏时仍返回默认值给 UI），只有写路径改判「读不出原值就不写」。
async function assertReadableForMutation(key) {
  const stored = await readJsonStatus(key);
  if (stored.status === 'corrupt') {
    // 覆盖不可逆，先留原始字节的副本再拒绝。
    await backupCorruptValue(key);
    throw new Error(tActive('error.storage.chatOptionsReadFailed'));
  }
}

function normalizeChatOptions(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    streaming: source.streaming !== false,
    fullWidth: source.fullWidth === true,
    // 含 <style>/<script> 的助手消息是否用 WebView 渲染；缺省开启。
    richHtml: source.richHtml !== false,
    // 是否按会话保留输入框草稿；缺省关闭，避免改变既有用户预期。
    keepDraft: source.keepDraft === true,
    // 时间感知：开启后在每次请求系统提示里附上当前日期时间；缺省关闭。
    timeAware: source.timeAware === true,
    // 气泡风格：圆润（默认）/ 卡片 / 无底纹；非法值回落默认。
    bubbleStyle: BUBBLE_STYLES.includes(source.bubbleStyle) ? source.bubbleStyle : 'rounded',
    // 聊天内工具（联网搜索）：开启后角色可在聊天中自主调用搜索工具，
    // 过程以「正在搜索…」气泡显示。缺省关闭——它会把提问发给第三方搜索服务。
    chatTools: source.chatTools === true,
    // E2：上下文占用到 85% 自动压缩会话（省 token / 省费用）；缺省开启。
    // 关掉后 70% 的「建议压缩」提示条仍在（只是不再自动执行）。
    autoCompact: source.autoCompact !== false,
    // 工具使用提示（聊天页的「工具过程气泡」）可见性：总开关 + 按工具隐藏。
    // 与 chatTools 同域是因为它们是同一件事的两面：那条决定工具能不能用，
    // 这两条只决定「用了工具」要不要说出来。判定唯一来源见
    // chat/toolNoticeVisibility.js——失败与审批永远不受这两条影响。
    hideAllToolNotices: source.hideAllToolNotices === true,
    hiddenToolNotices: normalizeHiddenToolNotices(source.hiddenToolNotices),
  };
}

export async function getChatOptions() {
  const raw = await readJson(CHAT_OPTIONS_KEY, null);
  return normalizeChatOptions(raw);
}

export async function saveChatOptions(options) {
  await assertReadableForMutation(CHAT_OPTIONS_KEY);
  const normalized = normalizeChatOptions(options);
  await AsyncStorage.setItem(CHAT_OPTIONS_KEY, JSON.stringify(normalized));
  return normalized;
}

// 一起听歌「音频片段」设置：送给模型的音频时长与采样率。只影响发往模型的片段，
// 不影响本地播放。缺省 30 秒 / 16kHz 单声道（体积小、够理解歌词与旋律）。
export const MUSIC_CLIP_SECONDS = [15, 30, 60];
export const MUSIC_CLIP_SAMPLE_RATES = [16000, 24000, 44100];
export const DEFAULT_MUSIC_CLIP = { clipSeconds: 30, sampleRate: 16000 };

function normalizeMusicClip(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const clipSeconds = MUSIC_CLIP_SECONDS.includes(source.clipSeconds)
    ? source.clipSeconds
    : DEFAULT_MUSIC_CLIP.clipSeconds;
  const sampleRate = MUSIC_CLIP_SAMPLE_RATES.includes(source.sampleRate)
    ? source.sampleRate
    : DEFAULT_MUSIC_CLIP.sampleRate;
  return { clipSeconds, sampleRate };
}

export async function getMusicClipSettings() {
  const raw = await readJson(MUSIC_CLIP_KEY, null);
  return normalizeMusicClip(raw);
}

export async function saveMusicClipSettings(settings) {
  await assertReadableForMutation(MUSIC_CLIP_KEY);
  const normalized = normalizeMusicClip(settings);
  await AsyncStorage.setItem(MUSIC_CLIP_KEY, JSON.stringify(normalized));
  return normalized;
}

// 主题白名单以 themes.js 为单一来源：硬编码列表漏掉新主题时，选中的主题会被规范化回 dark，
// 界面当场看似切换成功、冷启动却读回深色（用户选择丢失）。
const THEME_IDS = THEMES.map(theme => theme.id);
const FONT_SCALE_IDS = ['default', 'system', 'small', 'medium', 'large', 'xlarge'];
// 语言与主题/字号同属「外观」配置。新增 localeId 时**不能**把它做成必填字段：
// 旧版本写入的 JSON 没有这个 key，归一化必须容忍缺失并回落到默认值，
// 否则升级用户的外观设置会被整体重置。
export const LOCALE_IDS = ['zh-CN', 'en'];
const DEFAULT_APPEARANCE = { themeId: 'dark', fontScaleId: 'default', localeId: 'zh-CN' };

function normalizeAppearance(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    themeId: THEME_IDS.includes(source.themeId) ? source.themeId : DEFAULT_APPEARANCE.themeId,
    fontScaleId: FONT_SCALE_IDS.includes(source.fontScaleId)
      ? source.fontScaleId
      : DEFAULT_APPEARANCE.fontScaleId,
    localeId: LOCALE_IDS.includes(source.localeId) ? source.localeId : DEFAULT_APPEARANCE.localeId,
  };
}

export async function getAppearanceSettings() {
  const raw = await readJson(APPEARANCE_KEY, null);
  return normalizeAppearance(raw);
}

export async function saveAppearanceSettings(settings) {
  await assertReadableForMutation(APPEARANCE_KEY);
  const normalized = normalizeAppearance(settings);
  await AsyncStorage.setItem(APPEARANCE_KEY, JSON.stringify(normalized));
  return normalized;
}

// 局部更新：读现值 → 合并补丁 → 归一化写回。
//
// 存在的理由：外观键由主题、字号、语言共享，而这三个设置分别由相互独立的
// Context 维护（ThemeContext / I18nContext）。若各自直接调用
// saveAppearanceSettings 且只带上自己的字段，归一化会把其余字段归回默认值——
// 表现为「改主题把语言重置了」。所有写入方都应走这个函数。
//
// 但「读现值」这一步必须**区分读失败与读到空**（变体①）：此前的实现走
// getAppearanceSettings()，读失败时它给的是默认值，于是「当前值」被当成
// `{themeId:'dark', fontScaleId:'default', localeId:'zh-CN'}`，合并后整键写回——
// 切一次主题就把用户的语言与字号一起重置（切语言同理，ThemeContext.js:69 /
// I18nContext.js:62 两个入口都走这里）。所以这里自己拿 status：
// 读失败 → 备份 + 抛错中止，绝不拿默认值当「当前值」。
export async function patchAppearanceSettings(patch) {
  const stored = await readJsonStatus(APPEARANCE_KEY);
  if (stored.status === 'corrupt') {
    await backupCorruptValue(APPEARANCE_KEY);
    throw new Error(tActive('error.storage.chatOptionsReadFailed'));
  }
  const current = normalizeAppearance(stored.status === 'ok' ? stored.value : null);
  const merged = { ...current, ...(patch && typeof patch === 'object' ? patch : {}) };
  const normalized = normalizeAppearance(merged);
  await AsyncStorage.setItem(APPEARANCE_KEY, JSON.stringify(normalized));
  return normalized;
}

// 设置页各折叠卡的展开/收起状态。只存用户显式切换过的卡（布尔），
// 未记录的卡由界面按「是否已配置」决定默认展开，缺省/损坏时回退为空对象。
export const UI_SECTION_IDS = [
  'api',
  'sampling',
  'persona',
  'appearance',
  'experience',
  'extensions',
  'vector',
  'workspace',
  'github',
  'about',
];

function normalizeUiSections(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const result = {};
  UI_SECTION_IDS.forEach(id => {
    if (source[id] === true || source[id] === false) result[id] = source[id];
  });
  return result;
}

export async function getUiSections() {
  const raw = await readJson(UI_SECTIONS_KEY, null);
  return normalizeUiSections(raw);
}

export async function saveUiSections(sections) {
  await assertReadableForMutation(UI_SECTIONS_KEY);
  const normalized = normalizeUiSections(sections);
  await AsyncStorage.setItem(UI_SECTIONS_KEY, JSON.stringify(normalized));
  return normalized;
}

const DEFAULT_INLINE_IMAGE = {
  enabled: false,
  providerId: '',
  stylePrefix: '',
  size: '832*1216',
  maxPromptChars: 400,
  imagePosition: 'end',
};

function normalizeInlineImage(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const maxPromptChars = Number(source.maxPromptChars);
  return {
    enabled: source.enabled === true,
    providerId: normalizeImageProviderId(source.providerId),
    stylePrefix: String(source.stylePrefix || ''),
    size: String(source.size || DEFAULT_INLINE_IMAGE.size),
    maxPromptChars: Number.isFinite(maxPromptChars) && maxPromptChars > 0
      ? Math.min(Math.round(maxPromptChars), 2000)
      : DEFAULT_INLINE_IMAGE.maxPromptChars,
    // 配图取「回复的哪一段」：开头 / 高潮正中间 / 结尾（默认结尾）。
    imagePosition: normalizeImagePosition(source.imagePosition),
  };
}

export async function getInlineImageSettings() {
  const raw = await readJson(INLINE_IMAGE_KEY, null);
  return normalizeInlineImage(raw);
}

export async function saveInlineImageSettings(settings) {
  await assertReadableForMutation(INLINE_IMAGE_KEY);
  const normalized = normalizeInlineImage(settings);
  await AsyncStorage.setItem(INLINE_IMAGE_KEY, JSON.stringify(normalized));
  return normalized;
}

// 应用设置存储领域实现聚合：从各子模块 re-export 公开符号，barrel 只需指向这里。
// 从 src/storage/settings.js 原样外提（纯搬运，无行为变化）。
// 依赖单向：thinking/sampling/imageProvider/imageGen/chatOptions/tts/memorySummary/
// plugins/onboarding 均为叶子，imageProvider 被 imageGen/chatOptions 复用，无循环。

export {
  THINKING_LEVELS,
  THINKING_DISPLAYS,
  getThinkingSettings,
  saveThinkingSettings,
} from './thinking.js';
export {
  SAMPLING_FIELDS,
  getSamplingSettings,
  saveSamplingSettings,
} from './sampling.js';
export {
  getImageGenSettings,
  saveImageGenSettings,
} from './imageGen.js';
export {
  getChatOptions,
  saveChatOptions,
  MUSIC_CLIP_SECONDS,
  MUSIC_CLIP_SAMPLE_RATES,
  DEFAULT_MUSIC_CLIP,
  getMusicClipSettings,
  saveMusicClipSettings,
  LOCALE_IDS,
  getAppearanceSettings,
  saveAppearanceSettings,
  patchAppearanceSettings,
  UI_SECTION_IDS,
  getUiSections,
  saveUiSections,
  getInlineImageSettings,
  saveInlineImageSettings,
} from './chatOptions.js';
export {
  getTtsSettings,
  saveTtsSettings,
  normalizeTranscriptionSettings,
  getTranscriptionSettings,
  saveTranscriptionSettings,
} from './tts.js';
export {
  getMemorySummarySettings,
  saveMemorySummarySettings,
} from './memorySummary.js';
export {
  getPlugins,
  savePlugins,
  getEnabledPlugins,
} from './plugins.js';
export {
  DISCLAIMER_VERSION,
  isDisclaimerAcknowledged,
  acknowledgeDisclaimer,
  isOnboardingDone,
  completeOnboarding,
} from './onboarding.js';

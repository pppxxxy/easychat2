// 应用设置存储领域 barrel。从 src/storage.js 原样外提（无行为变化）。
// 实现已拆到 src/storage/settings/ 子目录：thinking（思考）、sampling（采样）、
// imageProvider（生图 provider id 归一化叶子）、imageGen（生图配置）、
// chatOptions（聊天选项/外观/UI 分区/内联配图/音乐片段）、tts（语音播报/转写）、
// memorySummary（记忆总结）、plugins（插件）、onboarding（免责声明/引导）、
// index（聚合导出）。依赖单向，无循环。

export {
  DISCLAIMER_VERSION,
  SAMPLING_FIELDS,
  THINKING_DISPLAYS,
  THINKING_LEVELS,
  MUSIC_CLIP_SECONDS,
  MUSIC_CLIP_SAMPLE_RATES,
  DEFAULT_MUSIC_CLIP,
  LOCALE_IDS,
  UI_SECTION_IDS,
  acknowledgeDisclaimer,
  completeOnboarding,
  getAppearanceSettings,
  getChatOptions,
  getEnabledPlugins,
  getImageGenSettings,
  getInlineImageSettings,
  getMemorySummarySettings,
  getMusicClipSettings,
  getPlugins,
  getSamplingSettings,
  getThinkingSettings,
  getTranscriptionSettings,
  getTtsSettings,
  getUiSections,
  isDisclaimerAcknowledged,
  isOnboardingDone,
  normalizeTranscriptionSettings,
  patchAppearanceSettings,
  saveAppearanceSettings,
  saveChatOptions,
  saveImageGenSettings,
  saveInlineImageSettings,
  saveMemorySummarySettings,
  saveMusicClipSettings,
  savePlugins,
  saveSamplingSettings,
  saveThinkingSettings,
  saveTranscriptionSettings,
  saveTtsSettings,
  saveUiSections,
} from './settings/index.js';

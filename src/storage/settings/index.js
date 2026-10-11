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
  DEFAULT_DESCRIPTION_PROMPT,
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_TIMEOUT_SECONDS,
  DEFAULT_CONCURRENCY,
  MAX_CONCURRENCY,
  MIN_TIMEOUT_SECONDS,
  MAX_TIMEOUT_SECONDS,
  MAX_OUTPUT_TOKENS_LIMIT,
  SCREEN_WATCH_SOURCES,
  DEFAULT_SCREEN_WATCH_SOURCE,
  normalizeImageRecognitionSettings,
  getImageRecognitionSettings,
  saveImageRecognitionSettings,
  imageRecognitionCacheKey,
  pruneImageRecognitionCache,
  readImageRecognitionCache,
  writeImageRecognitionCache,
  clearImageRecognitionCache,
} from './imageRecognition.js';
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
  DEFAULT_MEMORY_LENGTH,
  MEMORY_LENGTH_MAX,
  getMemorySummarySettings,
  saveMemorySummarySettings,
  patchMemorySummarySettings,
} from './memorySummary.js';
export {
  getPlugins,
  savePlugins,
  getEnabledPlugins,
} from './plugins.js';
export {
  MCP_SERVER_KEY,
  MCP_SERVER_SCOPES,
  MCP_SERVER_PORT_DEFAULT,
  MCP_SERVER_PORT_MIN,
  MCP_SERVER_PORT_MAX,
  normalizeMcpServerSettings,
  getMcpServerSettings,
  saveMcpServerSettings,
  patchMcpServerSettings,
} from './mcpServer.js';
export {
  DISCLAIMER_VERSION,
  isDisclaimerAcknowledged,
  acknowledgeDisclaimer,
  isOnboardingDone,
  completeOnboarding,
} from './onboarding.js';

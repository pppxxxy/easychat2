// Public card-forge API. Implementations remain pure and have no external dependencies.

export {
  FORGE_FIELDS,
  FIELD_LABELS,
  FORGE_SAMPLING_OVERRIDES,
  FORGE_SYSTEM,
  MAX_PRESERVED_TEXT,
  MAX_PRESERVED_ITEMS,
  MAX_FORGE_TAG_COUNT,
  ENTRY_FIELD_LIMITS,
  ENTRY_KEYS_MAX_COUNT,
  entryFieldLimit,
  collapseOnlyFlags,
} from './forge/shared.js';

// 高级内容的本地清洗：模型生成（patch.js 的 parseCardPatch/mergeDraft）与
// storage 侧保存前的重跑清洗都从这里取同一份 sanitizer。
// 此前这四个 sanitizer 不在 barrel 内（问题 H）：外部只能深链 forge/advanced.js，
// 「保存路径也要重跑 sanitize」这类改动就会各自另写一份实现。
export {
  sanitizeWorldEntry,
  sanitizeRegexScript,
  sanitizePreset,
  sanitizeAdvancedArray,
} from './forge/advanced.js';

// 制卡图片的路径与命名规则（纯函数、零 RN 依赖）。同属制卡公共 API：
// 草稿目录判定、命名、清理的调用方不该深链 mediaPaths.js（问题 H）。
export {
  FORGE_MEDIA_DIRECTORY,
  AVATAR_DIRECTORY,
  forgeMediaDirectory,
  avatarDirectory,
  isForgeMediaUri,
  forgeImageExtension,
  buildForgeImageName,
  buildPromotedAvatarName,
  isForgePayloadFileName,
  forgeImageNamesToDelete,
} from './mediaPaths.js';

export {
  CONVERSATION_MESSAGE_MAX_CHARS,
  CONVERSATION_TRANSCRIPT_MAX_CHARS,
  buildConversationCardPrompt,
  formatConversationTranscript,
} from './forge/conversation.js';

export {
  FORGE_QUESTIONS,
  requestedAdvancedSections,
  createForgeState,
  appendTranscript,
  currentQuestion,
  summarizeAnswers,
  recordAnswer,
} from './forge/state.js';

export {
  createForgeDraft,
  projectForgeDraft,
  draftFromCharacter,
  draftToCharacterPatch,
  hasCardContent,
} from './forge/draft.js';

export {
  buildGeneratePrompt,
  buildAdvancedPrompt,
  buildJsonRepairPrompt,
  buildEditPrompt,
  buildImageCardPrompt,
} from './forge/prompts.js';

export {
  parseCardPatch,
  mergeDraft,
} from './forge/patch.js';

export {
  FIELD_ASSIST_SYSTEM,
  buildFieldAssistPrompt,
  parseFieldAssistText,
  buildTagsAssistPrompt,
  buildEntryAssistPrompt,
  parseEntryAssistPatch,
  mergeEntryAssistPatch,
} from './forge/assist.js';

// Public card-forge API. Implementations remain pure and have no external dependencies.

export {
  FORGE_FIELDS,
  FIELD_LABELS,
  FORGE_SAMPLING_OVERRIDES,
  FORGE_SYSTEM,
  MAX_PRESERVED_TEXT,
  MAX_PRESERVED_ITEMS,
  MAX_FORGE_TAG_COUNT,
} from './forge/shared.js';

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

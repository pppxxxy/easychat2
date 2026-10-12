// i18n 词条 · sessionRecovery 域（English）。聚合入口见 ../en.js。
export const sessionRecovery = {
  // The panel name and "Close" are two different meanings and must not share one key
  // (same shape as transcription.title + transcription.closeA11y). `title` used to hold the
  // close wording, so the panel header read "Close". The name reuses the wording of the
  // entry point that opens it: memory.a11y.recover.
  'sessionRecovery.title': 'Recover lost chats',
  'sessionRecovery.closeA11y': 'Close',
  'sessionRecovery.back': 'Back',
  // These 6 entries were placeholder English (or a shifted block, same as the zh-CN file:
  // subtitleSingle held noPreview's text, previewLabel held meta's format, noPreview held
  // metaGroupSuffix's text, meta held noCharacters.title, timeUnknown held noCharacters.desc).
  // Usage: SessionRecoveryModal.js:105-106 (subtitle*), :109 (previewLabel — the label above
  // the preview block), :111/:163 (noPreview fallback), :114/:168 (meta + timeUnknown).
  'sessionRecovery.subtitleGroup': 'This group chat has {count} speakers — which character did it belong to? Once picked, it and its memory summary return to the list.',
  'sessionRecovery.subtitleSingle': 'Which character did this chat belong to? Once picked, it and its memory summary return to the list.',
  'sessionRecovery.previewLabel': 'Message preview',
  'sessionRecovery.noPreview': '(no preview)',
  'sessionRecovery.meta': '{count} messages · {time}',
  'sessionRecovery.timeUnknown': 'Time unknown',
  'sessionRecovery.a11y.recoverTo': 'Restore to {name}',
  'sessionRecovery.unnamedCharacter': 'Unnamed Character',
  'sessionRecovery.subtitleList': 'These chats still have all their messages; only the session record was lost (an old version deleted it when creating chats). Open any of them and pick the character it originally belonged to.',
  'sessionRecovery.subtitleEmpty': 'No lost chats found.',
  'sessionRecovery.a11y.pickSession': 'Select this chat',
  'sessionRecovery.metaGroup': ' · Possible group chat',
  'sessionRecovery.metaGroupSuffix': ' · Possible group chat ({count} speakers)',
  'sessionRecovery.noCharacters.desc': 'Create or import a character on the Characters page first.',
  'sessionRecovery.noCharacters.title': 'No characters available',
  'sessionRecovery.recommended': 'Recommended',
};

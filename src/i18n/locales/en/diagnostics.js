// i18n 词条 · diagnostics 域（English）。聚合入口见 ../en.js。
export const diagnostics = {
  'diagnostics.alert.copied.title': 'Copied',
  'diagnostics.alert.copied.body': 'Diagnostic log copied to the clipboard; paste it directly in your feedback.',
  'diagnostics.alert.copyFailed.title': 'Copy failed',
  'diagnostics.alert.copyFailed.body': 'Select the text and copy it manually.',
  'diagnostics.alert.clear.title': 'Clear diagnostic log',
  'diagnostics.alert.clear.body': 'Clear the diagnostic records stored on this device?',
  'diagnostics.alert.clear.confirm': 'Confirm',
  // A failed clear must be stated: otherwise the list looks emptied and the records come back
  // after a restart (see clearDiagnostics in diagnostics.js — both the cache and the stored
  // value are kept when the removal fails).
  'diagnostics.alert.clearFailed.title': 'Clear failed',
  'diagnostics.alert.clearFailed.body': 'The diagnostic log could not be cleared (storage write failed); the records are still kept. Please try again later.',
  // The panel name and "Close" are two different meanings and must not share one key
  // (same shape as transcription.title + transcription.closeA11y). `title` used to hold the
  // close wording, so the panel header read "Close".
  'diagnostics.title': 'Diagnostics',
  'diagnostics.closeA11y': 'Close',
  'diagnostics.readFailed': 'Failed to read the diagnostic log, so records cannot be shown. Please try again later.',
  'diagnostics.clear': 'Clear',
  'diagnostics.copyAll': 'Copy all',
  'diagnostics.empty': 'No records to show.',
  'diagnostics.hint': 'Stored locally only, sanitized, and never uploaded. Copy them to include in feedback when something goes wrong.',
};

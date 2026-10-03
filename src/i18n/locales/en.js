// English locale.
//
// 迁移约定见 locales/zh-CN.js：只收 UI 文案，不含发给模型的提示词。
// 缺失的 key 会回退到中文（见 src/i18n/index.js 的 translate），因此这里按批次补齐即可。
// UI 框架文案可机翻后校对；涉及角色语气的文案（正在思考…、录音提示等）已人工润色。

export const en = {
  // ---- App shell / bottom tabs ----
  'app.tab.chat': 'Chat',
  'app.tab.memory': 'Memory',
  'app.tab.character': 'Characters',
  'app.tab.extension': 'Extensions',
  'app.tab.settings': 'Settings',
  'app.crash.title': 'Startup failed',
  'app.crash.hint': 'Please screenshot the following and report it:',
  'app.save.failed.title': 'Save failed',
  'app.save.failed.body': 'Could not save progress. Please try again.',
  'app.migration.failed.title': 'Startup migration failed',
  'app.migration.failed.body': 'Old chat history could not be organized. Check your storage space and restart the app.',
  'app.default.userName': 'User',

  // ---- Chat top bar ----
  'chat.topBar.selection.cancel': 'Cancel',
  'chat.topBar.selection.count': '{count} selected',
  'chat.topBar.selection.selectAll': 'Select all',
  'chat.topBar.selection.unselectAll': 'Deselect all',
  'chat.topBar.selection.delete': 'Delete',
  'chat.topBar.newChat': 'New',
  'chat.topBar.broadcast.on': 'Auto-read on',
  'chat.topBar.broadcast.off': 'Auto-read off',
  'chat.topBar.a11y.cancelSelection': 'Cancel message selection',
  'chat.topBar.a11y.selectAll': 'Select all messages',
  'chat.topBar.a11y.unselectAll': 'Deselect all',
  'chat.topBar.a11y.deleteSelected': 'Delete selected messages',
  'chat.topBar.a11y.switchCharacter': 'Switch character',
  'chat.topBar.a11y.switchGroup': 'Switch group',
  'chat.topBar.a11y.newChat': 'New conversation',
  'chat.topBar.a11y.broadcastOn': 'Turn off auto-read',
  'chat.topBar.a11y.broadcastOff': 'Turn on auto-read',
  'chat.topBar.a11y.more': 'More',

  // ---- Attachment menu ----
  'chat.attach.title': 'Add attachment',
  'chat.attach.close': 'Close',
  'chat.attach.text.title': 'Text document',
  'chat.attach.text.hint': 'txt / md / json and other text is merged into your message',
  'chat.attach.camera.title': 'Take photo',
  'chat.attach.camera.hint': 'Capture a photo and send it to your character',
  'chat.attach.image.title': 'Photo library',
  'chat.attach.image.hint': 'Pick an image from your library',
  'chat.attach.visionRequired': 'The current source is not marked as vision-capable. Confirm model capabilities in Settings → API.',

  // ---- Composer ----
  'chat.composer.placeholder': 'Type a message...',
  'chat.composer.a11y.attach': 'Add attachment',
  'chat.composer.a11y.mention': 'Mention a member',
  'chat.composer.a11y.sticker': 'Stickers',
  'chat.composer.a11y.fullScreen': 'Full-screen input',
  'chat.composer.a11y.stop': 'Stop',
  'chat.composer.a11y.send': 'Send',
  'chat.composer.a11y.cancelQuote': 'Cancel quote',
  'chat.composer.a11y.record': 'Record a voice message',
  'chat.composer.a11y.stopRecord': 'Finish recording and transcribe',
  'chat.composer.a11y.cancelRecord': 'Cancel recording',
  'chat.composer.recording': 'Recording… release to finish, swipe up to cancel',
  'chat.composer.recording.cancel': 'Cancel',
  'chat.composer.quote.fallbackName': 'Original',

  // ---- Thinking indicator ----
  'chat.thinking.placeholder': 'Thinking...',

  // ---- Settings shell ----
  'settings.title': 'Settings',
  'settings.appearance.title': 'Appearance',
  'settings.appearance.language': 'Language',
  'settings.appearance.theme': 'Theme',
  'settings.appearance.fontScale': 'Font size',
  'settings.language.zh': '简体中文',
  'settings.language.en': 'English',
  'settings.workspace.title': 'Workspace',
  'settings.workspace.mode': 'Assistant mode',
  'settings.workspace.mode.ask': 'Ask',
  'settings.workspace.mode.read': 'Read-only',
  'settings.workspace.mode.write': 'Editable',
  'settings.workspace.hint.ask': 'Chat only; the assistant does not read workspace files.',
  'settings.workspace.hint.read': 'The assistant may read text/Markdown files in the workspace.',
  'settings.workspace.hint.write': 'The assistant may create or edit text/Markdown files and export Word.',

  // ---- Common ----
  'common.cancel': 'Cancel',
  'common.confirm': 'Confirm',
  'common.save': 'Save',
  'common.saving': 'Saving...',
  'common.delete': 'Delete',
  'common.close': 'Close',
  'common.retry': 'Retry',
  'common.copy': 'Copy',
  'common.copied': 'Copied',
  'common.done': 'Done',
  'common.loading': 'Working...',
};

export default en;

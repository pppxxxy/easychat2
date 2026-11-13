// i18n entries · desktop domain (English). Keys mirror zh-CN/desktop.js exactly.
export const desktop = {
  'desktop.status.available': 'Available',
  'desktop.status.unsupported': 'Not supported on desktop',
        'desktop.proactive.desktopOnlyHint': 'This desktop build can configure proactive messages (time slots, styles, continuation session) but does not fire them on its own: on the phone a system background service wakes the app, which has no equivalent once the desktop process exits. The configuration is stored in the same data the phone reads, so it takes effect there.',
'desktop.books.docxUnsupported': 'This desktop build parses plain text and Markdown only. Word (.docx) is zipped XML and needs extra unpacking/parsing; import it on your phone, or save it as txt / Markdown and import that here.',
'desktop.games.nativeHint': '“Daily Wife” reads character-library data (affinity, schedule, chat history) and runs in a native panel on the phone; the desktop build ships the web games only for now.',
'desktop.group.unavailable': 'Capabilities that need the phone OS',
  'desktop.group.unavailable.hint': 'These entries depend on Android/Expo system capabilities (screen-capture permission, overlays, headless background wake-up, native inference libraries, restricted shell). The desktop build has no equivalent. Open one to read why; everything else is available here.',
  'desktop.unsupported.intro': 'The first desktop release covers the core chat loop only. Capabilities that exist on mobile but are not implemented here stay listed, so you can open each one to see why and how to use it on your phone.',
  'desktop.unsupported.imageGen': 'Image generation relies on native image processing and gallery writes on the phone. The desktop first release does not connect to any image service and cannot save generated images. Generate on your phone, then sync characters and chats to the desktop with Backup & Restore.',
  'desktop.unsupported.tts': 'Text-to-speech depends on the system speech engine. The desktop first release does not include it: replies are never read aloud and there is no manual read-aloud button.',
  'desktop.unsupported.transcription': 'Speech-to-text needs recording and speech recognition. The desktop first release does not support recording, so there is no transcription entry point; voice messages appear as placeholders only.',
  'desktop.unsupported.localModels': 'Local model inference depends on the llama.rn native library (Android/iOS only); there is no Windows implementation. The desktop build can only connect to online API endpoints.',
  'desktop.unsupported.workspace': 'The workspace (file management, command execution, GitHub integration, Python tools) depends on native shell and filesystem privileges. The desktop first release keeps it closed for security reasons (sandboxed renderer + IPC allowlist).',
  'desktop.unsupported.plugins': 'The plugin runtime depends on Android-side native bridges and a JS sandbox. The desktop first release does not load plugins; the Extensions page only reports built-in capability status.',
  'desktop.unsupported.mcp': 'The built-in MCP server needs a resident background listener and native capabilities. It is not implemented in the desktop first release, so external agents cannot connect to this app.',
  'desktop.unsupported.screenWatch': 'Screen watching (overlay screenshots plus frame-sequence recognition) depends on Android screen capture and overlay permissions. The desktop build has no equivalent.',
  'desktop.unsupported.proactive': 'Proactive messages and scheduled tasks depend on Android background services (WorkManager / foreground service). The desktop app only runs while its window is open and never fires in the background.',
  'desktop.unsupported.scheduled': 'Scheduled tasks depend on system alarms and background wake-ups. The desktop first release has no scheduler; use your phone for scheduled tasks.',
  'desktop.entry.localModels': 'Local models',
  'desktop.entry.workspace': 'Workspace & tools',
  'desktop.entry.plugins': 'Plugins',
  'desktop.entry.mcp': 'MCP server',
  'desktop.entry.screenWatch': 'Screen watch',
  'desktop.entry.scheduled': 'Scheduled tasks',
};

export default desktop;
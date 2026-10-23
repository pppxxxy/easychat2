// 教学章节（第二批）英文参考译文：与 onboardingContentBatch2.js 的 12 章**逐章一一对应**
// （同 id / 同序 / 同图标 / 同截图键 / 同步骤数 / 同速查项数）。
//
// 语言政策（2026-10-24 用户裁决）：中文是权威文本，本文件是随界面语言使用的英文版；
// 用户可见字符串全部为英文，代码注释仍按仓库惯例用中文。
// 路径用词对齐 en 词条的真实界面文案（Settings / API Configuration / Assistant mode =
// Ask / Read-only / Editable / Allow command execution / Let the model run Python /
// Voice Playback / Speech to text / Backup & Restore 等）。
//
// 结构对齐与「无中文残留」由 tests/onboardingContent.test.mjs 的英文组钉住；
// 本文件完全静态（无 tActive 动态词条），可在 Node 直接 import。
export const ONBOARDING_CHAPTERS_BATCH2_EN = [
  {
    id: 'workspace',
    title: 'Workspace (files, terminal & history)',
    icon: 'folder-open-outline',
    images: [
      { key: 'workspace', caption: 'Files tab: in Editable mode you can create text files / folders, import files, export Word, and view file history.' },
      { key: 'workspace-terminal', caption: 'Terminal tab: requires "Editable" mode with command execution on; it can only reach the app sandbox and public paths like /system/bin.' },
    ],
    summary: 'Let the assistant read and write the folder you choose, and run commands when needed.',
    intro:
      'The workspace is a file space inside the app: the assistant can read, create, and modify text and Markdown files there, '
      + 'and export Word documents. It defaults to the app-private directory (wiped on uninstall), but you can point it at any folder on your phone.',
    steps: [
      'Open "Settings" and find the "Workspace" card.',
      'Pick the "Assistant mode": Ask (text only, no file access) / Read-only (can read and quote) / Editable (can create and modify).',
      'To change the directory, tap "Workspace folder → Choose folder" and authorize any folder on your phone; "Use default" returns to the in-app directory.',
      'Open the workspace panel and use the "Files" tab to browse, open, and edit files in the workspace.',
      'To run commands, switch to "Editable" mode first, then enable "Allow command execution"; every command shows a separate confirmation dialog before it runs.',
    ],
    items: [
      { name: 'Assistant mode', where: 'Settings → Workspace → Assistant mode', usage: 'Ask / Read-only / Editable — decides whether the assistant can touch workspace files.' },
      { name: 'Workspace folder', where: 'Settings → Workspace → Workspace folder', usage: 'Defaults to the app-private directory; you can switch to any folder on the phone — the grant covers that folder and all of its subdirectories.' },
      { name: 'Allow command execution', where: 'Settings → Workspace → Allow command execution', usage: 'When on, shell commands produced by the model really run inside the sandbox directory; each one is confirmed separately.' },
      { name: 'Let the model run Python', where: 'Settings → Workspace → Let the model run Python', usage: 'Scripts run in a separate process; a 30-second timeout or tapping "Stop" force-terminates them.' },
      { name: 'Files tab', where: 'Workspace → Files', usage: 'Browse and edit text / Markdown files in the workspace.' },
      { name: 'Local history', where: 'Workspace → History', usage: 'Review change records and per-file diffs; roll back or restore a single file\'s earlier version.' },
      { name: 'GitHub tab', where: 'Workspace → GitHub', usage: 'Browse repositories, commit and push, open PRs, trigger cloud builds, and read build logs.' },
      { name: 'Terminal tab', where: 'Workspace → Terminal', usage: 'Requires "Editable" mode with command execution on; unavailable with an external folder (a shell without root cannot reach it).' },
    ],
    note:
      'Command execution and Python both **really run on your device** — they can read or even delete sandbox files and may access the network. '
      + 'Every run is confirmed separately, but only enable this when you trust the current character and model.',
  },
  {
    id: 'mcp-server',
    title: 'MCP servers (external tools)',
    icon: 'extension-puzzle-outline',
    image: 'mcp',
    summary: 'Bring tools from third-party MCP servers into the app so the assistant can call them.',
    intro:
      'MCP (Model Context Protocol) lets models call external tools. EasyChat2 acts as a client: '
      + 'it connects to remote HTTP MCP servers you host or trust and wires their tools into the conversation.',
    steps: [
      'Open "Settings" and find the "MCP servers" card.',
      'Tap "Add a server" and fill in the server address (remote HTTP) and auth info.',
      'Tap "Test connection" to fetch the server\'s tool catalog and confirm the tool list shows up.',
      'Check each tool\'s risk tier: read-only tools run directly; every other tool asks for your confirmation per call.',
      'Back in chat, the assistant calls these tools when needed; you see a parameter preview before each call.',
    ],
    items: [
      { name: 'Add a server', where: 'Settings → MCP servers', usage: 'Fill in the remote HTTP address and auth headers; save to connect.' },
      { name: 'Test connection', where: 'Settings → MCP servers → Test connection', usage: 'Handshakes and fetches the tool catalog; failures show the reason.' },
      { name: 'Risk tiers', where: 'Tool entries', usage: 'Read-only tools run directly; write and execution tiers ask per call; deletion / force-push / admin operations are permanently forbidden even after confirmation.' },
      { name: 'Call preview', where: 'When a tool is called', usage: 'A parameter preview comes first (no side effects); execution happens only after you confirm.' },
    ],
    note:
      'The safety boundary is deliberate: a third-party server\'s toolset is unknown, so everything except read-only asks per call, '
      + 'and deletion-class operations are permanently forbidden — one accidental confirmation must never cause irreversible damage.',
  },
  {
    id: 'music',
    title: 'Music library',
    icon: 'musical-notes-outline',
    image: 'music',
    summary: 'Import local music and listen — and chat — together with your character.',
    intro:
      'The music library imports local audio files from your phone. While playing you can turn on "Listen together" — '
      + 'the character talks about the current track, like listening side by side.',
    steps: [
      'Open the Extensions tab and tap "Music" in the "Library" group.',
      'Tap the import button and pick audio files from your phone to add them to the library.',
      'Tap any track to start playing; pause, skip, and scrub as you like.',
      'For company, turn on "Listen together" — the character will chime in about the current track.',
      'Long-press a track or use the row\'s action button to delete it.',
    ],
    items: [
      { name: 'Import music', where: 'Extensions → Music → Import', usage: 'Pick local audio files from the phone to add to the library.' },
      { name: 'Playback controls', where: 'Music player bar', usage: 'Play / pause, previous / next, and scrubbing.' },
      { name: 'Listen together', where: 'Music screen switch', usage: 'When on, the character comments on the current track.' },
      { name: 'Delete track', where: 'Track row actions', usage: 'Remove the track from the music library.' },
    ],
    note: 'Music files stay on this device and are never uploaded; re-import them after switching devices.',
  },
  {
    id: 'books',
    title: 'Books & reading together',
    icon: 'book-outline',
    image: 'books',
    summary: 'Import local novels and read — and comment — together with your character.',
    intro:
      'The bookshelf imports books in txt / md / docx / html and splits chapters automatically. While reading you can turn on companion mode, '
      + 'and the character will discuss the current chapter with you.',
    steps: [
      'Open the Extensions tab and tap "Books" in the "Library" group.',
      'Tap the import button and pick a local file; the app parses it and splits chapters automatically.',
      'Tap a book to enter the reader and use the chapter list to jump anywhere.',
      'For company, turn on companion mode — the character will chime in about the current chapter.',
      'Reading progress is saved automatically; next time you open the book you resume where you left off.',
    ],
    items: [
      { name: 'Import book', where: 'Extensions → Books → Import', usage: 'Supports txt / md / docx / html with automatic chapter splitting.' },
      { name: 'Chapter list', where: 'Reader → Chapters', usage: 'Jump to any chapter.' },
      { name: 'Reading together', where: 'Reader switch', usage: 'When on, the character comments on the current chapter.' },
      { name: 'Reading progress', where: 'Saved automatically', usage: 'Reopening a book returns to your last position.' },
    ],
    note: 'Book text stays on this device; very large files may take a few seconds to parse the first time.',
  },
  {
    id: 'world-map',
    title: 'World map',
    icon: 'map-outline',
    image: 'map',
    summary: 'Set up homes for yourself and your characters on a grid map, and arrange who lives where.',
    intro:
      'The world map is a grid space where you place houses for yourself and your characters and decide who lives where. '
      + 'Living together is judged by "residence", not "ownership" — if you own several houses, the one you actually live in counts.',
    steps: [
      'Open the Extensions tab and tap "Map" in the "Library" group.',
      'Pick a spot on the map, place a house, and name it.',
      'Set your own residence to one of the houses.',
      'Assign residences to characters, or let them live with you.',
      'Tap a house to see its residents, rename it, or remove it.',
    ],
    items: [
      { name: 'Place a house', where: 'World map → grid', usage: 'Create and name a house on a grid cell.' },
      { name: 'Set residence', where: 'House details', usage: 'Make yourself or a character a resident of that house.' },
      { name: 'Living together', where: 'Automatic', usage: 'Judged by residence, not ownership: with several houses owned, the one actually lived in counts, regardless of order.' },
      { name: 'Edit & remove', where: 'House details', usage: 'Rename, change residents, or delete the location.' },
    ],
  },
  {
    id: 'voice-input',
    title: 'Voice playback & speech to text',
    icon: 'mic-outline',
    images: [
      { key: 'voice-tts', caption: 'Voice playback: pick the engine (system / cloud providers), fill in endpoint and key, and choose a voice.' },
      { key: 'voice-asr', caption: 'Speech to text: optionally reuse the current chat source, or configure a separate provider and model for transcription.' },
    ],
    summary: 'Have the assistant read replies aloud, and turn your recordings into text messages.',
    intro:
      'Voice works in two directions: **playback** reads assistant replies aloud (TTS), and **transcription** turns your recordings into text messages (ASR). '
      + 'They are configured independently — you can use just one.',
    steps: [
      'To toggle playback quickly in chat, tap "Playback on / off" at the top.',
      'To configure the voice engine, open "Settings → Voice Playback" and choose a cloud engine or the system voice, then fill in the required key.',
      'To use voice input, tap the mic button in the input bar to start recording, and tap again to finish.',
      'The transcript lands in the input box; edit it before sending if you like.',
      'If transcription is not working, check the service and key configuration under "Settings → Speech to text".',
    ],
    items: [
      { name: 'Playback switch', where: 'Top of chat: "Playback on / off"', usage: 'Quickly control whether assistant replies are read aloud.' },
      { name: 'Playback engine', where: 'Settings → Voice Playback', usage: 'Choose a cloud engine or the system voice; cloud engines need a key.' },
      { name: 'Record & transcribe', where: 'Mic button in the input bar', usage: 'Recording is transcribed into text and filled into the input box when you finish.' },
      { name: 'Transcription service', where: 'Settings → Speech to text', usage: 'Configure the ASR service and key; without it, transcription cannot run.' },
    ],
    note: 'With cloud engines, your audio or text is sent to the corresponding provider; system-voice-only playback never goes online.',
  },
  {
    id: 'security',
    title: 'Privacy & app lock',
    icon: 'lock-closed-outline',
    image: 'security',
    summary: 'Lock the whole app — or just individual characters.',
    intro:
      'Privacy & Security provides three layers: the **app lock** (verified on cold start or returning from background), '
      + '**per-character locks** (verification needed to enter specific characters), and **batch locking** (lock many characters at once).',
    steps: [
      'Open "Settings → Privacy & Security".',
      'Enable "App lock (biometric)" — the device must already have a fingerprint, face, or lock-screen password set up.',
      'To lock a single character, enable the lock on that character\'s entry and set a password.',
      'To lock several at once, use "Batch settings (multi-select / select all)".',
      'You can set a password hint so you don\'t get locked out by a forgetful moment.',
    ],
    items: [
      { name: 'App lock', where: 'Settings → Privacy & Security → App lock (biometric)', usage: 'Cold start or returning from background requires fingerprint / face / system password verification.' },
      { name: 'Per-character lock', where: 'Character entry → lock', usage: 'Entering that character requires verification; good for protecting only a few.' },
      { name: 'Batch locking', where: 'Settings → Privacy & Security → Batch settings', usage: 'Multi-select or select all characters and lock them in one go.' },
      { name: 'Password hint', where: 'Settings → Privacy & Security → Password hint', usage: 'Set a hint for the lock password to check when you forget it.' },
    ],
    note:
      'The app lock relies on the system\'s biometric / lock-screen verification. It cannot be enabled when the device has no screen-lock protection at all — '
      + 'set up any one first (a lock-screen password alone works); when recognition fails you can fall back to the password in the dialog.',
  },
  {
    id: 'proactive',
    title: 'Proactive messages',
    icon: 'chatbubbles-outline',
    images: [
      { key: 'proactive', caption: 'Top: global defaults (message source, model, character); below: per-character time slots.' },
      { key: 'proactive-time', caption: 'Expanding a time slot: choose "Normal / Exact", random windows, and style weights; custom texts are normalized by weight.' },
    ],
    summary: 'Let characters message you first at times you set.',
    intro:
      'With proactive messages on, characters will message you during the time windows you set, without you speaking first. '
      + 'Each character has its own windows and limits.',
    steps: [
      'Open the Extensions tab and tap "Proactive" in the "Daily companion" group.',
      'Choose the characters to enable and add the time windows when they may speak up.',
      'Set a daily cap per character to avoid being overwhelmed.',
      'When the time comes, the character messages you based on recent conversation memory, and you can simply reply to continue.',
      'Turn a character off from its entry whenever you don\'t want it.',
    ],
    items: [
      { name: 'Enable characters', where: 'Extensions → Proactive', usage: 'Choose which characters may message you first.' },
      { name: 'Time windows', where: 'Character entry → windows', usage: 'Set the time ranges allowed for proactive messages; add as many as you like.' },
      { name: 'Daily cap', where: 'Character entry → limit', usage: 'Limit how many proactive messages per day to avoid disturbance.' },
    ],
    note: 'Proactive messages fire within the windows you set; long screen-off periods or background restrictions may delay them.',
  },
  {
    id: 'agent-task',
    title: 'Scheduled tasks',
    icon: 'alarm-outline',
    image: 'schedule',
    summary: 'Have a character complete a task autonomously at a fixed time each day.',
    intro:
      'Scheduled tasks let a character autonomously complete one thing you assign at a fixed time each day — for example summarizing '
      + 'yesterday\'s chat points or writing a short daily recap. The task really calls the model and tools, then reports back with the result.',
    steps: [
      'Open the Extensions tab and tap "Schedule" in the "Daily companion" group.',
      'Tap create, pick a character, and set the execution time.',
      'Write the task (e.g. "organize today\'s chat into three key points").',
      'If needed, specify the tools available so the task can read and write workspace files.',
      'After saving, it runs automatically at the set time; execution records and results are viewable at any moment.',
    ],
    items: [
      { name: 'Create task', where: 'Extensions → Schedule → Create', usage: 'Pick a character and set the time and task content.' },
      { name: 'Task content', where: 'Task editor', usage: 'Describe in plain language what the character should do.' },
      { name: 'Available tools', where: 'Task editor', usage: 'Specify which tools the task may call (e.g. reading and writing workspace files).' },
      { name: 'Execution records', where: 'Task entry → records', usage: 'See when each run happened and what it produced.' },
    ],
    note:
      'A task really runs the model and tools and usually takes ten-odd seconds to a minute. It does not interfere with normal chatting — '
      + 'the two are measured separately in the app.',
  },
  {
    id: 'diary',
    title: 'Diary',
    icon: 'journal-outline',
    image: 'diary',
    summary: 'Characters write a diary about your conversations.',
    intro:
      'With the diary on, when the day rolls over the character writes an entry about what you talked about that day. '
      + 'A diary entry is the character\'s own retrospective — not a copy of the chat log.',
    steps: [
      'Open the Extensions tab and tap "Diary" in the "Daily companion" group.',
      'Enable the feature for the characters you want diaries from.',
      'After midnight the character generates that day\'s diary automatically.',
      'Tap an entry to read the full text.',
      'Turn it off on the character when you no longer want it.',
    ],
    items: [
      { name: 'Enable diary', where: 'Extensions → Diary', usage: 'Enabled per character; only enabled characters get entries.' },
      { name: 'Read diary', where: 'Extensions → Diary → entries', usage: 'Read the complete entry for a given day.' },
      { name: 'Disable diary', where: 'Extensions → Diary → character entry', usage: 'Once off, no new entries are generated for that character; existing ones are kept.' },
      { name: 'When it generates', where: 'Automatically at day rollover', usage: 'Characters with conversation that day get an entry — no manual trigger needed.' },
    ],
    note: 'Diaries generate at day rollover and require actual conversation that day; idle days produce nothing.',
  },
  {
    id: 'plugin',
    title: 'Plugins',
    icon: 'git-branch-outline',
    image: 'plugin',
    summary: 'Install plugins to extend the app\'s tools and UI without rebuilding.',
    intro:
      'Plugins add new tools or UI capabilities to the app. Once installed, what a plugin provides is immediately usable — '
      + 'no need to rebuild the app.',
    steps: [
      'Open the Extensions tab and tap "Plugins" in the "Daily companion" group.',
      'Tap install and choose a plugin package or fill in a source.',
      'Enable it in the list once installation finishes.',
      'Tools a plugin provides appear among the assistant\'s available tools; UI extensions appear where they belong.',
      'Disable or uninstall when you no longer need it.',
    ],
    items: [
      { name: 'Install plugin', where: 'Extensions → Plugins → Install', usage: 'Import a plugin package and finish installing.' },
      { name: 'Enable / disable', where: 'Plugin entry switch', usage: 'Control whether the plugin takes effect.' },
      { name: 'Uninstall', where: 'Plugin entry actions', usage: 'Remove the plugin and everything it provides.' },
    ],
    note:
      'Plugins can extend what the app can actually do (including tool calls), so only install plugins from sources you trust — '
      + 'installing one is equivalent to running third-party code on your device.',
  },
  {
    id: 'backup',
    title: 'Backup & restore',
    icon: 'cloud-download-outline',
    image: 'backup',
    summary: 'Export characters, sessions, and settings to a file; restore after switching devices or reinstalling.',
    intro:
      'All data lives on this device, so always back up before switching devices or reinstalling. There are two modes — '
      + 'full (everything, including media) and quick (core data like character cards and sessions only).',
    steps: [
      'Open "Settings → About → Backup & Restore".',
      'Choose "Full" or "Quick" export to get a backup file, and keep it somewhere safe.',
      'After switching devices or reinstalling, choose import from the same place.',
      'When the import finishes the app refreshes its data; if the refresh is reported as failed, restart the app to see the restored content.',
      'Before importing, back up the current data once — an import overwrites, and you\'ll want a way back.',
    ],
    items: [
      { name: 'Full export', where: 'Settings → About → Backup & Restore', usage: 'Everything, including media files; larger in size.' },
      { name: 'Quick export', where: 'Settings → About → Backup & Restore', usage: 'Core data only: character cards, sessions, memories.' },
      { name: 'Import & restore', where: 'Settings → About → Backup & Restore', usage: 'Restore from a backup file; it overwrites current content.' },
    ],
    note:
      'Backup files contain your chat history and character cards — keep them safe and don\'t share them around. '
      + 'Uninstalling the app wipes the in-app workspace and local data.',
  },
];

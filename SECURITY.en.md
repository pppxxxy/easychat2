# Security & Privacy Notice

**English** | [简体中文](./SECURITY.md)

This notice explains how EasyChat2 handles data, which permissions and dependencies it uses, and the risks of cleartext transport. Please read it in full before use.

## 1. Data & privacy: local-first, nothing collected

- This project has no backend and no account system; network requests are handled by the third-party services you configure. Chat requests originate from `src/api.js`; image generation, vector memory, TTS, web search, and settings-page checks may also reach the corresponding services when you actively enable or use them.
- No analytics, advertising, or telemetry SDKs are integrated; the developer receives, stores, and resells none of your data. The in-app "diagnostics log" only saves masked exception information locally (`@easychat2_diagnostics`) for you to view and copy yourself; it is never uploaded to any server.
- Metadata and settings are stored in on-device AsyncStorage; chat images, stickers, and large character bodies use files in the app documents directory. Keys and directories:

  | Storage key | Contents |
  |--------|------|
   | `@easychat2_api_config` | legacy single-API config, migrated reads only |
   | `@easychat2_api_configs` | multiple API profiles (keys live in system secure storage; this key holds references only) |
   | `@easychat2_character_index` + `@easychat2_character_item::<id>` | character library, lorebook, and regex scripts |
   | `@easychat2_messages::<sessionId>` | session messages (legacy per-character/single-session keys are migrated reads only) |
   | `@easychat2_session_draft::<sessionId>` | per-session input drafts (written only when "keep drafts" is on) |
   | `@easychat2_sticker_index` + `@easychat2_sticker_item::<id>` | sticker metadata |
   | `@easychat2_moments`, `@easychat2_diary_item::<id>`, `@easychat2_world_map`, `@easychat2_affinity` | moments, diary, world map, and affinity |
   | `@easychat2_vector_memory_configs`, `@easychat2_vector_index::<characterId>` | vector memory config and local index (including message-fragment vectors) |
   | `@easychat2_tts`, `@easychat2_transcription`, `@easychat2_image_gen`, `@easychat2_plugins` | TTS / transcription / image-generation / search settings (keys live in system secure storage; these keys hold references only) |
   | `@easychat2_local_model_index` + `@easychat2_local_model_item::<id>` | local model entries and parameters (model files themselves live in the on-device documents directory) |
   | `@easychat2_proactive_settings` | proactive message slot settings (the native side keeps a copy in EncryptedSharedPreferences) |
   | `@easychat2_music_index` + `@easychat2_music_item::<id>`, `@easychat2_music_comments::<songId>` | local music library (library and timeline markers) and listening-companion comments (comments appear only inside the panel, never in chat sessions) |
   | `@easychat2_books_index` + `@easychat2_books_item::<id>`, `@easychat2_book_comments::<bookId>` | local bookshelf (books, reading progress, and chapters) and reading-companion comments (comments appear only inside the panel, never in chat sessions) |
   | `@easychat2_screen_watch_comments` | screen-watch comments (with the on-device path of the matching screenshot; comments appear only inside the panel, never in chat sessions) |
   | `@easychat2_workspace` | workspace settings (mode ask/read/write, workspace folder location, command-execution switch, workspace character id); sandbox files themselves live on-device (default `documentDirectory/workspace/`, or an external folder you select in settings), not in this key |
   | `@easychat2_workspace_changes` | workspace change history (each tool/panel write, edit, or delete appends a record: path, type, time, and an edit excerpt — excerpts are truncated, on-device only, never uploaded); clearing history does not affect the files |
   | `@easychat2_location` | real-map share switch, location awareness switch (independent opt-in, off by default), the last successful fix (lat/lng, full description, and district-level coarse description), and an optional tile template; no fix is taken while off; **no location is sent to any model while location awareness is off** |
   | `@easychat2_diagnostics` | diagnostics log (last 50 masked exceptions), on-device only, never uploaded |
   | `documentDirectory/chat-images/`, `documentDirectory/stickers/` | image and sticker files |
   | `documentDirectory/voice/`, `documentDirectory/music/`, `documentDirectory/books/` | voice messages and character audio, imported local music, imported local books |
   | `documentDirectory/screen-watch/` | screen-watch screenshots (temporary runtime files: keeps the most recent 20 with rolling cleanup; **excluded from backups**) |
   | `documentDirectory/characters/`, `documentDirectory/card-forge/` | large bodies of oversized characters and card-forge drafts |

- Uninstalling the app or clearing its data removes all of the above; no copy exists on the developer side. Exported backups are yours to keep and contain characters, sessions, messages, and media; key fields are always blanked on export.
- Local book import parsing boundaries: `.txt`/`.md`/`.html` are decoded and tag-stripped locally (`<script>`/`<style>` are removed from `.html` first, and never executed); `.docx` is unzipped locally, **only `word/document.xml` is extracted, with a 32MB cap based on the decompressed size** (larger files are rejected), and no other entries (images, attachments) are extracted — this both avoids large-file memory pressure and blocks high-compression malicious documents (zip bombs). Files are written to `documentDirectory/books/` as UTF-8 and never leave the device; only when you tap "Let's talk about this page" in the bookshelf is the current page's text sent to **the model service you configured**.
- Local risks to be aware of:
  - API keys live in system secure storage (Android Keystore / iOS Keychain, `expo-secure-store`); AsyncStorage keeps only the `secure:v1:<id>` reference, never the plaintext. On older devices without secure storage (e.g. emulators without a lock screen) it transparently degrades to plaintext; the app's private directory is then protected by the OS sandbox, but rooted/jailbroken devices or debugging tools may still read it.
  - The app sets `android:allowBackup="false"`, so OS cloud backups exclude app data (including API keys).

### 1.1 Workspace: file location and command execution (please read carefully)

The workspace defaults to the app-private directory `documentDirectory/workspace/<character dir>/`, removed on uninstall. You can move it to **a folder on your phone** via "Settings → Workspace → Workspace folder" (Android uses the system folder picker / SAF, iOS uses the Files app; authorization is remembered by the OS and survives restarts on Android).

- **Scope of external-folder authorization**: once you pick a folder, the app gains read/write access to **that folder and all of its subdirectories** (this is the OS SAF grant granularity, not something the app widened). Character files are written under `<character dir>/`, but technically the app can read/write the rest of that folder too. Choose only a folder you are willing to let this app read/write; you can revoke it at any time via "Restore default" in the same place.
- **The app does not scan the folder on its own**: it reads/writes by path only when your conversation triggers workspace tools; it never enumerates or uploads other files.
- **Command execution (run_shell) is off by default**; it must be enabled separately in "Settings → Workspace", and enabling it shows an explicit risk confirmation dialog. Once enabled:
  - shell commands generated by the model **really execute on your device**; they can read, modify, or **delete** workspace files inside the app sandbox and may access the network (depending on the command);
  - **every command shows a per-command dialog with the full command text before running**; tapping "Deny" or closing the dialog means it never runs; "Stop generating" immediately terminates a running command;
  - the working directory is limited to the app-private workspace (`workspace/<character dir>/`). **A shell without root cannot access your chosen external folder**, so the feature is not registered and the switch unavailable when an external folder is selected;
  - it can only access the app's own sandbox and public paths like `/system/bin` — **not a full phone terminal** — and cannot read other apps' data.
- Only enable command execution when you trust the current character and the configured model. Even with per-command confirmation, a model can still craft a command you don't understand but that does harm (e.g. deleting the whole workspace) — treat every confirmation dialog as a real authorization decision.

## 2. Third-party API disclosure

EasyChat2 does not proxy or relay requests. When you send a message, the following go **directly** to the API address you entered (default `https://api.deepseek.com`):

- The system prompt (composed from character name, description, personality, scenario, system prompt, and post-history instructions; **when both "real map" and "location awareness" are on, it additionally includes one line of coarse location description — district level, no precise coordinates**)
- Matched lorebook entries
- Message history and current input
- Model name
- Auth headers: OpenAI-style uses `Authorization: Bearer <your API Key>`; the Anthropic protocol uses `x-api-key: <your API Key>` and `anthropic-version`

The actual operator of that address decides its logging, retention, data-residency, and compliance policies, all of which are unrelated to this project's developer. Read the provider's privacy policy and terms of service before use and verify its trustworthiness yourself. The default is an example only; you can point at any compatible service. "Settings → API Configuration" supports three protocols: **OpenAI Chat Completions** (`/v1/chat/completions`), **OpenAI Responses** (`/v1/responses`), and **Anthropic Messages** (`/v1/messages`); switching protocols switches the endpoint, auth headers, and request format accordingly.

Please use only the official API services of each platform. EasyChat2 does not provide shared API keys, proxy addresses, relay endpoints, or unofficial endpoints. All consequences of using unofficial channels, shared keys, or proxy services are borne by the user.

## 3. User content and responsibility

- You are solely responsible for the legality and rights of the character cards, lorebooks, and regex scripts you import, and of your chat content:
  - Confirm you own or are licensed to use imported content;
  - Respect the original card author's license (third-party character cards often carry the author's terms);
  - Do not publish or distribute unlawful, infringing, or harmful content.
- You must follow the usage policies of the API providers you choose, and bear the costs, rate limits, and account risks of your own calls.
- Model output may be inaccurate or biased; use your own judgment and do not treat it as professional advice.

## 4. Disclaimer: provided as-is, no warranty

This project is licensed under Apache-2.0 and provided "AS IS", without express or implied warranty, including but not limited to warranties of merchantability, fitness for a particular purpose, and non-infringement. To the maximum extent permitted by law, the author is not liable for any loss arising from the use of or inability to use this software, including data loss, expenses, account restrictions, or content and compliance issues. Full terms in [LICENSE](./LICENSE).

### Intended users and legal compliance notice

This app is an anthropomorphic AI interactive service. It does not provide minors with intimacy-oriented companionship services such as virtual partners or virtual family members. Where applicable law in your jurisdiction requires guardian consent before providing other anthropomorphic interactive services to minors (for example, users below the age of 14), such consent must be obtained. Users are solely responsible for ensuring that their use of this app complies with the laws and regulations of their own jurisdiction.

This notice is a legal-compliance statement. It does not modify or add restrictions to the Apache-2.0 license terms; the app remains licensed under Apache-2.0, and the rights granted by the license are unaffected by this notice.

## 5. Android permissions

The app uses the system file picker and system image picker and does not request legacy storage permissions; **the camera-attachment feature needs the camera permission** (see below). `expo-image-picker` declares the purpose strings for image picking and camera; Android's legacy media read/write permissions are excluded via `blockedPermissions`:

| Permission | Handling |
|------|------|
| `READ_EXTERNAL_STORAGE` | excluded; character cards and attachments use the system picker |
| `WRITE_EXTERNAL_STORAGE` | excluded |
| `READ_MEDIA_IMAGES`, `READ_MEDIA_VIDEO` | excluded; images are returned by the system picker per user selection |
| `MODIFY_AUDIO_SETTINGS` | excluded |

**Microphone (`RECORD_AUDIO`)**: required by voice messages, declared by the `expo-audio` plugin (`recordAudioAndroid:true`) with the purpose string "The microphone is needed to record voice messages". Requested by the system dialog only the first time you tap the mic to record; declining stops recording without affecting other features. **Voice messages unused = permission never requested.**

**Camera (`CAMERA`)**: required by the chat's "Add attachment → Take photo", declared by the `expo-image-picker` plugin with the purpose string "Take a photo to send in chat" (iOS: `NSCameraUsageDescription`). Requested only the first time you tap "Take photo"; declining closes the camera and prompts you to enable it in system settings, while gallery picking, voice, and everything else are unaffected. **Camera unused = permission never requested.** Note: on devices that once had a `cameraPermission:false` old build, the plugin wrote CAMERA as a blocked permission (`tools:node="remove"`), so the camera switch only reappears in system settings after uninstalling and reinstalling (or upgrading over it with a new release).

**Location (`ACCESS_COARSE_LOCATION`, `ACCESS_FINE_LOCATION`)**: required by the real-map feature, declared by the `expo-location` plugin with the purpose string "Get your current location so the character knows where you are and marks it on the real map (while in use only)" (iOS: `NSLocationWhenInUseUsageDescription`). **Foreground only, while in use only**; requested by the system dialog only when first enabling "Extensions → World → Map → Real map", **preceded by a privacy reminder (cancellable — cancelling means no fix is taken)**; declining keeps it off with a hint, and the grid map and everything else are unaffected. Turning the switch off stops fixes and clears map markers; if the system location service is off, an actionable "open location in system settings" hint appears; if the first fix times out/fails, the system's cached fix from the last 10 minutes is used as a fallback (aged by its real fix time). **Real map off = permission never requested and no location data obtained; sharing location with the model additionally requires turning on "location awareness" separately in settings (see below).**

**Proactive messages & notifications**: when proactive messages are on, the `withProactiveMessage` plugin declares the following permissions (not occupied while the feature is off):

| Permission | Purpose |
|------|------|
| `POST_NOTIFICATIONS` | send notifications on schedule (Android 13+ requires user grant) |
| `RECEIVE_BOOT_COMPLETED` | reschedule alarms after reboot so plans aren't lost |
| `SCHEDULE_EXACT_ALARM` | trigger precisely at the set time |
| `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_DATA_SYNC` | short foreground service at trigger time to persist the message |

After `expo prebuild`, the manifest retains:

| Permission | Source and purpose |
|------|-----------|
| `INTERNET` | required for API requests (`withLocalApiServer` also declares it for the local loopback service) |
| `POST_NOTIFICATIONS`, `RECEIVE_BOOT_COMPLETED`, `SCHEDULE_EXACT_ALARM`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_DATA_SYNC` | proactive messages (table above) |
| `RECORD_AUDIO` | voice message recording (above) |
| `CAMERA` | camera attachments (above) |
| `ACCESS_COARSE_LOCATION`, `ACCESS_FINE_LOCATION` | real location (foreground, while in use only, above) |
| `SYSTEM_ALERT_WINDOW`, `VIBRATE` | Expo / React Native template defaults, not needed by any app feature; can still be excluded via `blockedPermissions` (`SYSTEM_ALERT_WINDOW` relates to the dev menu — verify on a real device before deciding) |

Further hardening:

- `android:allowBackup="false"` keeps API keys and other data out of OS backups.
- Character card import uses the Storage Access Framework; no storage permission needed.
- Workspace file reads/writes default to the app-private sandbox (`workspace/<character dir>/`); after path normalization, `..`, absolute paths, and non-whitelisted extensions are rejected; with an external folder selected, access switches to per-URI SAF (see §1.1), still without legacy storage permissions.
- Command execution uses a standalone native module (`ShellExecutor`, spawning `/system/bin/sh -c` child processes) and **declares no extra permissions**: it only inherits the app's own sandbox permissions and cannot cross the app boundary.
- Verify the actual manifest of every release build before publishing, confirming no extra permissions were introduced.
- On iOS, the photo-library purpose string (system image picker), camera purpose string (camera attachments), and microphone purpose string (voice messages) are all requested via system dialogs on first use of the corresponding feature.

## 5.5 What each feature sends to third parties

Beyond chat requests, the following features — when you actively use them — send the content you designate directly to **the provider you configured yourself**. The developer does not participate in, record, or relay these requests:

| Feature | What is sent | On by default |
|------|---------|------------|
| Chat (incl. group chat) | system prompt, matched lorebook, message history and input (**including image/video attachments** — photos, gallery picks, and stickers go out as multimodal content when vision is on; **video is available only when the model declares "watch videos" and the OpenAI-compatible protocol is used**, sent as a base64 data URI to **the model service you configured**), model name, `Authorization` header | enabled once the API is configured |
| Listening together (companion comments) | system prompt, user profile and global presets, song title and current position (not the audio itself) | Extensions → World → Music, when marking or playing |
| Reading together (companion comments) | system prompt, user profile and global presets, book title and an excerpt of the current page (text only, ~600 chars max) | Extensions → World → Books, when tapping "Let's talk about this page" |
| Screen watch (companion comments) | system prompt, user profile and global presets, **the current screenshot**; in-app capture uses only this app's own screen; **with the floating window on, it captures across apps (including other apps' content)** | Extensions → World → Screen, when tapping "Show it to them" or the floating window's capture button |
| Real location | **only when both "real map share" and "location awareness" (Settings → Global Configuration, independent opt-ins) are on**, a coarse district-level location description goes into the chat system prompt to **the model service you configured** (if reverse geocoding fails it falls back to 2 decimals ≈ a 1.1km grid; precise lat/lng only annotates the local map, never sent); **tile requests go from the WebView straight to the map provider (default: Amap)** and contain no chat content or API keys | both switches off by default; requires manual enabling and location grant |
| Inline images / image generation | the prompt, plus optional source images (img2img) | off; enable manually |
| Text-to-speech (TTS) | the reply text to be read aloud (Markdown stripped) | off |
| Speech-to-text | the recorded audio file | when sending a voice message |
| Vector memory | message fragments (indexing) and retrieval queries (recall) | off |
| Web search | matched search keywords | off |
| Local models | nothing leaves the device (inference is local) | off |
| Local API service | nothing leaves the device; listens on `127.0.0.1` only, for same-device clients, with mandatory Bearer auth | off |

Do not send sensitive personal information such as ID numbers, bank card numbers, or passwords in any of the above. Read the provider's privacy policy before sending.

**Floating-window screen watch**: requires manually granting "Display over other apps" (`SYSTEM_ALERT_WINDOW`) in system settings plus the per-session capture consent (`MediaProjection`). While on, an Android foreground service (`foregroundServiceType="mediaProjection"`) captures **cross-app screens** and sends them directly to the selected vision model; closing the floating window, tapping the notification, or locking the screen stops capture and releases the projection. While active, a low-priority persistent notification is shown.

## 6. Dependencies and data behavior

The direct dependencies from `package.json` and their purposes; none were found to embed analytics or tracking. Actual versions and transitive dependencies are governed by `package-lock.json`.

| Dependency | Purpose |
|------|------|
| `@react-native-async-storage/async-storage` | local key-value storage |
| `@react-navigation/native`, `/bottom-tabs`, `/native-stack` | navigation |
| `buffer` | global `Buffer` shim required by `parsecard` |
| `expo` | runtime framework |
| `expo-clipboard` | copying error text |
| `expo-document-picker` | picking character card PNG / JSON files |
| `expo-file-system` | reading selected file contents |
| `expo-status-bar`, `expo-system-ui` | status bar and system UI |
| `graphql` | not referenced at runtime; needed by `@expo/cli` (build time), pinned for stable resolution |
| `parsecard` | parsing character card PNG / JSON |
| `react`, `react-native` | core frameworks |
| `react-native-gesture-handler`, `react-native-screens`, `react-native-safe-area-context` | gestures, native screens, safe areas |
| `react-native-markdown-display` | rendering assistant Markdown replies |
| `react-native-vector-icons` | icons |
| `@babel/core`, `@babel/preset-env` (devDependency) | build transpilation and Node test runs |
| `expo-image-picker`, `expo-image-manipulator` | picking, resizing, and processing local images/stickers |
| `expo-location` | foreground location and reverse geocoding (real-location feature) |

Run `npm audit` regularly and watch upstream security advisories.

## 7. HTTP cleartext transport risk

- The settings screen accepts `http://` addresses with a confirmation dialog before saving (see `src/SettingsScreen.js`).
- Risk: over a cleartext connection, **the API key and the entire conversation** may be intercepted or tampered with by third parties on the same network. Always prefer `https://`.
- The Expo Android template writes `android:usesCleartextTraffic="true"` by default; this project does not explicitly disable it, so whether the release build permits cleartext depends on the generated manifest and target-OS policy — verify the actual manifest before release, and prefer disabling cleartext traffic once you've confirmed all services are `https://`.
- Error messages are masked by `maskSecrets` in `src/storage/secrets.js` before display and copying (covering `sk-...` and `Bearer ...`), but other context may remain — re-check before sharing logs publicly.
- Local chat history and API config are stored as plaintext JSON, unencrypted.

## 7.5 GitHub MCP connection (added in z1005z2)

"Settings → Workspace" card's "GitHub connection (MCP)" connects the GitHub remote MCP server to workspace characters. Disclosure:

- **Credentials**: the access token (PAT) or the three OAuth fields (`githubToken`/`githubAccessToken`/`githubRefreshToken`) are automatically moved into system secure storage (Android Keystore) by the storage boundary; AsyncStorage keeps references only. Tokens never enter logs or model context.
- **Network**: connection verification and tool calls connect directly from the device to the MCP endpoint (default `https://api.githubcopilot.com/mcp/`, changeable, https only); web authentication also visits GitHub's authorization page and carries a PKCE authorization-code callback (`easychat2://` scheme). All requests carry `Authorization: Bearer <token>`.
- **Risk tiers (highest constraint, user decision 2026-10-05)**: tools use a whitelist with tiers — read-only tools are directly available; commit/push/branch-create/comment-class tools require per-call user confirmation (a dialog shows the full parameters; denying means not executing); **branch deletion, file deletion, force push, and admin operations are unconditionally forbidden**: not registered, not exposed to the model, and re-checked at the execution layer — **unlockable even with user consent**, with no switch or backdoor. Unclassified new tools default to denial.
- **Double gate**: `src/mcp/riskGate.js` decides registration, and `src/workspace/mcpTools.js` re-checks the tier before every execution; besides `tests/namedImportSanity.test.mjs`, `tests/mcpTools.test.mjs` pins the hard-forbidden behavior.
- **Model visibility**: only tools that pass the tiers appear in the model's tool list; tool output is truncated to 16K characters to protect context.

## 8. Reporting vulnerabilities

Please report security issues via the repository Issues (https://github.com/pppxxxy/easychat2/issues), or contact the owner privately via the contact info on the repository page. Do not paste real API keys or other people's private data into public issues.

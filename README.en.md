# EasyChat2

**English** | [简体中文](./README.md)

**Current version: v1.0.1 (beta)**

v1.0.1 is a beta release distributed separately to invited testers only; it is not publicly downloadable from this repository. If you received an installer package, please read the beta disclaimer first.

EasyChat2 is a mobile AI chat app built on Expo + React Native. It has no backend of its own: it connects directly to any OpenAI Chat Completions–compatible endpoint, and all settings, characters, and chat history are stored locally on your device.

## Features

- **OpenAI-compatible**: works with OpenAI, DeepSeek, and any OpenAI Chat Completions–compatible endpoint; requests are sent by the app to the address you configure.
- **Multiple API profiles**: save, switch, and edit multiple sets of "endpoint + model + key", with one-tap model list retrieval.
- **Character library**: create, edit, and delete characters; switch the active character from the top of the chat screen at any time.
- **Character card import**: import persona, lorebook, and regex scripts from PNG or JSON character cards.
- **AI card forge**: the "Card Forge" page on the Extensions tab generates character cards (with lorebook, regex scripts, and text presets) through Q&A with AI; generated cards can be imported into the library for further editing. AI-generated cards carry a generation badge, and exported files embed provenance metadata.
- **Lorebook & regex**: the lorebook injects entries into the prompt by keyword before sending; regex scripts can apply separately at send time and at display time.
- **Markdown rendering**: assistant replies render as Markdown; user and error messages stay plain text.
- **User persona & global presets**: configure your name and avatar, and maintain appended prompts that apply to all conversations.
- **Session isolation**: chat history is stored per session; switching characters or sessions aborts in-flight requests and discards late replies.
- **Images & stickers**: image attachments become media messages; stickers can be added from your gallery, zoomed, and reused.
- **Rich HTML & large cards**: supports large local character files, standalone HTML greetings, CSP restrictions, and full-width message layout.
- **Copyable errors**: request failures appear as collapsible bubbles; suspected keys are masked before copying.
- **AI image generation**: the "Image Gen" page on the Extensions tab generates images from prompts, supporting multiple online providers and local models (e.g. Local Dream); results can be saved, turned into stickers, or resent; characters can inline images in replies.
- **Voice**: assistant replies can be read aloud via TTS (multiple cloud engines and system voices); you can record audio and transcribe it into messages.
- **Local models**: optional `llama.rn` native build for on-device offline inference (including multimodal), plus a local OpenAI-compatible API service for other clients.
- **Vector memory**: conversation fragments are vectorized and recalled by relevance into context.
- **Web search**: search keywords are sent to the search service you choose, and results are injected into the conversation.
- **Diary**: after midnight, characters with the feature enabled get an auto-generated diary for the day.
- **Moments**: characters post updates; they can comment and "reply along".
- **World map**: a grid map on the Extensions tab's "World" view, where you can place houses and residents for yourself or characters.
- **Bookshelf / music library**: import local txt/md/docx/html books and local audio; characters can read along, listen, and comment.
- **Screen watch**: take an in-app screenshot and have a vision model comment on it.
- **Workspace & agent tools**: point the workspace at the app sandbox or a system folder you choose; read/write text and Markdown and export Word in "ask / read-only / writable" modes; "writable" mode plus a separate switch enables shell commands and Python (each execution requires per-command confirmation).
- **MCP servers**: connect remote HTTP MCP servers to bring third-party tools into the conversation. Read-only tools run directly; every other tool call needs confirmation, and deletion-class operations are permanently forbidden even after confirmation.
- **Privacy & security**: app lock (biometrics), per-character locks, batch locking, and password hints.
- **Proactive messages & scheduled tasks**: characters can message you proactively during configured time windows; they can also autonomously complete a task on a daily schedule (real model and tool calls).
- **Plugins**: install plugins to extend tools and UI capabilities without rebuilding the app.
- **Backup & restore**: full and quick export modes, covering character cards, sessions, memories, and media files.
- **In-app tutorial & update notices**: a built-in 29-chapter illustrated tutorial; version release notes are shown from GitHub Releases.
- **Bilingual UI**: Simplified Chinese / English.

## Requirements

- Node.js 22 (the CI version)
- A phone with Expo Go (for debugging), or a prebuilt APK
- A working OpenAI Chat Completions–compatible API endpoint and key

## Quick start

```bash
npm install
npm run start
```

Scan the QR code in the terminal with Expo Go to debug on a real device. If dependency installation hits peer conflicts, the repo's `.npmrc` already sets `legacy-peer-deps=true` — just keep the defaults.

Common scripts:

```bash
npm run start        # start the Expo dev server
npm run android      # open directly on Android
npm run prebuild     # expo prebuild --clean, regenerate android/
npm run build:apk    # EAS preview APK build
```

> This project ships `npm test` Node regression tests; native modules, WebView, permissions, and touch interactions still require running `npm run start` and manually walking the affected paths.

## Usage guide

The app consists of five bottom tabs: Chat / Memory / Characters / Extensions / Settings.

### 1. Configure the API

Open the "Settings" tab and fill in the "API Configuration" card:

| Field | Description |
|------|------|
| **API endpoint** | An OpenAI-compatible URL, e.g. `https://api.deepseek.com` |
| **Model** | A model name, e.g. `deepseek-chat`, `gpt-4o` |
| **API Key** | The corresponding key. It is stored in system secure storage (`expo-secure-store`, Android Keystore / iOS Keychain); AsyncStorage keeps only a reference. On older devices where secure storage is unavailable, it degrades to plaintext (see [SECURITY.en.md](./SECURITY.en.md)) |

Multiple profiles can be saved and switched at any time; once filled in, you can fetch the available model list and pick one directly.

> If the API endpoint uses the `http://` scheme, a confirmation dialog appears on save — over an unencrypted connection the API Key risks plaintext leakage.

The same screen also configures "User Persona" (your name and avatar) and "Conversation Presets" (appended prompts that apply to all characters).

### 2. Characters

Manage your character library on the "Characters" tab:

- Create characters and edit their name, greeting, system prompt, description, personality, scenario, and other fields.
- Import character cards: PNG (with embedded `chara` data) and JSON formats are supported; lorebook and regex scripts are parsed along with the card.
- Switch the active character from the character capsule at the top of the chat screen.

### 3. Chat

Return to the Chat tab and start talking:

- Assistant replies render as Markdown; code blocks use a monospace font.
- Each message offers "Copy" and "Select text"; user text messages support "Edit & resend" (with a confirmation of the retraction scope), and assistant messages support "Regenerate".
- The input bar accepts image or text attachments; images and text are sent as a media message followed by a text message; the smiley button on the right opens the sticker panel.
- With "Settings → Global Configuration → Full-width chat" enabled, character avatars and names sit above the message, the avatar to the left of the name, and the message bubble spans the full chat width.
- "⋯ → Notice" in the top menu shows the disclaimer at any time; "Clear" near the input bar deletes the current session's messages.

> **Two easily confused entries**: "⋯ → Notice" on the chat screen opens the **disclaimer**; **version release notes** live in "Settings → About → Release Notes". The latter is fetched from GitHub Releases; when a new version exists you are prompted once, and "Don't remind me about this version" silences that version (the next one still prompts).

## In-app tutorial

A built-in **29-chapter** illustrated tutorial covers everything from configuring the API and importing character cards to the workspace, MCP, voice, the app lock, and backup/restore. The same content is reachable from three places:

| Entry | Location |
|---|---|
| First launch | via "Disclaimer → Onboarding" on first start |
| Settings | Settings → About → Tutorial |
| Workspace | Workspace → Settings → Help |

Each chapter contains: a one-line summary, step-by-step instructions, a "location → path" quick-reference table, and notes. Every path in the tutorial matches real on-screen wording so you can follow along; chapters whose screenshots are not yet registered skip images automatically without affecting reading.

## Security & privacy

- No backend, no data collection; settings, characters, and chat history live only in on-device `AsyncStorage`.
- Chat content and API keys are sent directly to the third-party API address you enter — verify its trustworthiness yourself.
- Please use only the official API services of each platform. EasyChat2 does not provide shared API keys, proxy addresses, relay endpoints, or unofficial endpoints. All consequences of using unofficial channels, shared keys, or proxy services are borne by the user.
- You are responsible for the legality of imported and generated content; the software is provided as-is, without any warranty.
- The app does not request runtime permissions proactively, and storage-related permissions are excluded; see the security notice for details.

The full notice is in [SECURITY.en.md](./SECURITY.en.md), covering local storage keys, Android permissions, dependency behavior, and the `http://` cleartext risk.

## Building the APK

The repository provides two build paths, both triggered manually in GitHub Actions (`workflow_dispatch`):

1. **Build APK on GitHub** (`build-apk-github.yml`): `prebuild` + Gradle release APK on a GitHub runner, with no EAS dependency. Download `easychat2-apk` from the run's Artifacts when done.
2. **Build APK** (`build-apk.yml`): calls Expo EAS cloud builds. Requires `EXPO_TOKEN` in the repository Secrets.

### Triggering with GitHub Desktop (recommended for Build APK on GitHub)

GitHub Desktop can only open the repository page; triggering the build happens in the browser:

1. In GitHub Desktop, click **Repository → View on GitHub** (`Ctrl+Alt+G` / `Cmd+Alt+G`) to open the repository page.
2. Open the build workflow page directly: `https://github.com/pppxxxy/easychat2/actions/workflows/build-apk-github.yml`
3. Click the **Run workflow** dropdown on the right, confirm the branch is `main`, then click the green **Run workflow** button.
4. Refresh and wait for the run to turn green (about 10–15 minutes).
5. Open that run and download `easychat2-apk` (a zip) from **Artifacts** at the bottom; unzip to get `app-release.apk` and install it on your phone.

> Build APK on GitHub needs no tokens; if prompted to grant workflow permissions on the first run, allow them.

You can also build a preview package locally (EAS CLI required):

```bash
npm install -g eas-cli
npm run build:apk
```

## Tech stack

- React 19.1.0 / React Native 0.81.5 / Expo SDK ~54 (New Architecture, interop layer for legacy native modules)
- Navigation: `@react-navigation/native` + `@react-navigation/bottom-tabs`
- Rich text: `react-native-markdown-display` (assistant Markdown), `react-native-render-html` (rich HTML cards)
- Icons: `@expo/vector-icons` (Ionicons)
- Storage: `@react-native-async-storage/async-storage`, `expo-sqlite` (large-value read fallback), `expo-secure-store` (keys)
- Local models: `llama.rn` (optional native build)
- Character card parsing: `parsecard`
- Bundling: Metro (with `unstable_enablePackageExports` to resolve `parsecard`'s ESM exports)

> Versions are authoritative in `package.json`; the list above is a snapshot taken when this document was written.

## Project structure

```
easychat2/
├── App.js                  # app entry: shims, navigation container, global providers, startup bridge
├── app.json                # Expo metadata, config plugins, Android permissions
├── eas.json                # EAS Build configuration
├── metro.config.js         # Metro bundler config (package exports enabled)
├── plugins/                # local config plugins: native module injection (proactive messages / local API / command execution)
├── assets/                 # icons, adaptive icons, splash
├── src/                    # app code: ~25 domain subdirectories + screen entries
│   ├── ChatScreen.js       # chat entry (UI details live in src/chat/)
│   ├── character/          # character domain: CharacterStack (library ⇄ detail) + list/detail screens + card parsing and export
│   ├── SettingsScreen.js   # settings
│   ├── ...                 # remaining screens (memory / extensions / search / image gen / panels)
│   └── <domain>/           # agent / storage / chat / workspace / localModel / moments / ...
└── .github/workflows/      # CI (unit test gate + Kotlin compile + APK builds)
```

> The full module map lives in `.monkeycode/docs/INTERFACES.md` and the "Architecture map" section of `AGENTS.md`.

## Documentation

- Architecture & modules: `.monkeycode/docs/INDEX.md`
- Security & privacy notice: [SECURITY.en.md](./SECURITY.en.md) (Simplified Chinese: [SECURITY.md](./SECURITY.md))
- Development conventions: [AGENTS.md](./AGENTS.md)

## Disclaimer

This project is provided for technical learning and exchange only. It does not constitute legal advice of any kind, nor a recommendation of any third-party service. Users assume all risks. This software is provided "AS IS", without any guarantee that it is interruption-free, error-free, or will meet your needs.

### Intended users and legal compliance notice

This app is an anthropomorphic AI interactive service. It does not provide minors with intimacy-oriented companionship services such as virtual partners or virtual family members. Where applicable law in your jurisdiction requires guardian consent before providing other anthropomorphic interactive services to minors (for example, users below the age of 14), such consent must be obtained. Users are solely responsible for ensuring that their use of this app complies with the laws and regulations of their own jurisdiction.

This notice is a legal-compliance statement. It does not modify or add restrictions to the Apache-2.0 license terms; the app remains licensed under Apache-2.0, and the rights granted by the license are unaffected by this notice.

### Acceptable use

You must not use this software for any unlawful activity, including but not limited to disseminating pornographic, obscene, violent, terrorist, gambling, drug-related, or fraudulent information, or infringing others' intellectual property, privacy, reputation, or other lawful rights and interests; nor may you interfere with or disrupt the normal operation of this software.

- Do not induce the AI to generate content that violates applicable laws and regulations.
- Do not use this software for commercial purposes such as resale, renting, lending, or otherwise profiting from it.

### Data & privacy

This software has no server and no account system, integrates no analytics, advertising, or telemetry SDKs, and **does not collect device identifiers** — the developer receives, stores, and resells none of your data. Your character cards, session messages, settings, and media files are stored entirely on your device, invisible to the developer; uninstalling the app or clearing its data deletes them, and no copy exists on the developer side.

You configure the API endpoint and key yourself, and all chat content is sent directly to the service address you specify. Beyond chat, the following features — when you actively use them — send the content you designate directly to the corresponding third-party service; you choose and authorize each one:

| Feature | What is sent |
|------|---------|
| Inline images & image generation | the prompt, plus optional source images |
| Text-to-speech | the text to be read aloud |
| Speech-to-text | the recorded audio |
| Vector memory | message fragments and retrieval queries |
| Web search | the search keywords |

Do not send sensitive personal information such as ID numbers, bank card numbers, or passwords in any of the above. Follow the usage policies of your API provider, and bear the costs and account risks of your own calls. The full list of permissions, storage keys, and cleartext-transport risks is in [SECURITY.en.md](./SECURITY.en.md).

Regarding third-party content such as character cards: this documentation only provides technical information and makes no guarantee as to the legality or safety of any third-party platform's content. Verify the copyright status of content yourself, avoid using unauthorized adaptations, and assume all risks of using third-party platforms.

### Limitation of liability

To the maximum extent permitted by applicable law, the developer is not liable for any direct, indirect, incidental, special, punitive, or consequential damages arising from the use of or inability to use this software (including but not limited to data loss, financial loss, account restrictions, or content and compliance issues), even if advised of the possibility of such damages. Third-party AI providers' availability, terms-of-service changes, or shutdowns may render part or all of this software unusable; the developer bears no responsibility for this. AI replies do not represent the developer's views, positions, or advice — judge their reasonableness yourself.

### Changes to these terms

The developer reserves the right to modify these terms at any time; modified terms take effect with software updates and are re-prompted in the app. If you violate the rules above, the developer may stop providing software updates and support. The in-app terms are as shown in "Settings → About → Disclaimer" and the first-launch dialog.

## AI-generated content compliance

Character card generation (AI card forge), chat replies, moments, and inline images in EasyChat2 are all AI-generated content. To meet labeling requirements for AI-generated content under applicable regulations, the following measures are implemented:

- **Explicit labeling**: AI-generation surfaces (card forge, card editor, the AI-generated badge on character pages) display a "This content is AI-generated" notice; the chat screen permanently shows "AI output may be wrong; for reference only".
- **Implicit labeling**: AI-generated character cards embed provenance metadata in the exported file (`extensions.easychat2.aigc_meta`: generating tool, content id, timestamp, and model) and append a visible generated-content line at the end of `creator_notes`, so the content can be identified and traced.
- **Risk disclosure**: AI-generated content may be inaccurate or incomplete, or may resemble well-known IPs or copyrighted works; results are screened against common IP keywords but not exhaustively. Review and confirm you have the rights before using or redistributing.
- **Label preservation**: do not remove, tamper with, or conceal AI-generated labels (explicit or implicit) before redistribution; you bear the legal consequences of redistributing content with its labels removed.

### Infringement complaints

If you believe content in this repository or generated by this app infringes your lawful rights, please file a complaint via [GitHub Issues](https://github.com/pppxxxy/easychat2/issues) (include proof of rights, the location of the reported content, and contact information). Upon receiving a valid notice, the content will be removed or blocked promptly.

### Forks and DMCA

This project is open-sourced under Apache-2.0. If someone forks this project, removes the AI-generated labeling functionality, and distributes infringing content, the repository owner reserves the right to request a takedown of that fork under GitHub's DMCA policy (including the §512 safe-harbor mechanism).

## License

This project is licensed under **Apache-2.0** and provided "AS IS", without express or implied warranty. The full terms are in [LICENSE](./LICENSE).

### License Change Notice

This project was previously licensed under AGPL-3.0. As of 2026-09-27 it has switched to Apache 2.0 to better integrate third-party commercial SDKs and foster community growth. Versions released before that date remain governed by AGPL-3.0.

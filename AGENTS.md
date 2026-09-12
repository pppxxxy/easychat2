# AGENTS.md

## Project

EasyChat2: single-device Expo SDK 50 / React Native 0.73 AI chat app. No backend. Talks to any OpenAI-compatible Chat Completions endpoint. All state lives in on-device AsyncStorage.

## Commands

```bash
npm install          # local install
npm ci               # what CI uses; lockfile must stay in sync
npm run start        # Expo dev server (primary verification path)
npm run android      # open on Android
npm run prebuild     # expo prebuild --clean, regenerates android/
npm run build:apk    # EAS preview APK
```

- There is **no** lint, typecheck, or test runner in this repo. Do not invent `npm test`/`npm run lint`. Verify by running `npm run start` and exercising the changed path manually, plus `npm ci` for dependency integrity.
- `.npmrc` sets `legacy-peer-deps=true`; keep it.
- APK builds are manual `workflow_dispatch` only. Workflows: `build-apk-github.yml` (Gradle, signs release with the debug keystore) and `build-apk.yml` (EAS, needs `EXPO_TOKEN`).
- CI uses Node 20 and Java 17.

## Non-obvious constraints

- `src/polyfills.js` **must stay the first import in `App.js`**, before `react-native-gesture-handler`. `parsecard` needs a global `Buffer`; ES module hoisting breaks it if the import moves.
- `metro.config.js` enables `unstable_enablePackageExports = true` globally so Metro resolves `parsecard`'s ESM `exports`. This affects every dependency. Re-verify bundling after adding or upgrading deps.
- `android/` and `ios/` are gitignored generated output. Never hand-edit them; they are recreated by `expo prebuild --clean`.
- Context layers must not present UI. `AppContext.updateCharacter` rolls back state and rethrows; screens catch and show `Alert`. Keep it that way.
- Pending assistant placeholders (`pending: true`) must never be persisted. Both `storage.js` and `ChatScreen.js` filter them; preserve that in any new persistence path.
- Persisted error text is masked with `SECRET_PATTERN` (`sk-...` / `Bearer ...`). Unmasked error text lives only in the in-memory `errorRawRef`. Never write raw errors to storage or docs.
- Message storage is keyed per character: `@easychat2_messages::<characterId>`. The default character reads legacy key `@easychat2_messages` as a fallback. Changing key names needs a migration branch.
- `AppContext` uses `characterRef`/`loadedRef` to avoid stale closures; `updateCharacter` rejects writes before load completes. Preserve the ref pattern.
- When switching characters mid-request, the late reply/error is dropped via `activeCharacterIdRef`. Keep the guard.
- RN's `fetch` has no streamable `response.body`. Streaming goes through the built-in `XMLHttpRequest` `onprogress` + cumulative `responseText` in `api.js`. Do not switch it back to `fetch` or add an SSE library without verifying Metro bundling.

## Architecture map

- `App.js` — real entrypoint (package.json `main` points at Expo's AppEntry). Wraps `AppProvider`, bottom tabs: 聊天 / 角色 / 设置.
- `src/ChatScreen.js` — message list, send flow, Markdown assistant replies, error bubbles.
- `src/CharacterScreen.js` — character edit + SillyTavern PNG/JSON card import (`parsecard`).
- `src/SettingsScreen.js` — API `baseUrl` / `model` / `apiKey`; warns before saving `http://`.
- `src/api.js` — `sendChatMessage`, URL normalization, streaming via `XMLHttpRequest` SSE parsing (`onChunk`), 30s idle timeout.
- `src/storage.js` — all AsyncStorage access and defaults.
- `src/context/AppContext.js` — global character state (`useApp()`).
- `src/polyfills.js` — global Buffer shim.

Storage keys: `@easychat2_api_config`, `@easychat2_character`, `@easychat2_messages::<characterId>` (legacy: `@easychat2_messages`).

## Conventions

- Dark palette: bg `#1a1a2e`, surfaces `#2d2d44`, accent `#6c63ff`, muted `#aaa`. Each screen defines its own `StyleSheet.create` at the bottom.
- Only assistant messages render Markdown; user and error messages stay plain `Text`.
- Commit messages use Conventional Commits (`feat:`, `fix:`, `refactor:`, `chore:`, `docs:`). Main branch is `main`.
- Never commit or print real API keys or tokens; use placeholders.

## Docs

Generated project wiki lives in `.monkeycode/docs/` (`INDEX.md`, `ARCHITECTURE.md`, `INTERFACES.md`, `DEVELOPER_GUIDE.md`, plus concept and module pages). Keep it in sync when behavior changes.

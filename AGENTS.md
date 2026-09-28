# AGENTS.md

## Project

EasyChat2: single-device Expo SDK 50 / React Native 0.73 AI chat app. No backend. Talks to any OpenAI-compatible Chat Completions endpoint. Metadata and settings live in on-device AsyncStorage; chat images, stickers, and large character payloads use on-device files.

## Commands

```bash
npm install          # local install
npm ci               # what CI uses; lockfile must stay in sync
npm run start        # Expo dev server (primary verification path)
npm run android      # open on Android
npm run prebuild     # expo prebuild --clean, regenerates android/
npm run build:apk    # EAS preview APK
npm run lint         # eslint App.js src
npm test             # Node unit and regression tests
npm run test:coverage # tests + c8 coverage gate (40% floor)
```

- Lint runs through the repo-local ESLint config: `npm run lint` (equivalent to `eslint App.js src`). Node regression tests run with `npm test`; verify native UI paths with `npm run start` and exercise the changed path manually, plus `npm ci` for dependency integrity. Enabled rules: `no-undef`, `react-hooks/rules-of-hooks`, `no-unused-vars` (catch 参数与默认导入 `React` 忽略)。`react-hooks/exhaustive-deps` 尚未启用——存量 37 处多为刻意省略依赖（改错会改变 effect 触发时机），需逐条人工判断后再单独开启。
- 覆盖率门禁是 `npm run test:coverage`（`c8` + `.c8rc.json`）：只统计可在纯 Node 测试里加载的模块，RN UI 层（`react-native`/`@expo/vector-icons` 等）排除在外；当前为 40% 的「只升不降」地板，实际行覆盖约 80%。测试脚手架用 `Module._compile` 加载源码时必须传**真实源码路径**（如 `src/storage.js`），用合成文件名（`*.test-runtime.cjs`）会让 V8 覆盖率记到假路径、真实文件显示 0%。
- Metro does not check for undefined references, so a missing import or a module-level helper using component-scope variables still bundles and then crashes at runtime. After touching UI code, run `npm run lint`; it must print nothing.
- `.npmrc` sets `legacy-peer-deps=true`; keep it.
- APK builds are manual `workflow_dispatch` only. Workflows: `build-apk-github.yml` (Gradle, signs release with the debug keystore) and `build-apk.yml` (EAS, needs `EXPO_TOKEN`).
- CI uses Node 22 and Java 17.

## Non-obvious constraints

- `src/polyfills.js` **must stay the first import in `App.js`**, before `react-native-gesture-handler`. `parsecard` needs a global `Buffer`; ES module hoisting breaks it if the import moves.
- `metro.config.js` enables `unstable_enablePackageExports = true` globally so Metro resolves `parsecard`'s ESM `exports`. This affects every dependency. Re-verify bundling after adding or upgrading deps.
- `android/` and `ios/` are gitignored generated output. Never hand-edit them; they are recreated by `expo prebuild --clean`.
- Context layers must not present UI. `AppContext.updateCharacter` rolls back state and rethrows; screens catch and show `Alert`. Keep it that way.
- Pending assistant placeholders (`pending: true`) must never be persisted. Both `storage.js` and `ChatScreen.js` filter them; preserve that in any new persistence path.
- Persisted error text is masked with `SECRET_PATTERN` (`sk-...` / `Bearer ...`). Unmasked error text lives only in the in-memory `errorRawRef`. Never write raw errors to storage or docs.
- Message storage is keyed per session: `@easychat2_messages::<sessionId>`. Legacy per-character and single-message keys are migration-only; changing key names needs a migration branch.
- `AppContext` uses `characterRef`/`loadedRef` to avoid stale closures; `updateCharacter` rejects writes before load completes. Preserve the ref pattern.
- When switching characters mid-request, the late reply/error is dropped via `activeCharacterIdRef`. Keep the guard.
- RN's `fetch` has no streamable `response.body`. Streaming goes through the built-in `XMLHttpRequest` `onprogress` + cumulative `responseText` in `api.js`. Do not switch it back to `fetch` or add an SSE library without verifying Metro bundling.
- AsyncStorage on Android has a 6MB DB cap by default and a ~2MB single-value read limit (CursorWindow). Raise the cap via the local config plugin `plugins/withAsyncStorageDbSize.js` (writes `AsyncStorage_db_size_in_MB`), and keep large collections split across keys (messages per session, characters via `@easychat2_character_index` + `@easychat2_character_item::<id>`, stickers via `@easychat2_sticker_index` + `@easychat2_sticker_item::<id>`). Never store a whole growing collection — or images/base64 — in one key.
- Scheduled proactive messages ("定时主动消息") live in `plugins/proactiveMessage/android/` (Kotlin, package `com.pppxxxy.easychat2.proactive`) and are injected during prebuild by `plugins/withProactiveMessage.js` (permissions, receivers, dataSync foreground service, WorkManager dependency, `MainApplication` package registration). JS API is `src/proactiveMessage.js`; notification taps reach JS through the `ProactiveMessage:onOpenRole` event handled by `ProactiveMessageBridge` in `App.js`. The editor UI is `src/ProactivePanel.js` ("互动"), reachable from the collapsible "世界" group in `src/ExtensionScreen.js` (which also hosts 动态/moments). Each role can have multiple time slots keyed by `slotId`; schedules are persisted JS-side under `@easychat2_proactive_settings` (see `getProactiveSettings`/`saveProactiveSettings`) and mirrored natively. The API source is picked from existing `getApiConfigs()` entries. Never edit the generated copies under `android/` directly.
- Character library is stored per character (`@easychat2_character_index` + `@easychat2_character_item::<id>`). The legacy whole-array key `@easychat2_characters` is migration-only and must never be overwritten on read failure. The index is written last as the commit point.

## Architecture map

- `App.js` — real entrypoint (package.json `main` points at Expo's AppEntry). Wraps `AppProvider`, bottom tabs: 聊天 / 记忆 / 角色 / 扩展 / 设置.
- `src/ChatScreen.js` — message list, send flow, Markdown assistant replies, error bubbles.
- `src/chat/` — ChatScreen 拆分出的模块：`chatConstants.js`（常量）、`chatHelpers.js`（纯函数）、`chatStyles.js`（样式工厂）、`MessageBubble.js`/`ErrorBubble.js`/`ThinkingIndicator.js`（展示组件）。纯搬运无行为变化；默认导出仍是 `function ChatScreen()`。
- `src/CharacterScreen.js` — character edit + PNG/JSON card import (`parsecard`).
- `src/SettingsScreen.js` — API `baseUrl` / `model` / `apiKey`; warns before saving `http://`.
- `src/api.js` — `sendChatMessage`, URL normalization, streaming via `XMLHttpRequest` SSE parsing (`onChunk`), 30s idle timeout.
- `src/storage.js` — all AsyncStorage access and defaults.
- `src/secretStore.js` — 把配置里的密钥抽到 `expo-secure-store`、AsyncStorage 只留 `secure:v1:<id>` 引用（`setJsonWithSecrets` / `readJsonWithSecrets`）。
- `src/diagnostics.js` — 本地脱敏异常日志（存储损坏 / 接口失败 / WebView 异常 / 未捕获 / 启动），不联网上报；查看入口在「设置 → 关于 → 诊断日志」。
- `src/context/AppContext.js` — global character state (`useApp()`).
- `src/polyfills.js` — global Buffer shim.

Storage keys: `@easychat2_api_configs` (legacy `@easychat2_api_config`), `@easychat2_character_index` + `@easychat2_character_item::<id>`, `@easychat2_sticker_index` + `@easychat2_sticker_item::<id>`, `@easychat2_messages::<sessionId>` (legacy: `@easychat2_character`, `@easychat2_characters`, `@easychat2_messages`, `@easychat2_stickers`), `@easychat2_diagnostics`. Media files live under `documentDirectory/chat-images/` and `documentDirectory/stickers/`.

## Conventions

- Dark palette: bg `#1a1a2e`, surfaces `#2d2d44`, accent `#6c63ff`, muted `#aaa`. Each screen defines its own `StyleSheet.create` at the bottom.
- Only assistant messages render Markdown; user and error messages stay plain `Text`.
- Commit messages use Conventional Commits (`feat:`, `fix:`, `refactor:`, `chore:`, `docs:`). Main branch is `main`.
- Never commit or print real API keys or tokens; use placeholders.

## Docs

Generated project wiki lives in `.monkeycode/docs/` (`INDEX.md`, `ARCHITECTURE.md`, `INTERFACES.md`, `DEVELOPER_GUIDE.md`, plus concept and module pages). Keep it in sync when behavior changes.

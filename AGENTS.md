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
npm run lint         # eslint App.js src plugins tests
npm test             # Node unit and regression tests
npm run test:coverage # tests + c8 coverage gate (60% floor)
```

- Lint runs through the repo-local ESLint config: `npm run lint` (equivalent to `eslint App.js src plugins tests`). Node regression tests run with `npm test`; verify native UI paths with `npm run start` and exercise the changed path manually（聊天相关改动按 `SMOKE_TEST.md` 走查）, plus `npm ci` for dependency integrity. Enabled rules: `no-undef`, `react/jsx-uses-vars`、`react-hooks/rules-of-hooks`、`no-unused-vars` (catch 参数与默认导入 `React` 忽略)。`eslint` 精确锁定 `10.11.0`（`^` 也会随 minor 漂移，且 core 的 JSX 使用追踪是 10 的新行为），`package.json` 的 `engines.node` 对齐 eslint 要求（`^20.19.0 || ^22.13.0 || >=24`）；`react/jsx-uses-vars` 让 lint 在 eslint 9/10 下行为一致。`react-hooks/exhaustive-deps` 尚未启用——存量 37 处多为刻意省略依赖（改错会改变 effect 触发时机），需逐条人工判断后再单独开启。
- 覆盖率门禁是 `npm run test:coverage`（`c8` + `.c8rc.json`）：只统计可在纯 Node 测试里加载的模块，RN UI 层（`react-native`/`@expo/vector-icons` 等）排除在外；当前为 60% 的「只升不降」地板，实际行覆盖约 81%（纳入集约 15400 行，另有约 62% 的 src 行数因 RN 依赖被排除，见 `.c8rc.json`）。测试脚手架用 `Module._compile` 加载源码时必须传**真实源码路径**（如 `src/storage.js`），用合成文件名（`*.test-runtime.cjs`）会让 V8 覆盖率记到假路径、真实文件显示 0%。
- Metro does not check for undefined references, so a missing import or a module-level helper using component-scope variables still bundles and then crashes at runtime. After touching UI code, run `npm run lint`; it must print nothing. `npm run lint` now also covers `plugins/*.js` and `tests/*.mjs`（`eslint App.js src plugins tests`）。
- `lint` 的覆盖率排除用**显式文件清单**（`.c8rc.json`），不要再加 `*Screen.js`/`*Panel.js`/`*View.js` 这类后缀通配——它们会静默排除未来任何同后缀的非 UI 模块。新增 UI 文件时手动登记。
- `default.jpg`（仓库根）**无任何代码引用**，是本地手工大卡解析测试素材；Metro 只打包被 `require` 的静态资源，故不增大 APK，仅占 git 体积。保留是刻意约定；如需仓库整洁可 `git mv` 到 `tests/fixtures/`。
- `src/games/games.js` 只保留游戏清单，各游戏 HTML 在 `src/games/html/*.js`（单一来源，避免超长单行字符串污染 diff/lint）。改游戏内容改对应 html 文件。
- `.npmrc` sets `legacy-peer-deps=true`; keep it.
- APK builds are manual `workflow_dispatch` only. Workflows: `build-apk-github.yml` (Gradle, signs release with the debug keystore) and `build-apk.yml` (EAS, needs `EXPO_TOKEN`).
- CI uses Node 22 and Java 17.

## Non-obvious constraints

- `src/polyfills.js` **must stay the first import in `App.js`**, before `react-native-gesture-handler`. `parsecard` needs a global `Buffer`; ES module hoisting breaks it if the import moves.
- `metro.config.js` enables `unstable_enablePackageExports = true` globally so Metro resolves `parsecard`'s ESM `exports`. This affects every dependency. Re-verify bundling after adding or upgrading deps.
- `src/package.json` declares `{"type":"module"}`：让 `src/**/*.js` 对 Node 是**无歧义 ESM**，消除测试里 `MODULE_TYPELESS_PACKAGE_JSON`（否则 `.js` 靠 Node 语法探测）。不要删除它；根目录配置（`babel.config.js`/`metro.config.js`/`plugins/*.js`）仍是 CJS，与 `src` 无关。新增 `src` 内文件按 ESM 写。
- 相对导入一律带 `.js` 扩展名（`App.js`、`src/**`、`tests/**`）；目录导入写 `<dir>/index.js`（如 `./ui/index.js`）。新增文件沿用此约定，`node --test` 直接 `import` 时才不会因缺扩展名解析失败。
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
- `src/chat/` — ChatScreen 拆分出的模块：`chatConstants.js`（常量）、`chatHelpers.js`（纯函数）、`chatStyles.js`（样式工厂）、`useChatSearch.js`/`useScrollScrubber.js`/`useChatTts.js`/`useChatModelThinking.js`（聊天内搜索、快速定位滑动条、语音播报、模型/思考设置），`MessageBubble.js`/`ErrorBubble.js`/`ThinkingIndicator.js`（展示组件）、`SelectionTextModal.js`/`SwitcherModal.js`/`MentionPickerModal.js`/`ModelPanelModal.js`/`ThinkingPanelModal.js`/`StickerPanelModal.js`/`StickerNamePromptModal.js`/`MoreMenuModal.js`/`ChatSettingsModal.js`/`FullScreenInputModal.js`/`ChatSearchBar.js`/`ChatTopBar.js`/`ChatComposer.js`（选择文本、角色/群聊切换、提及成员、切换模型、思考设置、表情包面板、表情包命名、更多菜单、聊天设置、全屏输入弹窗、聊天内搜索栏、聊天页顶栏、输入区）。纯搬运无行为变化；默认导出仍是 `function ChatScreen()`。共享的滚动/焦点锚点（`scrollRef`/`messageOffsetsRef`/`scrollToMessage`/`focusedMessageId`）仍留在 ChatScreen 参数注入，因为搜索、滚动条、引用跳转、删除清理共用。
- `src/CharacterScreen.js` — character edit + PNG/JSON card import (`parsecard`).
- `src/SettingsScreen.js` — API `baseUrl` / `model` / `apiKey`; warns before saving `http://`.
- `src/api.js` — `sendChatMessage`, URL normalization, streaming via `XMLHttpRequest` SSE parsing (`onChunk`), 30s idle timeout.
- `src/storage.js` — 对外 barrel（既有导入方零改动）。持久化已按领域拆到 `src/storage/*.js`：`io.js`（AsyncStorage/FileSystem I/O 原语 + 含密钥读写包装 + 损坏备份 + SQLite 大值读取 + `utf8ByteLength`）、`characters.js`、`settings.js`、`apiConfigs.js`、`personas.js`、`globalPresets.js`、`vector.js`、`moments.js`、`diary.js`、`worldMap.js`、`stickers.js`、`affinity.js`、`cardForge.js`。**会话领域已再分层**：`sessions.js` 现为 barrel，拆成 `sessionCore.js`（队列/键/共享状态/列表读写原语/摘要版本，无内部依赖）→ `sessionFiles.js`（聊天图片回收，叶子）→ `sessionMessages.js`（消息+摘要+草稿+搜索）→ `sessionList.js`（会话 CRUD/群聊/迁移/孤儿/向量对账）；依赖严格单向 core←files←messages←list，无循环。`storage.js` 自身仅剩跨域编排 `saveCharacterState` 与头像/表情/孤儿图片清理。注意：`tests/characterStorage.test.mjs`、`tests/proactiveSettings.test.mjs` 用 Babel 把 `storage.js` 转 CJS 后 `Module._compile`，并靠「`Module._load` 拦截 `src/storage/*` 按需转 CJS」加载子模块（否则 `require(esm)` 绕过打桩）；**加载器必须把编译结果写回 `Module._cache`**（否则多个子模块 import 同一 `sessionCore` 会各得一份实例，模块级共享状态被复制、跨模块写入互不可见），且 `characterStorage.test.mjs` 的 `loadStorage()` 每轮清掉 `src/storage/` 下的缓存以免跨用例泄漏。详见 `.monkeycode/specs/2026-09-28-storage-split/`、`.monkeycode/specs/2026-09-29-session-storage-split/`。
- `src/secretStore.js` — 把配置里的密钥抽到 `expo-secure-store`、AsyncStorage 只留 `secure:v1:<id>` 引用（`setJsonWithSecrets` / `readJsonWithSecrets`）。
- `src/stickerDirectives.js` — 纯函数：解析助手回复里的 `[[表情包:名称]]`（`extractStickerDirectives` 按用户表情包白名单过滤并剥离标记、`resolveStickerNames` 归一名称）。角色发表情包依赖它，白名单外名称一律丢弃。
- `src/moments/commenters.js` / `src/moments/runUserMomentComments.js` — 用户发动态的评论选人纯函数（`countCharacterMessageTotals`/`selectCommenters`/`pickRandom`，「最活跃保底 + 随机」，保底并列可超 7）与串行评论执行器；与同住的 `runHousemateReactions` 并存。
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

import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';

import noHardcodedChinese from './eslint-rules/no-hardcoded-chinese.mjs';

export default [
  {
    files: ['**/*.js', '**/*.mjs'],
    ignores: ['node_modules/**', 'android/**', 'ios/**'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: {
        React: 'readonly', global: 'readonly', Promise: 'readonly', require: 'readonly',
        module: 'readonly', exports: 'readonly', process: 'readonly', console: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly',
        clearInterval: 'readonly', setImmediate: 'readonly', clearImmediate: 'readonly',
        queueMicrotask: 'readonly', fetch: 'readonly', FormData: 'readonly',
        XMLHttpRequest: 'readonly', AbortController: 'readonly', Buffer: 'readonly',
        requestAnimationFrame: 'readonly', cancelAnimationFrame: 'readonly', alert: 'readonly',
        __DEV__: 'readonly', __dirname: 'readonly', URLSearchParams: 'readonly',
        TextEncoder: 'readonly', TextDecoder: 'readonly',
      },
    },
    plugins: { 'react-hooks': reactHooks, react },
    rules: {
      'no-undef': 'error',
      // 仅 JSX 使用的标识符也要算作已使用。ESLint 10 core 自带该追踪，但 ESLint 9 core 没有；
      // 显式开启后，lint 在 9/10 下行为一致，不再隐式依赖 ESLint 10 的新行为。
      'react/jsx-uses-vars': 'error',
      // 真实规则违规会让 hooks 调用顺序错乱，按错误处理。
      'react-hooks/rules-of-hooks': 'error',
      // 未使用的变量/导入/参数：抓死代码。catch 参数与 React 默认导入按惯例忽略。
      'no-unused-vars': ['error', {
        args: 'after-used',
        ignoreRestSiblings: true,
        caughtErrors: 'none',
        varsIgnorePattern: '^React$',
      }],
    },
  },
  {
    // i18n 防复发：用户可见文案（Alert.alert / throw new Error）不得硬编码中文。
    // 判定用本地规则 eslint-rules/no-hardcoded-chinese.mjs（AST 级，注释不算）。
    //
    // 下面的 `ignores` 是**存量迁移清单（只减不增）**：用规则实测跑出的 32 个
    // 尚有硬编码的文件（共 559 处）。迁移方式 = 把文案换成 t('<key>') 并补
    // src/i18n/locales 双语言词条，然后从这里删掉该行；清单只允许变短。
    // 新文件一律不得加入。完整清单与分批计划见 .monkeycode/docs/审查待办.md。
    files: ['src/**/*.js', 'App.js'],
    ignores: [
      'src/i18n/**',
      // ---- 存量迁移清单（只减不增）----
    // 由规则实测生成（51 个文件、190 处）。迁移一个文件就从这里删一行。
      'src/BackupPanel.js',
      'src/books/comments.js',
      'src/books/library.js',
      'src/books/useBookComments.js',
      'src/CardForgeEditor.js',
      'src/CardForgeScreen.js',
      'src/CardPreviewModal.js',
      'src/character/cardExporter.js',
      'src/character/cardParser.js',
      'src/CharacterEditForm.js',
      'src/CharacterScreen.js',
      'src/chat/attachments.js',
      'src/chat/stickerImages.js',
      'src/chat/useChatModelThinking.js',
      'src/chat/useChatRecorder.js',
      'src/chat/useChatSend.js',
      'src/chat/useChatTts.js',
      'src/chat/useSessionMessages.js',
      'src/chat/useSessionSwitch.js',
      'src/ChatScreen.js',
      'src/context/AppContext.js',
      'src/DiagnosticsModal.js',
      'src/GroupEditForm.js',
      'src/imageGen/index.js',
      'src/imageGen/png.js',
      'src/ImageGenScreen.js',
      'src/localModel/modelCatalog.js',
      'src/localModel/ModelLogsModal.js',
      'src/localModel/modelManager.js',
      'src/LocalModelPanel.js',
      'src/location/service.js',
      'src/MapPanel.js',
      'src/memory/memorySummary.js',
      'src/MemoryScreen.js',
      'src/MomentsView.js',
      'src/music/comments.js',
      'src/music/library.js',
      'src/music/useMusicComments.js',
      'src/network/api.js',
      'src/PluginPanel.js',
      'src/plugins/webSearch.js',
      'src/PresetPanel.js',
      'src/proactive/proactiveMessage.js',
      'src/prompt/regexEngine.js',
      'src/screenWatch/comments.js',
      'src/screenWatch/useScreenWatchComments.js',
      'src/SearchScreen.js',
      'src/settings/SamplingCard.js',
      'src/settings/useUserProfile.js',
      'src/settings/useVectorSettings.js',
      'src/SettingsScreen.js',
      'src/storage/backupStream.js',
      'src/storage/cardForge.js',
      'src/storage/characters.js',
      'src/storage/diary.js',
      'src/storage/globalPresets.js',
      'src/storage/localModels.js',
      'src/storage/location.js',
      'src/storage/moments.js',
      'src/storage/personas.js',
      'src/storage/sessionCore.js',
      'src/storage/sessionList.js',
      'src/storage/sessionMessages.js',
      'src/storage/settings.js',
      'src/storage/stickers.js',
      'src/storage/vector.js',
      'src/storage/worldMap.js',
      'src/theme/ThemeContext.js',
      'src/transcription.js',
      'src/TranscriptionPanel.js',
      'src/tts/index.js',
      'src/TtsPanel.js',
      'src/vectorMemory/index.js',
      'src/workspace/docx.js',
      'src/workspace/edit.js',
      'src/workspace/paths.js',
      'src/workspace/picker.js',
      'src/workspace/safStore.js',
      'src/workspace/shell.js',
      'src/workspace/store.js',
      'src/workspace/tools.js',
    ],
    plugins: { local: { rules: { 'no-hardcoded-chinese': noHardcodedChinese } } },
    rules: {
      'local/no-hardcoded-chinese': 'error',
    },
  },
  {
    // 分层约束：持久化原语只允许在存储层内直接引用，UI/业务文件一律走
    // `src/storage.js` 门面或域模块。破坏这条约定最容易表现为「绕过损坏备份 /
    // 绕过密钥脱敏 / 绕过 SQLite 大值兜底」，且很难靠 review 拦住。
    //
    // 豁免（既有分散引用，属历史债，新增文件不得再加入）：
    //   - `src/storage/**`、`src/storage.js`：存储实现本身；`secretStore.js`
    //     （expo-secure-store 唯一封装点）、`diagnostics.js`（惰性 require
    //     AsyncStorage）与 `secrets.js` 已归入 `src/storage/`；
    //   - `src/books|music|screenWatch/**`：这三个后加域自持存储键，尚未并入
    //     storage 层（见 `.monkeycode/docs/审查待办.md`）。
    files: ['src/**/*.js'],
    ignores: [
      'src/storage/**',
      'src/storage.js',
      'src/books/**',
      'src/music/**',
      'src/screenWatch/**',
    ],
    rules: {
      'no-restricted-imports': ['error', {
        paths: [
          {
            name: '@react-native-async-storage/async-storage',
            message: '持久化统一走 src/storage/ 域模块或 src/storage.js 门面，不要在 UI/业务文件里直接读写存储。',
          },
          {
            name: 'expo-sqlite',
            message: 'SQLite 仅用于 src/storage/io.js 的大值读取兜底。',
          },
          {
            name: 'expo-secure-store',
            message: '安全存储只允许在 src/storage/secretStore.js 内使用。',
          },
        ],
      }],
    },
  },
  {
    // 文件系统分层：`expo-file-system` 的写入若忘记 markMediaWrite（写文件后登记保护
    // 窗口），用户图片会被孤儿回收器误删——而 lint 不会告诉你漏了哪处。
    // 本规则先把「新债」冻住：下面 ignores 是实测的存量清单（28 个文件，只减不增）。
    // 迁移方向：文件操作逐步收进域内封装点（封装点内部强制 markMediaWrite），
    // 每迁完一个文件从清单删一行。新文件一律不得加入。
    files: ['src/**/*.js'],
    ignores: [
      'src/storage/**',
      'src/storage.js',
      'src/i18n/**',
      // ---- 存量清单（只减不增）：实测 28 个直接引用 expo-file-system 的非存储文件 ----
      'src/BackupPanel.js',
      'src/CharacterEditForm.js',
      'src/CharacterScreen.js',
      'src/GroupEditForm.js',
      'src/ImageGenScreen.js',
      'src/books/BookScreen.js',
      'src/books/importBook.js',
      'src/books/library.js',
      'src/cardForge/media.js',
      'src/character/cardExporter.js',
      'src/character/defaultCharacterAssets.js',
      'src/chat/RichHtmlMessage.js',
      'src/chat/attachments.js',
      'src/chat/audioModules.js',
      'src/chat/stickerImages.js',
      'src/chat/useChatSend.js',
      'src/chat/useChatTts.js',
      'src/localModel/modelManager.js',
      'src/music/MusicScreen.js',
      'src/music/importMusic.js',
      'src/proactive/proactiveRequest.js',
      'src/screenWatch/capture.js',
      'src/settings/useUserProfile.js',
      'src/workspace/location.js',
      'src/workspace/native.js',
      'src/workspace/picker.js',
      'src/workspace/safStore.js',
      'src/workspace/store.js',
    ],
    rules: {
      'no-restricted-imports': ['error', {
        paths: [
          {
            name: 'expo-file-system',
            message: '文件系统操作请走域内封装点（内部统一 markMediaWrite 保护媒体文件）；新文件不要直接 import expo-file-system。',
          },
          {
            name: 'expo-file-system/legacy',
            message: '文件系统操作请走域内封装点（内部统一 markMediaWrite 保护媒体文件）；新文件不要直接 import expo-file-system/legacy。',
          },
        ],
      }],
    },
  },
];

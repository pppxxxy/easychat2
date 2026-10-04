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
      'src/BackupPanel.js',
      'src/CardForgeEditor.js',
      'src/CardForgeScreen.js',
      'src/CardPreviewModal.js',
      'src/CharacterEditForm.js',
      'src/CharacterScreen.js',
      'src/ChatScreen.js',
      'src/DiagnosticsModal.js',
      'src/GroupEditForm.js',
      'src/ImageGenScreen.js',
      'src/LocalModelPanel.js',
      'src/MapPanel.js',
      'src/MemoryScreen.js',
      'src/MomentsView.js',
      'src/PluginPanel.js',
      'src/PresetPanel.js',
      'src/SearchScreen.js',
      'src/SettingsScreen.js',
      'src/TranscriptionPanel.js',
      'src/TtsPanel.js',
      'src/chat/useChatModelThinking.js',
      'src/chat/useChatSend.js',
      'src/chat/useChatTts.js',
      'src/chat/useSessionMessages.js',
      'src/chat/useSessionSwitch.js',
      'src/localModel/ModelLogsModal.js',
      'src/settings/SamplingCard.js',
      'src/settings/useUserProfile.js',
      'src/settings/useVectorSettings.js',
      'src/theme/ThemeContext.js',
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
];

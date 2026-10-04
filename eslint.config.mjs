import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';

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
    // 分层约束：持久化原语只允许在存储层内直接引用，UI/业务文件一律走
    // `src/storage.js` 门面或域模块。破坏这条约定最容易表现为「绕过损坏备份 /
    // 绕过密钥脱敏 / 绕过 SQLite 大值兜底」，且很难靠 review 拦住。
    //
    // 豁免（既有分散引用，属历史债，新增文件不得再加入）：
    //   - `src/storage/**`、`src/storage.js`：存储实现本身；
    //   - `src/secretStore.js`：expo-secure-store 的唯一封装点；
    //   - `src/diagnostics.js`：按 AGENTS.md 要求惰性 require AsyncStorage，避免
    //     与 storage/io.js 形成循环依赖；
    //   - `src/books|music|screenWatch/**`：这三个后加域自持存储键，尚未并入
    //     storage 层（见 `.monkeycode/docs/审查待办.md`）。
    files: ['src/**/*.js'],
    ignores: [
      'src/storage/**',
      'src/storage.js',
      'src/secretStore.js',
      'src/diagnostics.js',
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
            message: '安全存储只允许在 src/secretStore.js 内使用。',
          },
        ],
      }],
    },
  },
];

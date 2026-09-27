import reactHooks from 'eslint-plugin-react-hooks';

export default [
  {
    files: ['**/*.js'],
    ignores: ['node_modules/**', 'android/**', 'ios/**'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: {
        React: 'readonly', global: 'readonly', Promise: 'readonly', require: 'readonly',
        module: 'readonly', exports: 'readonly', process: 'readonly', console: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly',
        clearInterval: 'readonly', fetch: 'readonly', FormData: 'readonly',
        XMLHttpRequest: 'readonly', AbortController: 'readonly', Buffer: 'readonly',
        requestAnimationFrame: 'readonly', cancelAnimationFrame: 'readonly', alert: 'readonly',
        __DEV__: 'readonly',
      },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'no-undef': 'error',
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
];

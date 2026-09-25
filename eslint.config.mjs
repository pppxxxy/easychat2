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
    rules: { 'no-undef': 'error' },
  },
];

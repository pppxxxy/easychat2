// Vite 配置（design.md「别名表」）：共享层源码零改动地拿到桌面实现。
//
// 两条硬约束：
// 1. `react-native` 别名只导出 Alert/Platform —— 共享层误引 View/Text 会在构建期
//    以「未导出」失败（design.md 刻意留的窄门）。
// 2. 共享层全部是 .js（含 JSX 的也写作 .js），所以 esbuild.loader 把 '.js' 当 jsx 处理；
//    jsx: 'automatic' 使用 react/jsx-runtime，不要求文件里 import React。
// 新增共享层依赖必须在上表登记别名，否则构建期报「无法解析」——这是有意设计的摩擦。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const here = path.dirname(fileURLToPath(import.meta.url));
const platform = file => path.resolve(here, 'src', 'platform', file);

export default defineConfig({
  base: './',
  // 共享层大量是「含 JSX 的 .js」：Vite 5 的 esbuild.loader 不支持按扩展名映射，
  // 因此用 plugin-react（Babel）统一处理 .js/.jsx 的 JSX 转换。
  plugins: [react({ include: /\.(js|jsx)$/ })],
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: [
      // 子路径必须排在裸包名之前（expo-file-system/legacy 会被前缀匹配抢走）。
      { find: /^expo-file-system\/legacy$/, replacement: platform('fileSystem.js') },
      { find: /^expo-file-system$/, replacement: platform('fileNext.js') },
      { find: /^@react-native-async-storage\/async-storage$/, replacement: platform('asyncStorage.js') },
      { find: /^react-native$/, replacement: platform('reactNative.js') },
      { find: /^expo-sqlite$/, replacement: platform('sqlite.js') },
      { find: /^expo-secure-store$/, replacement: platform('secureStore.js') },
      { find: /^expo-asset$/, replacement: platform('asset.js') },
      { find: /^expo-clipboard$/, replacement: platform('clipboard.js') },
      { find: /^expo-audio$/, replacement: platform('audio.js') },
      { find: /^expo-speech$/, replacement: platform('speech.js') },
      { find: /^expo-document-picker$/, replacement: platform('documentPicker.js') },
      { find: /^expo-image-picker$/, replacement: platform('imagePicker.js') },
      { find: /^expo-sharing$/, replacement: platform('sharing.js') },
      { find: /^expo-device$/, replacement: platform('device.js') },
      { find: /^expo-local-authentication$/, replacement: platform('localAuth.js') },
    ],
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'chrome126',
    sourcemap: true,
  },
});

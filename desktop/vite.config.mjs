// Vite 配置（design.md「别名表」）：共享层源码零改动地拿到桌面实现。
//
// 两条硬约束：
// 1. `react-native` 别名只导出 Alert/Platform/PixelRatio/useWindowDimensions 等
//    非组件 API —— 共享层误引 View/Text 会在构建期以「未导出」失败（刻意留的窄门）。
// 2. 共享层大量是「含 JSX 的 .js」且位于 desktop/ 之外：plugin-react 只处理项目内
//    文件，因此用自定义 esbuild 插件（enforce: 'pre'）把非 node_modules 的 .js
//    统一按 jsx loader 转译，jsx: 'automatic' 使用 react/jsx-runtime。
// 新增共享层依赖必须在上表登记别名，否则构建期报「无法解析」——这是有意设计的摩擦。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transform } from 'esbuild';
import { defineConfig } from 'vite';

const here = path.dirname(fileURLToPath(import.meta.url));
const platform = file => path.resolve(here, 'src', 'platform', file);

// 共享层的 .js 里含 JSX（如 src/theme/ThemeContext.js 的 Provider JSX）。
function jsxInJs() {
  return {
    name: 'easychat2-jsx-in-js',
    enforce: 'pre',
    async transform(code, id) {
      if (!id.endsWith('.js') || id.includes('node_modules')) return null;
      const result = await transform(code, {
        loader: 'jsx',
        jsx: 'automatic',
        sourcefile: id,
        sourcemap: true,
      });
      return { code: result.code, map: result.map };
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [jsxInJs()],
  esbuild: { jsx: 'automatic' },
  resolve: {
    // 共享层 src/** 位于 desktop/ 之外，node 解析会落到**仓库根** node_modules——
    // 与 desktop/node_modules 形成两份 React（hooks 直接崩）。所有 React 相关
    // 入口强制解析到 desktop 自己的副本。
    dedupe: ['react', 'react-dom'],
    alias: [
      { find: /^react$/, replacement: path.join(here, 'node_modules/react/index.js') },
      { find: /^react\/jsx-runtime$/, replacement: path.join(here, 'node_modules/react/jsx-runtime.js') },
      { find: /^react\/jsx-dev-runtime$/, replacement: path.join(here, 'node_modules/react/jsx-dev-runtime.js') },
      { find: /^react-dom$/, replacement: path.join(here, 'node_modules/react-dom/index.js') },
      { find: /^react-dom\/client$/, replacement: path.join(here, 'node_modules/react-dom/client.js') },
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
      { find: /^react-native-view-shot$/, replacement: platform('viewShot.js') },
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

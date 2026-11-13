import { ensureFullTextDecoder } from './books/fullTextDecoder.js';

if (typeof global.Buffer === 'undefined') {
  global.Buffer = require('buffer').Buffer;
}

// Expo SDK 54 的全局 TextDecoder 只认 UTF-8；`text-encoding` 会转发它而不是装载
// 完整 polyfill（详见 books/fullTextDecoder.js）。必须在业务模块（books/decodeText）
// 加载前摘掉残缺的全局并换上完整实现，否则导入 GBK/BIG5 等文本会误报「编码不支持」。
if (typeof require === 'function') {
  ensureFullTextDecoder(global, () => require('text-encoding'));
}

// 注册内置角色头像/背景的默认落盘实现（expo-asset + 打包 jpg）。
// AppContext 只依赖 character/artworkLoader.js 的注册表，故注册点放在这里（App.js 的
// 入口垫片，Android 专用）；桌面入口注入自己的实现，不会把 CJS 资源 require 带进桌面构建。
import './character/defaultCharacterAssets.js';

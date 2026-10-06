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

// 渲染进程 polyfills：必须在任何共享层模块之前执行（main.jsx 的首个 import）。
//
// - Buffer：parsecard 等共享层模块依赖全局 Buffer（Android 侧 src/polyfills.js 同款）；
// - XMLHttpRequest：共享层 src/network/api.js 直接 new XMLHttpRequest()，桌面由适配层
//   提供（主进程代发，绕开 CORS）。
import { Buffer } from 'buffer';

import { getBridge } from './platform/bridge.js';
import { createXHRFactory } from './platform/xhr.js';

globalThis.Buffer = globalThis.Buffer || Buffer;

if (typeof globalThis.XMLHttpRequest !== 'function') {
  globalThis.XMLHttpRequest = createXHRFactory(getBridge());
}

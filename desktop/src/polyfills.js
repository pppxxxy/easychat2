// 渲染进程 polyfills：必须在任何共享层模块之前执行（main.jsx 的首个 import）。
//
// - Buffer：parsecard 等共享层模块依赖全局 Buffer（Android 侧 src/polyfills.js 同款）；
// - XMLHttpRequest：共享层 src/network/api.js 直接 new XMLHttpRequest()，桌面由适配层
//   提供（主进程代发，绕开 CORS）。
import { Buffer } from 'buffer';

import { getBridge } from './platform/bridge.js';
import { createXHRFactory } from './platform/xhr.js';
import fileNext from './platform/fileNext.js';
import fileSystem from './platform/fileSystem.js';
import secureStore from './platform/secureStore.js';
import sqlite from './platform/sqlite.js';
import audio from './platform/audio.js';
import * as speech from './platform/speech.js';

globalThis.Buffer = globalThis.Buffer || Buffer;

// 必须**无条件覆盖**：Chromium 自带 XMLHttpRequest，若沿用原生实现，共享层的请求
// 会直接走渲染进程网络栈——被 CSP connect-src 'self' 拦下，且受 CORS 限制。
// 桌面端的唯一网络出口是主进程代理（design.md「Key Decisions / 网络」）。
globalThis.XMLHttpRequest = createXHRFactory(getBridge());

// 共享层有几处**惰性** `require('expo-*')`（storage/secretStore 的 secure store、
// chat/audioModules 的音频/文件模块、storage/io 的 sqlite 兜底）。ESM 渲染进程没有
// require：这里按白名单映射到平台适配模块；未知模块抛错——与「原生模块未注册」时
// 的行为一致，调用方本来就包着 try/catch（失败即按能力不可用分支处理）。
const REQUIRE_MODULES = {
  'expo-secure-store': secureStore,
  'expo-sqlite': sqlite,
  'expo-audio': audio,
  'expo-speech': speech,
  'expo-file-system/legacy': fileSystem,
  'expo-file-system': fileNext,
};
if (typeof globalThis.require !== 'function') {
  globalThis.require = moduleId => {
    const key = String(moduleId);
    if (Object.prototype.hasOwnProperty.call(REQUIRE_MODULES, key)) return REQUIRE_MODULES[key];
    throw new Error(`require(${key}) is not available on desktop`);
  };
}

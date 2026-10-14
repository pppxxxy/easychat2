// 悬浮窗对话日志（M2.5）：把原生大脑写在 `screen-watch/overlay-thread*.jsonl` 的
// 对话读回来，解析成 threads.js 的条目形状，好让 app 内「看屏幕」页接得上。
//
// 分层（照 FIX-7 的教训）：
//   · 解析规则在 overlayThreadParse.js —— **零依赖纯函数**，Node 里可直接测；
//   · 文件读写在 capture.js —— screen-watch 域的**文件系统封装点**
//    （eslint 分层规则：新文件不得直接 import expo-file-system/legacy）；
//   · 本文件只做「读 + 解析 + 拼装」，并 re-export 解析器给调用方一个入口。
//
// 反向（app 内续聊 → 悬浮窗也看得见）走 ScreenOverlayModule.appendOverlayTurn，
// 由原生按同一格式代写——两处各拼一份 JSONL 必然漂移。

import { NativeModules } from 'react-native';

import { readOverlayThreadLogSlices } from './capture.js';
import {
  OVERLAY_ROLE_CHARACTER,
  OVERLAY_ROLE_USER,
  parseOverlayThreadLines,
} from './overlayThreadParse.js';

export {
  OVERLAY_LOG_PATTERN,
  OVERLAY_ROLE_CHARACTER,
  OVERLAY_ROLE_USER,
  OVERLAY_THREAD_LOG_NAME,
  parseOverlayThreadLines,
} from './overlayThreadParse.js';

/**
 * 读回悬浮窗对话（全部分片合并、按时间排序）。
 * 任何失败都返回空数组：这只是「把悬浮窗说过的话并进来」，读不到不该阻断 app 内功能。
 */
export async function readOverlayThreadEntries({ persona = '', dir = null } = {}) {
  try {
    const slices = await readOverlayThreadLogSlices(dir);
    const all = [];
    for (const slice of slices) {
      // 前缀带文件名：分片之间行号会重，带上名字才不会撞 id。
      all.push(...parseOverlayThreadLines(slice.text, { persona, idPrefix: `ovl-${slice.name}` }));
    }
    return all.sort((a, b) => a.at - b.at);
  } catch (error) {
    return [];
  }
}

/** 把 app 内产生的一轮写回悬浮窗对话日志（原生代写，格式与大脑一致）。失败静默。 */
export async function appendOverlayTurn(role, text) {
  try {
    const module = NativeModules.ScreenOverlay;
    if (!module || typeof module.appendOverlayTurn !== 'function') return false;
    const value = String(text || '').trim();
    if (!value) return false;
    return !!(await module.appendOverlayTurn(
      String(role === OVERLAY_ROLE_USER ? OVERLAY_ROLE_USER : OVERLAY_ROLE_CHARACTER),
      value
    ));
  } catch (error) {
    return false;
  }
}

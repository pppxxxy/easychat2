// 看屏幕 v1：截**自己 App** 的画面（react-native-view-shot，零权限——跨应用
// 截屏涉及 MediaProjection 动态授权，明确不做，见审查待办第 8 项）。
// captureScreen() 落的是临时文件：先移动到 screen-watch/ 持久目录并登记媒体
// 保护（孤儿回收不误删），再释放原生侧临时资源；采集失败不留半成品。
// 采集文件只服务当次评论请求与重试，目录按 keepNewest 滚动清扫。

import { captureScreen, releaseCapture } from 'react-native-view-shot';
import * as FileSystem from 'expo-file-system/legacy';

import { markMediaWrite } from '../storage/mediaProtection.js';

export const SCREEN_WATCH_DIR_NAME = 'screen-watch';
const SWEEP_KEEP = 20;

// 悬浮窗对话日志（M2.5）：由原生大脑写入 screen-watch/overlay-thread*.jsonl。
// 读取放在这里而不是 overlayThreadLog.js —— 本文件是 screen-watch 域的**文件系统封装点**
//（eslint 分层规则：新文件不得直接 import expo-file-system/legacy）。
const OVERLAY_LOG_PATTERN = /^overlay-thread(-\d+)?\.jsonl$/;

/** 读出全部对话日志分片（按名字排序 = 时间顺序）；目录不存在时返回空数组。 */
export async function readOverlayThreadLogSlices(dir = null) {
  const base = dir === null ? screenWatchDirectory() : dir;
  let names = [];
  try {
    names = await FileSystem.readDirectoryAsync(base);
  } catch (error) {
    return [];   // 从没用过悬浮窗 → 目录还不存在，不是错误
  }
  const slices = [];
  for (const name of (names || []).filter(item => OVERLAY_LOG_PATTERN.test(String(item))).sort()) {
    try {
      slices.push({ name: String(name), text: await FileSystem.readAsStringAsync(`${base}${name}`) });
    } catch (error) {
      // 单个分片读失败不拖垮整体：其余分片照常并入。
    }
  }
  return slices;
}

export function screenWatchDirectory(documentDirectory = null) {
  const base = documentDirectory === null ? FileSystem.documentDirectory : documentDirectory;
  return `${base || ''}${SCREEN_WATCH_DIR_NAME}/`;
}

// 滚动清扫：只保留最近 keepNewest 张截图，防止长期使用撑大应用目录。
export async function sweepScreenWatchFiles({ keepNewest = SWEEP_KEEP } = {}) {
  try {
    const dir = screenWatchDirectory();
    const names = await FileSystem.readDirectoryAsync(dir);
    const kept = (names || [])
      .filter(name => String(name).endsWith('.jpg'))
      .sort()
      .reverse()
      .slice(Math.max(0, Math.floor(keepNewest)));
    await Promise.all(kept.map(name => FileSystem.deleteAsync(`${dir}${name}`, { idempotent: true }).catch(() => {})));
    return kept.length;
  } catch (error) {
    return 0;
  }
}

// 返回 { uri }；失败时清理半成品并抛错，临时文件始终释放。
export async function captureAppScreen({ quality = 0.7, now = Date.now() } = {}) {
  const tmpUri = await captureScreen({ format: 'jpg', quality, result: 'tmpfile' });
  const dest = `${screenWatchDirectory()}cap-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}.jpg`;
  try {
    await FileSystem.makeDirectoryAsync(screenWatchDirectory(), { intermediates: true });
    markMediaWrite(dest);
    await FileSystem.moveAsync({ from: tmpUri, to: dest });
  } catch (error) {
    await FileSystem.deleteAsync(dest, { idempotent: true }).catch(() => {});
    throw error;
  } finally {
    try {
      releaseCapture(tmpUri);
    } catch (releaseError) {}
  }
  sweepScreenWatchFiles().catch(() => {});
  return { uri: dest };
}

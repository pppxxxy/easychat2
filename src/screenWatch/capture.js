// 看屏幕 v1：截**自己 App** 的画面（react-native-view-shot，零权限——跨应用
// 截屏涉及 MediaProjection 动态授权，明确不做，见审查待办第 8 项）。
// captureScreen() 落的是临时文件：先移动到 screen-watch/ 持久目录并登记媒体
// 保护（孤儿回收不误删），再释放原生侧临时资源；采集失败不留半成品。
// 采集文件只服务当次评论请求与重试，目录按 keepNewest 滚动清扫。

import { captureScreen, releaseCapture } from 'react-native-view-shot';
import * as FileSystem from 'expo-file-system/legacy';

import { markMediaWrite } from '../mediaProtection.js';

export const SCREEN_WATCH_DIR_NAME = 'screen-watch';
const SWEEP_KEEP = 20;

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

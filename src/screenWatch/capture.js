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

/**
 * FEAT-AC3：暴露 documentDirectory 给同域模块（角色头像 uri 归一要用它）。
 *
 * 为什么由本文件暴露：本文件是 screen-watch 域的**文件系统封装点**
 *（分层规则：新文件不得直接 import expo-file-system/legacy）。
 * 同域的头像来源编排需要这个基路径，把相对头像路径补成绝对 file:// uri。
 */
export function screenWatchDocumentDirectory() {
  return FileSystem.documentDirectory || '';
}

/**
 * FEAT-AC3：把用户选的图片复制到 screen-watch 下的**专属稳定路径**，返回新 uri。
 *
 * 为什么不直接存相册/SAF 的原始 uri（任务书 P0-4 明确要求）：
 * 相册项可能被删、SAF 授权可能失效，那时头像会变成「有时能显示有时不能」。
 * 复制进应用私有目录后，源被删也不波及（先例：cardForge/media.js 的 pickForgeImage，
 * 同一套 copyAsync 到 documentDirectory 的做法）。
 *
 * 命名固定为 `overlay-avatar.<ext>`：同一时间只留一张（换图即覆盖），
 * 不留旧文件——它不像截图那样有历史价值，且固定名字让孤儿回收无需额外登记。
 *
 * @param {string} sourceUri 选择器返回的 uri
 * @param {string} [extension] 扩展名（不含点）；缺省按 sourceUri 猜，猜不到用 jpg
 * @returns {Promise<string>} 落盘后的 file:// uri（失败抛错，由调用方提示）
 */
export async function copyOverlayAvatarFile(sourceUri, extension = '') {
  const from = String(sourceUri || '').trim();
  if (!from) throw new Error('overlay-avatar-source-empty');
  const dir = screenWatchDirectory();
  await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
  const ext = String(extension || '').trim().replace(/^\./, '')
    || (from.match(/\.([A-Za-z0-9]{2,5})(?:\?|#|$)/) || [])[1]
    || 'jpg';
  const destination = `${dir}overlay-avatar.${ext}`;
  await FileSystem.copyAsync({ from, to: destination });
  // 登记媒体写入：孤儿回收不误删（与截图同一保护）。
  markMediaWrite(destination);
  return destination;
}

/** FEAT-AC3：删除自定义头像文件（用户切回默认/跟随角色时清理）。 */
export async function deleteOverlayAvatarFile(uri) {
  const target = String(uri || '').trim();
  if (!target) return;
  await FileSystem.deleteAsync(target, { idempotent: true }).catch(() => {});
}

// FIX-SW5 P1-4：进程级崩溃现场（原生 installCrashGuard 写入 screen-watch/crash-*.txt）。
// 读后**即删**：只报一次，否则每次打开 app 都会把同一次崩溃重复塞进诊断日志。
//
// 目录一致性：原生写的是 `context.filesDir/screen-watch`，而 expo-file-system 的
// documentDirectory 在 Android 上就是 `filesDir`，故两边同一目录（与 M2.5 的
// overlay-thread.jsonl 同理）。
const CRASH_FILE_PATTERN = /^crash-\d{8}-\d{6}\.txt$/;

/** 取出尚未上报的崩溃现场（按时间顺序，最多 MAX 份），并删除已读文件。 */
export async function takeCrashReports(max = 3) {
  const base = screenWatchDirectory();
  let names = [];
  try {
    names = await FileSystem.readDirectoryAsync(base);
  } catch (error) {
    return [];   // 从没用过悬浮窗 → 目录不存在，不是错误
  }
  const targets = (names || [])
    .map(item => String(item))
    .filter(name => CRASH_FILE_PATTERN.test(name))
    .sort()
    .slice(-max);
  const reports = [];
  for (const name of targets) {
    try {
      const text = await FileSystem.readAsStringAsync(`${base}${name}`);
      reports.push({ name, text: String(text || '') });
    } catch (error) {
      // 读不出来也删掉：留着一个读不了的文件只会每轮重试。
    }
    // 读完即删（无论成败）：诊断日志只该看到**一次**。
    await FileSystem.deleteAsync(`${base}${name}`, { idempotent: true }).catch(() => {});
  }
  return reports;
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

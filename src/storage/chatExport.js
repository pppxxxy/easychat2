// 对话导出文件写出：把 Markdown / HTML 文本与长图截图落到缓存目录，供系统分享。
// 放在 storage 域内，作为 expo-file-system 的封装点（lint 分层要求）。
// 导出文件是临时产物，落在 cacheDirectory（不进备份、不被媒体回收器扫描）。

import * as FileSystem from 'expo-file-system/legacy';

export const CHAT_EXPORT_DIR_NAME = 'chat-export';
const SWEEP_KEEP = 30;

export function chatExportDirectory(cacheDirectory = null) {
  const base = cacheDirectory === null ? FileSystem.cacheDirectory : cacheDirectory;
  return `${base || ''}${CHAT_EXPORT_DIR_NAME}/`;
}

// 滚动清理历史导出：只保留最近 keepNewest 个文件，避免缓存目录无限增长。
export async function sweepChatExportFiles({ keepNewest = SWEEP_KEEP } = {}) {
  try {
    const dir = chatExportDirectory();
    const names = await FileSystem.readDirectoryAsync(dir);
    const sorted = (names || []).slice().sort();
    const drop = sorted.slice(0, Math.max(0, sorted.length - Math.max(0, Math.floor(keepNewest))));
    await Promise.all(drop.map(name => FileSystem.deleteAsync(`${dir}${name}`, { idempotent: true }).catch(() => {})));
    return drop.length;
  } catch (error) {
    return 0;
  }
}

// 写文本导出（Markdown / HTML）。返回 { uri }。失败不留半成品。
export async function writeChatExportText({ fileName, content }) {
  const name = String(fileName || '').trim();
  if (!name) throw new Error('missing export file name');
  const dir = chatExportDirectory();
  await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
  const uri = `${dir}${name}`;
  try {
    await FileSystem.writeAsStringAsync(uri, String(content === null || content === undefined ? '' : content));
  } catch (error) {
    await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
    throw error;
  }
  sweepChatExportFiles().catch(() => {});
  return { uri };
}

// 把截图临时文件移动到导出目录并命名。返回 { uri }；失败清理目标半成品。
export async function persistChatExportImage({ tmpUri, fileName }) {
  const name = String(fileName || '').trim();
  if (!name) throw new Error('missing export file name');
  if (!tmpUri) throw new Error('missing capture temp uri');
  const dir = chatExportDirectory();
  await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
  const uri = `${dir}${name}`;
  try {
    await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
    await FileSystem.moveAsync({ from: tmpUri, to: uri });
  } catch (error) {
    await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
    throw error;
  }
  sweepChatExportFiles().catch(() => {});
  return { uri };
}

// 本地音频导入：DocumentPicker（SAF）选文件 → 复制到文档目录 music/<id>.<扩展名>。
// 只走系统选文件器，不申请任何存储权限（用户 2026-10-03 裁决：听歌仅做本地导入）。
// 复制失败必须清理半成品文件，避免留下指向不存在文件的幽灵条目。

import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';

import { getPickedAsset } from '../character/cardHelpers.js';
import { markMediaWrite } from '../mediaProtection.js';

import { MUSIC_DIR_NAME, saveMusicItem } from './library.js';

export function makeMusicItemId(now = Date.now()) {
  return `m-${now}-${Math.random().toString(36).slice(2, 8)}`;
}

// 展示名去掉扩展名；落盘文件的扩展名另行从原始文件名/枚举类型推导。
export function musicDisplayName(fileName) {
  const name = String(fileName || '').replace(/\.[a-z0-9]{1,8}$/i, '').trim();
  return name || '未命名歌曲';
}

export function musicFileExtension(fileName, mime) {
  const match = /\.([a-z0-9]{1,8})$/i.exec(String(fileName || ''));
  if (match) return `.${match[1].toLowerCase()}`;
  const normalized = String(mime || '').toLowerCase();
  const byMime = {
    'audio/mpeg': '.mp3',
    'audio/mp3': '.mp3',
    'audio/mp4': '.m4a',
    'audio/x-m4a': '.m4a',
    'audio/wav': '.wav',
    'audio/x-wav': '.wav',
    'audio/ogg': '.ogg',
    'audio/flac': '.flac',
    'audio/x-flac': '.flac',
    'audio/aac': '.aac',
  };
  return byMime[normalized] || '.bin';
}

// 与书一致（monkey 审查一致性提醒）：DocumentPicker 用 '*/*'——部分厂商文件管理器
// 把音频标成 application/octet-stream，用 audio/* 过滤会让文件在选文件器里选不中；
// 选后由扩展名白名单兜底拦截，非音频文件明确报错。
export const MUSIC_EXTENSIONS = ['.mp3', '.m4a', '.aac', '.wav', '.ogg', '.flac', '.opus', '.wma', '.amr'];

export function isMusicFileName(fileName) {
  const name = String(fileName || '').toLowerCase();
  return MUSIC_EXTENSIONS.some(extension => name.endsWith(extension));
}

export function musicLibraryDir(documentDirectory = null) {
  const base = documentDirectory === null ? FileSystem.documentDirectory : documentDirectory;
  return `${base || ''}${MUSIC_DIR_NAME}/`;
}

// 返回 { canceled: true } 或 { item }；导入即入库并置顶（saveMusicItem 惯例）。
// 时长在首次播放成功后由界面回填（saveMusicDuration），选文件阶段不做解码探测。
export async function importMusicFromPicker({ now = Date.now() } = {}) {
  const result = await DocumentPicker.getDocumentAsync({
    type: '*/*',
    copyToCacheDirectory: true,
    multiple: false,
  });
  const asset = getPickedAsset(result);
  if (!asset || !asset.uri) return { canceled: true };
  const id = makeMusicItemId(now);
  const fileName = String(asset.name || '');
  if (!isMusicFileName(fileName)) {
    throw Object.assign(new Error('请选择音频文件（mp3/m4a/wav/flac 等）'), { code: 'UNSUPPORTED_FORMAT' });
  }
  const dest = `${musicLibraryDir()}${id}${musicFileExtension(fileName, asset.mimeType)}`;
  await FileSystem.makeDirectoryAsync(musicLibraryDir(), { intermediates: true });
  markMediaWrite(dest);
  try {
    await FileSystem.copyAsync({ from: asset.uri, to: dest });
  } catch (error) {
    await FileSystem.deleteAsync(dest, { idempotent: true }).catch(() => {});
    throw error;
  }
  const item = await saveMusicItem({
    id,
    name: musicDisplayName(fileName),
    uri: dest,
    size: Math.max(0, Math.floor(Number(asset.size)) || 0),
    mime: String(asset.mimeType || '').trim(),
    addedAt: now,
  });
  return { item };
}

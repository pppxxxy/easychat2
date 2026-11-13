// 桌面附件文件名与字节读取（纯函数部分 Node 可测；readFileAsBase64 仅渲染进程可用）。
import { getImageMime, getVideoMime } from '../../../src/chat/mediaTypes.js';

export function extensionOf(name) {
  const value = String(name || '');
  const index = value.lastIndexOf('.');
  if (index < 0 || index === value.length - 1) return '';
  return value.slice(index + 1).toLowerCase();
}

const IMAGE_MIME_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/avif': 'avif',
};

const VIDEO_MIME_EXT = {
  'video/mp4': 'mp4',
  'video/mov': 'mov',
  'video/webm': 'webm',
  'video/3gpp': '3gp',
  'video/x-matroska': 'mkv',
};

export function imageExtension(name, mime = '') {
  const ext = extensionOf(name);
  if (ext === 'jpeg') return 'jpg';
  if (IMAGE_MIME_EXT[getImageMime(name, mime)]) return IMAGE_MIME_EXT[getImageMime(name, mime)];
  return 'jpg';
}

export function videoExtension(name, mime = '') {
  return VIDEO_MIME_EXT[getVideoMime(name, mime)] || 'mp4';
}

// 与主进程 mediaPick.pickFileName 同一命名口径：<kind>-<timestamp>-<随机>.<ext>。
export function attachmentFileName(kind, name, mime = '', now = Date.now(), random = Math.random) {
  const ext = kind === 'video' ? videoExtension(name, mime) : imageExtension(name, mime);
  const suffix = String(random).replace(/^0\./, '').slice(0, 6) || '000000';
  return `${kind}-${now}-${suffix}.${ext}`;
}

// File -> base64（不含 data: 前缀）。FileReader 在渲染进程可用，Node 测试不调用。
export function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    if (typeof FileReader === 'undefined') {
      reject(new Error('FileReader unavailable'));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error || new Error('file read failed'));
    reader.readAsDataURL(file);
  });
}

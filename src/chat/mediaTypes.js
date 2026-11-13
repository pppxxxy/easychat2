// 附件类型判定（纯函数，零平台依赖）：扩展名/MIME → 类别与规范化 MIME。
//
// 从 chat/attachments.js 外提的唯一原因：桌面渲染层需要在**没有 react-native**
// 的环境里复用同一套判定（附件命名、贴入文件识别），而 attachments.js 顶部
// import 了 react-native/expo-*。这里零依赖，Node 与渲染进程都能直接加载；
// attachments.js 原样 re-export，既有调用点不受影响。
export const TEXT_EXTENSIONS = [
  'txt', 'md', 'markdown', 'json', 'csv', 'tsv', 'log', 'xml', 'yaml', 'yml',
  'html', 'htm', 'css', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'java',
  'c', 'cpp', 'h', 'hpp', 'sh', 'ini', 'toml', 'sql', 'env', 'text',
];

export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'heic', 'heif', 'avif'];
export const VISION_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

export const VIDEO_EXTENSIONS = ['mp4', 'mov', 'm4v', 'webm', '3gp', 'mkv'];

export function extensionOf(name) {
  const value = String(name || '');
  const index = value.lastIndexOf('.');
  if (index < 0 || index === value.length - 1) return '';
  return value.slice(index + 1).toLowerCase();
}

export function isTextLike(name, mime) {
  const ext = extensionOf(name);
  if (TEXT_EXTENSIONS.includes(ext)) return true;
  const type = String(mime || '').toLowerCase();
  if (type.startsWith('text/')) return true;
  return type === 'application/json'
    || type === 'application/xml'
    || type === 'application/x-yaml'
    || type === 'application/javascript';
}

export function isImage(name, mime) {
  const type = String(mime || '').toLowerCase();
  const supportedTypes = new Set([
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/gif',
    'image/bmp',
    'image/heic',
    'image/heif',
    'image/avif',
  ]);
  if (supportedTypes.has(type)) return true;
  return IMAGE_EXTENSIONS.includes(extensionOf(name));
}

export function getImageMime(name, mime = '') {
  const type = String(mime || '').toLowerCase();
  if (type === 'image/jpg' || type === 'image/pjpeg') return 'image/jpeg';
  if (type === 'image/x-png') return 'image/png';
  if (type.startsWith('image/')) return type;
  const value = String(name || '').toLowerCase();
  if (value.endsWith('.png')) return 'image/png';
  if (value.endsWith('.webp')) return 'image/webp';
  if (value.endsWith('.gif')) return 'image/gif';
  if (value.endsWith('.heic')) return 'image/heic';
  if (value.endsWith('.heif')) return 'image/heif';
  if (value.endsWith('.avif')) return 'image/avif';
  if (value.endsWith('.bmp')) return 'image/bmp';
  return 'image/jpeg';
}

export function isVisionImage(name, mime = '') {
  return VISION_IMAGE_MIME_TYPES.includes(getImageMime(name, mime));
}

export function isVideo(name, mime) {
  const type = String(mime || '').toLowerCase();
  if (type.startsWith('video/')) return true;
  return VIDEO_EXTENSIONS.includes(extensionOf(name));
}

export function getVideoMime(name, mime = '') {
  const type = String(mime || '').toLowerCase();
  if (type === 'video/quicktime') return 'video/mov';
  if (type.startsWith('video/')) return type;
  const value = String(name || '').toLowerCase();
  if (value.endsWith('.mov')) return 'video/mov';
  if (value.endsWith('.m4v')) return 'video/mp4';
  if (value.endsWith('.webm')) return 'video/webm';
  if (value.endsWith('.3gp')) return 'video/3gpp';
  if (value.endsWith('.mkv')) return 'video/x-matroska';
  return 'video/mp4';
}

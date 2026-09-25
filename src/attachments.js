import { Image } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system';
import { markMediaWrite } from './mediaProtection';

export const TEXT_EXTENSIONS = [
  'txt', 'md', 'markdown', 'json', 'csv', 'tsv', 'log', 'xml', 'yaml', 'yml',
  'html', 'htm', 'css', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'java',
  'c', 'cpp', 'h', 'hpp', 'sh', 'ini', 'toml', 'sql', 'env', 'text',
];

export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'heic', 'heif', 'avif'];
export const VISION_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

export const MAX_TEXT_BYTES = 200 * 1024;

export const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
export const MAX_IMAGE_TOTAL_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGE_BASE64_BYTES = 28 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 16_000_000;
export const MAX_IMAGE_ATTACHMENTS = 3;

function extensionOf(name) {
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

export function validateImageDimensions({ width = 0, height = 0 } = {}) {
  const pixelWidth = Number(width);
  const pixelHeight = Number(height);
  if (
    !Number.isFinite(pixelWidth)
    || !Number.isFinite(pixelHeight)
    || pixelWidth <= 0
    || pixelHeight <= 0
  ) {
    throw new Error('图片尺寸无效');
  }
  if (pixelWidth * pixelHeight > MAX_IMAGE_PIXELS) {
    throw new Error('图片分辨率过大');
  }
  return { width: pixelWidth, height: pixelHeight };
}

export function validateImageSize({ size = 0, width, height } = {}) {
  const bytes = Number(size);
  if (Number.isFinite(bytes) && bytes > MAX_IMAGE_BYTES) {
    throw new Error('图片过大');
  }
  if (width !== undefined || height !== undefined) {
    validateImageDimensions({ width, height });
  }
  return true;
}

export function validateImageBatch(items, { requireDimensions = false } = {}) {
  const list = Array.isArray(items) ? items : [];
  if (list.length > MAX_IMAGE_ATTACHMENTS) {
    throw new Error('图片过多');
  }
  if (list.some(item => {
    const size = Number(item && item.size);
    return !Number.isFinite(size) || size <= 0;
  })) {
    throw new Error('无法读取图片大小');
  }
  list.forEach(item => {
    validateImageSize(item);
    if (requireDimensions) validateImageDimensions(item);
  });
  const total = list.reduce((sum, item) => sum + Number(item.size), 0);
  if (total > MAX_IMAGE_TOTAL_BYTES) {
    throw new Error('图片总大小过大');
  }
  return total;
}

function pickAsset(result) {
  if (!result || result.canceled || result.type === 'cancel') return null;
  if (Array.isArray(result.assets) && result.assets[0]) return result.assets[0];
  if (result.uri) return result;
  return null;
}

export async function pickAttachment(type = '*/*') {
  const result = await DocumentPicker.getDocumentAsync({
    type,
    copyToCacheDirectory: true,
    multiple: false,
  });
  const asset = pickAsset(result);
  if (!asset?.uri) return null;
  return {
    uri: asset.uri,
    name: asset.name || '未命名文件',
    mime: asset.mimeType || '',
    size: Number(asset.size) || 0,
    width: Number(asset.width) || 0,
    height: Number(asset.height) || 0,
  };
}

function normalizeStickerResult(result) {
  const asset = result && !result.canceled && result.assets && result.assets[0];
  if (!asset?.uri) return null;
  return {
    uri: asset.uri,
    name: asset.fileName || '表情包图片',
    mime: asset.mimeType || 'image/jpeg',
    width: Number(asset.width) || 0,
    height: Number(asset.height) || 0,
    size: Number(asset.fileSize) || 0,
  };
}

export async function getPendingStickerImage() {
  const pending = await ImagePicker.getPendingResultAsync().catch(() => []);
  const results = Array.isArray(pending) ? pending : [pending];
  for (const result of results) {
    const normalized = normalizeStickerResult(result);
    if (normalized) return normalized;
  }
  return null;
}

export async function pickStickerImage() {
  const pending = await getPendingStickerImage();
  if (pending) return pending;
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ImagePicker.MediaTypeOptions.Images,
    allowsEditing: false,
    quality: 1,
  });
  return normalizeStickerResult(result);
}

export async function getImageFileInfo(uri) {
  const info = await FileSystem.getInfoAsync(uri);
  return {
    exists: info && info.exists !== false,
    size: Number(info && info.size) || 0,
  };
}

export function getImageDimensions(uri) {
  return new Promise((resolve, reject) => {
    Image.getSize(uri, (width, height) => resolve({ width, height }), reject);
  });
}

export function isTemporaryImageUri(uri) {
  const value = String(uri || '');
  const cacheDirectory = String(FileSystem.cacheDirectory || '');
  return !!cacheDirectory && value.startsWith(cacheDirectory);
}

export async function deleteTemporaryImage(uri) {
  if (!isTemporaryImageUri(uri)) return;
  try {
    await FileSystem.deleteAsync(String(uri), { idempotent: true });
  } catch (error) {}
}

export async function persistImageAttachment(uri, mime = '', name = '') {
  const sourceUri = String(uri || '');
  if (!sourceUri) throw new Error('图片路径无效');
  const directory = `${FileSystem.documentDirectory || ''}chat-images/`;
  await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
  const type = String(mime || '').toLowerCase();
  const sourceName = String(name || '').toLowerCase();
  const extension = type.includes('png') || sourceName.endsWith('.png')
    ? 'png'
    : type.includes('webp') || sourceName.endsWith('.webp')
      ? 'webp'
      : type.includes('gif') || sourceName.endsWith('.gif')
        ? 'gif'
        : type.includes('heic') || sourceName.endsWith('.heic')
          ? 'heic'
          : type.includes('heif') || sourceName.endsWith('.heif')
            ? 'heif'
            : type.includes('avif') || sourceName.endsWith('.avif')
              ? 'avif'
              : type.includes('bmp') || sourceName.endsWith('.bmp')
                ? 'bmp'
                : 'jpg';
  const destination = `${directory}image-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${extension}`;
  markMediaWrite(destination);
  try {
    await FileSystem.copyAsync({ from: sourceUri, to: destination });
    return destination;
  } catch (error) {
    await FileSystem.deleteAsync(destination, { idempotent: true }).catch(() => {});
    throw error;
  }
}

export async function deleteLocalImage(uri) {
  const value = String(uri || '');
  if (!value.includes('/chat-images/')) return;
  try {
    await FileSystem.deleteAsync(value, { idempotent: true });
  } catch (error) {}
}

export async function readTextAttachment(uri, maxBytes = MAX_TEXT_BYTES) {
  const info = await FileSystem.getInfoAsync(uri);
  if (!info || info.exists === false) throw new Error('文件不存在');
  if (Number(info.size) > maxBytes) throw new Error('文件过大');
  return FileSystem.readAsStringAsync(uri);
}

export async function readImageDataUri(uri, mime) {
  const base64 = await FileSystem.readAsStringAsync(uri, {
    encoding: FileSystem.EncodingType.Base64,
  });
  const type = getImageMime(String(uri || '').split('?')[0], mime);
  return `data:${type};base64,${base64}`;
}

export function mergeTextAttachments(userText, attachments) {
  const list = (Array.isArray(attachments) ? attachments : [])
    .filter(item => item && item.kind === 'text' && String(item.text || '').trim());
  if (list.length === 0) return String(userText || '');
  const blocks = list.map(item =>
    `[附件：${item.name}]\n${String(item.text).trim()}`
  );
  const base = String(userText || '').trim();
  return [base, ...blocks].filter(Boolean).join('\n\n');
}

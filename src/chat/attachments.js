import { Image } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { markMediaWrite } from '../storage/mediaProtection.js';
import { decodeBytes } from '../books/decodeText.js';
import { tActive } from '../i18n/index.js';

// 校验/落盘失败抛带 code 的 Error：message 走 i18n（随语言变化），
// 调用方需要按失败原因分流提示时比 code，不要比 message。
function attachError(key, code) {
  const error = new Error(tActive(key));
  error.code = code;
  return error;
}

// 供调用方（useChatSend 等）比对的错误码常量。
export const ATTACH_ERROR = {
  VIDEO_SIZE_UNREADABLE: 'ATTACH_VIDEO_SIZE_UNREADABLE',
  VIDEO_TOO_LARGE: 'ATTACH_VIDEO_TOO_LARGE',
  IMAGE_DIMENSIONS_INVALID: 'ATTACH_IMAGE_DIMENSIONS_INVALID',
  IMAGE_RESOLUTION_TOO_LARGE: 'ATTACH_IMAGE_RESOLUTION_TOO_LARGE',
  IMAGE_TOO_LARGE: 'ATTACH_IMAGE_TOO_LARGE',
  TOO_MANY_IMAGES: 'ATTACH_TOO_MANY_IMAGES',
  IMAGE_SIZE_UNREADABLE: 'ATTACH_IMAGE_SIZE_UNREADABLE',
  IMAGE_TOTAL_TOO_LARGE: 'ATTACH_IMAGE_TOTAL_TOO_LARGE',
  IMAGE_PATH_INVALID: 'ATTACH_IMAGE_PATH_INVALID',
  VIDEO_PATH_INVALID: 'ATTACH_VIDEO_PATH_INVALID',
  FILE_NOT_FOUND: 'ATTACH_FILE_NOT_FOUND',
  FILE_TOO_LARGE: 'ATTACH_FILE_TOO_LARGE',
};

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

// 视频附件（仅当模型声明 supportsVideo 且走 OpenAI 兼容协议时解锁，见 ChatScreen 门控）。
// 数据 URI 会 base64 膨胀 4/3，限额按「多数兼容端点可接受的请求体」量级设定；
// 一次只带一条视频——两条膨胀后的请求体很容易越过端点上限。
export const VIDEO_EXTENSIONS = ['mp4', 'mov', 'm4v', 'webm', '3gp', 'mkv'];
export const MAX_VIDEO_BYTES = 20 * 1024 * 1024;
export const MAX_VIDEO_BASE64_BYTES = 28 * 1024 * 1024;
export const MAX_VIDEO_ATTACHMENTS = 1;
// 拍摄时长上限（秒）：默认一分钟，避免一次录出几百 MB 的素材。
export const VIDEO_MAX_DURATION_S = 60;

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

// 视频：按 mime 或扩展名识别（相册/文件管理器给的 mime 经常缺失或不准）。
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

// 视频只校验大小（时长/分辨率交给模型与端点的宽容度，不做本地硬判）。
export function validateVideoSize({ size = 0 } = {}) {
  const bytes = Number(size);
  if (!Number.isFinite(bytes) || bytes <= 0) throw attachError('chat.error.attach.videoSizeUnreadable', ATTACH_ERROR.VIDEO_SIZE_UNREADABLE);
  if (bytes > MAX_VIDEO_BYTES) throw attachError('chat.error.attach.videoTooLarge', ATTACH_ERROR.VIDEO_TOO_LARGE);
  return true;
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
    throw attachError('chat.error.attach.imageDimensionsInvalid', ATTACH_ERROR.IMAGE_DIMENSIONS_INVALID);
  }
  if (pixelWidth * pixelHeight > MAX_IMAGE_PIXELS) {
    throw attachError('chat.error.attach.imageResolutionTooLarge', ATTACH_ERROR.IMAGE_RESOLUTION_TOO_LARGE);
  }
  return { width: pixelWidth, height: pixelHeight };
}

export function validateImageSize({ size = 0, width, height } = {}) {
  const bytes = Number(size);
  if (Number.isFinite(bytes) && bytes > MAX_IMAGE_BYTES) {
    throw attachError('chat.error.attach.imageTooLarge', ATTACH_ERROR.IMAGE_TOO_LARGE);
  }
  if (width !== undefined || height !== undefined) {
    validateImageDimensions({ width, height });
  }
  return true;
}

export function validateImageBatch(items, { requireDimensions = false } = {}) {
  const list = Array.isArray(items) ? items : [];
  if (list.length > MAX_IMAGE_ATTACHMENTS) {
    throw attachError('chat.error.attach.tooManyImages', ATTACH_ERROR.TOO_MANY_IMAGES);
  }
  if (list.some(item => {
    const size = Number(item && item.size);
    return !Number.isFinite(size) || size <= 0;
  })) {
    throw attachError('chat.error.attach.imageSizeUnreadable', ATTACH_ERROR.IMAGE_SIZE_UNREADABLE);
  }
  list.forEach(item => {
    validateImageSize(item);
    if (requireDimensions) validateImageDimensions(item);
  });
  const total = list.reduce((sum, item) => sum + Number(item.size), 0);
  if (total > MAX_IMAGE_TOTAL_BYTES) {
    throw attachError('chat.error.attach.imageTotalTooLarge', ATTACH_ERROR.IMAGE_TOTAL_TOO_LARGE);
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
    name: asset.name || tActive('chat.attach.unnamedFile'),
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
    name: asset.fileName || tActive('chat.attach.stickerImage'),
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

// ---- 相机拍照附件 ----

// 归一化拍照结果：与相册选图同一形状，供 addAttachment 的图片分支复用。
function normalizeCameraResult(result) {
  const asset = result && !result.canceled && result.assets && result.assets[0];
  if (!asset?.uri) return null;
  return {
    uri: asset.uri,
    name: asset.fileName || `拍照_${Date.now()}.jpg`,
    mime: asset.mimeType || 'image/jpeg',
    width: Number(asset.width) || 0,
    height: Number(asset.height) || 0,
    size: Number(asset.fileSize) || 0,
  };
}

// 拍照结果可能是 'granted' | 'denied' | 'undetermined'；仅在明确 denied 时视为拒绝，
// 否则交给系统弹窗（这样「未决定」的首用场景不会被误判成拒绝）。
export function isCameraPermissionDenied(permission) {
  const status = String((permission && permission.status) || '');
  return status === 'denied';
}

export async function requestCameraPermission() {
  const current = await ImagePicker.getCameraPermissionsAsync().catch(() => null);
  if (current && current.granted) return current;
  return ImagePicker.requestCameraPermissionsAsync();
}

// 拍照取图。权限被拒时返回 { denied: true }，由调用方给出可操作的提示；
// 用户取消拍照返回 null（与相册选图的取消语义一致）。
export async function takePhoto() {
  const permission = await requestCameraPermission();
  if (isCameraPermissionDenied(permission)) return { denied: true };
  const result = await ImagePicker.launchCameraAsync({
    mediaTypes: ImagePicker.MediaTypeOptions.Images,
    allowsEditing: false,
    quality: 1,
    cameraType: ImagePicker.CameraType?.back,
  });
  return normalizeCameraResult(result);
}

// ---- 视频附件（上传 / 拍摄） ----

// 归一化视频结果：与图片同一形状（含 fileName/size），供 addAttachment 的视频分支复用。
function normalizeVideoResult(result) {
  const asset = result && !result.canceled && result.assets && result.assets[0];
  if (!asset?.uri) return null;
  return {
    uri: asset.uri,
    name: asset.fileName || `视频_${Date.now()}.mp4`,
    mime: asset.mimeType || '',
    width: Number(asset.width) || 0,
    height: Number(asset.height) || 0,
    size: Number(asset.fileSize) || 0,
  };
}

// 从相册选视频。
export async function pickVideoAttachment() {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ImagePicker.MediaTypeOptions.Videos,
    allowsEditing: false,
    quality: 1,
  });
  return normalizeVideoResult(result);
}

// 拍摄视频（需要相机权限；与拍照共用拒绝语义）。限制时长，防止录出超大素材。
export async function recordVideo() {
  const permission = await requestCameraPermission();
  if (isCameraPermissionDenied(permission)) return { denied: true };
  const result = await ImagePicker.launchCameraAsync({
    mediaTypes: ImagePicker.MediaTypeOptions.Videos,
    allowsEditing: false,
    videoMaxDuration: VIDEO_MAX_DURATION_S,
    cameraType: ImagePicker.CameraType?.back,
  });
  return normalizeVideoResult(result);
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
  if (!sourceUri) throw attachError('chat.error.attach.imagePathInvalid', ATTACH_ERROR.IMAGE_PATH_INVALID);
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

// 视频落盘：独立目录 chat-videos/（不进图片清扫，由各自引用方管理生命周期）。
export async function persistVideoAttachment(uri, mime = '', name = '') {
  const sourceUri = String(uri || '');
  if (!sourceUri) throw attachError('chat.error.attach.videoPathInvalid', ATTACH_ERROR.VIDEO_PATH_INVALID);
  const directory = `${FileSystem.documentDirectory || ''}chat-videos/`;
  await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
  const type = getVideoMime(name, mime);
  const extension = type === 'video/mov'
    ? 'mov'
    : type === 'video/webm'
      ? 'webm'
      : type === 'video/3gpp'
        ? '3gp'
        : type === 'video/x-matroska'
          ? 'mkv'
          : 'mp4';
  const destination = `${directory}video-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${extension}`;
  markMediaWrite(destination);
  try {
    await FileSystem.copyAsync({ from: sourceUri, to: destination });
    return destination;
  } catch (error) {
    await FileSystem.deleteAsync(destination, { idempotent: true }).catch(() => {});
    throw error;
  }
}

export async function deleteLocalVideo(uri) {
  const value = String(uri || '');
  if (!value.includes('/chat-videos/')) return;
  try {
    await FileSystem.deleteAsync(value, { idempotent: true });
  } catch (error) {}
}

export async function readTextAttachment(uri, maxBytes = MAX_TEXT_BYTES) {
  const info = await FileSystem.getInfoAsync(uri);
  if (!info || info.exists === false) throw attachError('chat.error.attach.fileNotFound', ATTACH_ERROR.FILE_NOT_FOUND);
  if (Number(info.size) > maxBytes) throw attachError('chat.error.attach.fileTooLarge', ATTACH_ERROR.FILE_TOO_LARGE);
  // 以 base64 读原始字节再按编码探测解码：纯 UTF-8 读取会让 GBK/BIG5/UTF-16
  // 文本变成乱码。复用书籍导入同一套 decodeBytes（BOM → 严格 UTF-8 → UTF-16 启发 →
  // GB18030/BIG5/UTF-16 评分择优）；识别失败时抛 { code:'ENCODING' } 由界面提示。
  const base64 = await FileSystem.readAsStringAsync(uri, {
    encoding: FileSystem.EncodingType.Base64,
  });
  const bytes = Buffer.from(base64, 'base64');
  const { text } = decodeBytes(bytes);
  return text;
}

export async function readImageDataUri(uri, mime) {
  const base64 = await FileSystem.readAsStringAsync(uri, {
    encoding: FileSystem.EncodingType.Base64,
  });
  const type = getImageMime(String(uri || '').split('?')[0], mime);
  return `data:${type};base64,${base64}`;
}

// 视频数据 URI（与图片同构；条数上限 1，配合 MAX_VIDEO_BASE64_BYTES 控制请求体）。
export async function readVideoDataUri(uri, mime) {
  const base64 = await FileSystem.readAsStringAsync(uri, {
    encoding: FileSystem.EncodingType.Base64,
  });
  const type = getVideoMime(String(uri || '').split('?')[0], mime);
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

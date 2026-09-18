import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';

export const TEXT_EXTENSIONS = [
  'txt', 'md', 'markdown', 'json', 'csv', 'tsv', 'log', 'xml', 'yaml', 'yml',
  'html', 'htm', 'css', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'java',
  'c', 'cpp', 'h', 'hpp', 'sh', 'ini', 'toml', 'sql', 'env', 'text',
];

export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'];

export const MAX_TEXT_BYTES = 200 * 1024;

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
  if (type.startsWith('image/')) return true;
  return IMAGE_EXTENSIONS.includes(extensionOf(name));
}

function pickAsset(result) {
  if (!result || result.canceled || result.type === 'cancel') return null;
  if (Array.isArray(result.assets) && result.assets[0]) return result.assets[0];
  if (result.uri) return result;
  return null;
}

export async function pickAttachment() {
  const result = await DocumentPicker.getDocumentAsync({
    type: '*/*',
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
  };
}

export async function readTextAttachment(uri, maxBytes = MAX_TEXT_BYTES) {
  try {
    const info = await FileSystem.getInfoAsync(uri);
    if (info && Number(info.size) > maxBytes) {
      throw new Error('文件过大');
    }
  } catch (error) {
    if (error && error.message === '文件过大') throw error;
  }
  return FileSystem.readAsStringAsync(uri);
}

export async function readImageDataUri(uri, mime) {
  const base64 = await FileSystem.readAsStringAsync(uri, {
    encoding: FileSystem.EncodingType.Base64,
  });
  const type = String(mime || '').toLowerCase().startsWith('image/') ? mime : 'image/png';
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

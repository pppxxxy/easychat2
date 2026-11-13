// 备份包媒体路径重写（纯函数）：跨平台 / 跨安装恢复时把绝对路径收敛到当前文档目录。
//
// 背景（Requirement 9.4）：备份包里有两处媒体路径——
//   1. `media[].path`：相对路径（chat-images/x.jpg），但也可能来自更早的导出或手工包，
//      带 `file:///data/user/0/<pkg>/...` 或 `C:\...\EasyChat2\...` 这类绝对路径；
//   2. 存储值里的 `avatarUri` / `image.uri` / `sticker.uri` 等：Android 存的是本机
//      绝对 file:// URI，换一台机器/换一个安装后全部悬空。
// 这里只做**判定与改写**：只认 BACKUP_MEDIA_DIRECTORIES 白名单内的目录，其余字符串
// 原样保留；`opaqueRaw`（损坏抢救的原始串）不碰——它的价值就是字节不变。
//
// 双向可用：Android 恢复桌面备份时，Windows 路径同样会被收敛到 Android 的
// documentDirectory；因此重写逻辑放在共享层，两个平台导入前各调用一次。
import { BACKUP_MEDIA_DIRECTORIES } from './dataBackup.js';

const FILE_SCHEME_PATTERN = /^file:\/\//i;
const WINDOWS_DRIVE_PATTERN = /^[a-zA-Z]:[\\/]/;
const POSIX_ABSOLUTE_PATTERN = /^\//;

function normalizeSlashes(value) {
  return String(value || '').replace(/\\/g, '/');
}

function decodeFileUrl(value) {
  try {
    return decodeURIComponent(new URL(value).pathname);
  } catch (error) {
    return decodeURIComponent(String(value).replace(FILE_SCHEME_PATTERN, ''));
  }
}

// 是否是「可能带旧安装根路径」的绝对路径。相对路径（chat-images/x.jpg）不参与改写：
// 它已经相对 documents/，导入侧会拼上新的 documentDirectory。
export function looksLikeAbsoluteMediaPath(value) {
  if (typeof value !== 'string') return false;
  const raw = value.trim();
  return FILE_SCHEME_PATTERN.test(raw)
    || WINDOWS_DRIVE_PATTERN.test(raw)
    || POSIX_ABSOLUTE_PATTERN.test(raw);
}

// 从任意平台的绝对路径里提取 `<媒体目录>/<相对路径>`；不在白名单目录内返回空串。
export function mediaRelativePathFromAbsolute(value, directories = BACKUP_MEDIA_DIRECTORIES) {
  if (!looksLikeAbsoluteMediaPath(value)) return '';
  let raw = String(value || '').trim();
  if (FILE_SCHEME_PATTERN.test(raw)) raw = decodeFileUrl(raw);
  raw = normalizeSlashes(raw);
  // Windows file URL 解析后形如 /C:/Users/...：去掉盘符前的斜杠。
  if (/^\/[A-Za-z]:\//.test(raw)) raw = raw.slice(1);
  const lower = raw.toLowerCase();
  let best = '';
  for (const directory of directories) {
    const marker = `/${String(directory).toLowerCase()}/`;
    const index = lower.lastIndexOf(marker);
    if (index === -1) continue;
    const relative = raw.slice(index + marker.length);
    if (!relative || relative.split('/').includes('..')) continue;
    best = `${directory}/${relative}`;
  }
  return best;
}

function uriWithDocumentDirectory(documentDirectory, relativePath) {
  const base = String(documentDirectory || '');
  if (!base || !relativePath) return '';
  return `${base.endsWith('/') ? base : `${base}/`}${relativePath}`;
}

// 单值改写：不在白名单目录内的字符串原样返回。
export function rewriteMediaUri(value, documentDirectory, directories = BACKUP_MEDIA_DIRECTORIES) {
  const relative = mediaRelativePathFromAbsolute(value, directories);
  if (!relative) return value;
  return uriWithDocumentDirectory(documentDirectory, relative) || value;
}

// 递归改写存储值。未发生变化的子树返回原引用（大备份不做无谓深拷贝）。
function rewriteStorageValue(value, context, depth = 0) {
  if (depth > 32) return value;
  if (typeof value === 'string') {
    if (!looksLikeAbsoluteMediaPath(value)) return value;
    const relative = mediaRelativePathFromAbsolute(value, context.directories);
    if (!relative) return value;
    const next = uriWithDocumentDirectory(context.documentDirectory, relative);
    if (!next || next === value) return value;
    context.rewrittenUris += 1;
    return next;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const out = new Array(value.length);
    for (let index = 0; index < value.length; index += 1) {
      const next = rewriteStorageValue(value[index], context, depth + 1);
      if (next !== value[index]) changed = true;
      out[index] = next;
    }
    return changed ? out : value;
  }
  if (value && typeof value === 'object') {
    let changed = false;
    const out = {};
    for (const key of Object.keys(value)) {
      const next = rewriteStorageValue(value[key], context, depth + 1);
      if (next !== value[key]) changed = true;
      out[key] = next;
    }
    return changed ? out : value;
  }
  return value;
}

/**
 * 就地改写 payload（调用方刚 parse 出来的局部对象），返回统计：
 * `{ payload, rewrittenMediaPaths, rewrittenUris }`。
 * 不修改 `opaqueRaw`，不触碰白名单外的路径。
 */
export function rewriteBackupMediaPaths(payload, {
  documentDirectory = '',
  directories = BACKUP_MEDIA_DIRECTORIES,
} = {}) {
  if (!payload || typeof payload !== 'object' || !documentDirectory) {
    return { payload, rewrittenMediaPaths: 0, rewrittenUris: 0 };
  }
  let rewrittenMediaPaths = 0;
  if (Array.isArray(payload.media)) {
    payload.media = payload.media.map(item => {
      if (!item || typeof item.path !== 'string') return item;
      const relative = mediaRelativePathFromAbsolute(item.path, directories);
      if (!relative || relative === item.path) return item;
      rewrittenMediaPaths += 1;
      return { ...item, path: relative };
    });
  }
  const context = { documentDirectory, directories, rewrittenUris: 0 };
  if (Array.isArray(payload.storage)) {
    payload.storage = payload.storage.map(item => {
      if (!item || typeof item !== 'object' || item.opaqueRaw !== undefined) return item;
      if (item.value === undefined) return item;
      return { ...item, value: rewriteStorageValue(item.value, context) };
    });
  }
  return { payload, rewrittenMediaPaths, rewrittenUris: context.rewrittenUris };
}

export default rewriteBackupMediaPaths;

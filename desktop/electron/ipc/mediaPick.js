// 用户主动选择媒体后的导入（主进程）：文件对话框 + 复制进 documents/。
//
// 为什么必须整体收在主进程：渲染进程只有 documents/cache 两棵子树的文件权限，
// 直接读取用户桌面/下载目录的任意路径既不经过边界校验，也不该暴露给页面脚本。
// 因此这里**只接受本 IPC 自己弹出的对话框结果**，不接受渲染层传入的路径——
// 选什么文件由系统原生对话框决定，复制目标由主进程生成。
//
// 贴入/拖入的字节流走另一条路（渲染进程 File -> fs.write base64），见
// desktop/src/attachments/useDesktopAttachments.js。
import fs from 'node:fs';
import path from 'node:path';

import { toFileUrl } from '../paths.js';

// 与 src/chat/attachments.js 的限额保持一致（desktop/tests/ipc/mediaPick.test.mjs
// 解析源文件逐项比对，防两份口径漂移）。
export const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 20 * 1024 * 1024;
export const MAX_TEXT_BYTES = 200 * 1024;

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'heic', 'heif', 'avif'];
const VIDEO_EXTENSIONS = ['mp4', 'mov', 'm4v', 'webm', '3gp', 'mkv'];
const TEXT_EXTENSIONS = [
  'txt', 'md', 'markdown', 'json', 'csv', 'tsv', 'log', 'xml', 'yaml', 'yml',
  'html', 'htm', 'css', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'java',
  'c', 'cpp', 'h', 'hpp', 'sh', 'ini', 'toml', 'sql', 'env', 'text',
];

const IMAGE_FILTERS = [{ name: 'Images', extensions: IMAGE_EXTENSIONS }];
const VIDEO_FILTERS = [{ name: 'Videos', extensions: VIDEO_EXTENSIONS }];
const TEXT_FILTERS = [{ name: 'Text', extensions: TEXT_EXTENSIONS }];

export const PICK_KINDS = Object.freeze({
  image: {
    dir: 'chat-images',
    prefix: 'image',
    maxBytes: MAX_IMAGE_BYTES,
    extensions: IMAGE_EXTENSIONS,
    multi: true,
    filters: IMAGE_FILTERS,
  },
  video: {
    dir: 'chat-videos',
    prefix: 'video',
    maxBytes: MAX_VIDEO_BYTES,
    extensions: VIDEO_EXTENSIONS,
    multi: false,
    filters: VIDEO_FILTERS,
  },
  text: {
    dir: '',
    prefix: 'text',
    maxBytes: MAX_TEXT_BYTES,
    extensions: TEXT_EXTENSIONS,
    multi: false,
    filters: TEXT_FILTERS,
    readText: true,
  },
  // 表情包导入：先落到 cache/sticker-import/（渲染层做 50% 缩放后再写 stickers/）。
  // 放 cache 而不是 documents，避免中途失败留下孤儿文件。
  'sticker-source': {
    dir: 'sticker-import',
    prefix: 'sticker-src',
    root: 'cache',
    maxBytes: MAX_IMAGE_BYTES,
    extensions: IMAGE_EXTENSIONS,
    multi: false,
    filters: IMAGE_FILTERS,
  },
});

export function extensionOf(name) {
  const value = String(name || '');
  const index = value.lastIndexOf('.');
  if (index < 0 || index === value.length - 1) return '';
  return value.slice(index + 1).toLowerCase();
}

export function pickFileName(kind, sourceName, now = Date.now(), random = Math.random) {
  const spec = PICK_KINDS[kind];
  const ext = extensionOf(sourceName) || (kind === 'video' ? 'mp4' : 'jpg');
  const suffix = String(random).replace(/^0\./, '').slice(0, 6) || '000000';
  return `${spec ? spec.prefix : kind}-${now}-${suffix}.${ext}`;
}

// 依赖注入便于 Node 测试（生产由 main.js 传入 Electron 的 dialog 与 node:fs）。
export function registerMediaPickIpc(ipcMain, { dialog, documentsRoot, cacheRoot, fsImpl = fs } = {}) {
  if (!dialog || !documentsRoot) throw new Error('registerMediaPickIpc: dialog/documentsRoot required');

  ipcMain.handle('media:pick', async (event, rawKind) => {
    const kind = String(rawKind || '');
    const spec = PICK_KINDS[kind];
    if (!spec) throw new Error(`unknown media kind: ${kind}`);
    const result = await dialog.showOpenDialog({
      properties: spec.multi ? ['openFile', 'multiSelections'] : ['openFile'],
      filters: spec.filters,
    });
    if (result.canceled) return { canceled: true, items: [], errors: [] };

    const items = [];
    const errors = [];
    for (const sourcePath of result.filePaths || []) {
      const name = path.basename(String(sourcePath || ''));
      try {
        const stat = fsImpl.statSync(sourcePath);
        if (!stat.isFile()) {
          errors.push({ name, code: 'NOT_FILE' });
          continue;
        }
        if (stat.size > spec.maxBytes) {
          errors.push({ name, code: 'TOO_LARGE', size: stat.size, maxBytes: spec.maxBytes });
          continue;
        }
        if (!spec.extensions.includes(extensionOf(sourcePath))) {
          errors.push({ name, code: 'UNSUPPORTED' });
          continue;
        }
        if (spec.readText) {
          const buffer = fsImpl.readFileSync(sourcePath);
          items.push({ name, size: buffer.length, base64: buffer.toString('base64') });
          continue;
        }
        const directory = path.join(spec.root === 'cache' ? cacheRoot : documentsRoot, spec.dir);
        fsImpl.mkdirSync(directory, { recursive: true });
        const destination = path.join(directory, pickFileName(kind, sourcePath));
        fsImpl.copyFileSync(sourcePath, destination);
        items.push({ name, size: stat.size, uri: toFileUrl(destination) });
      } catch (error) {
        errors.push({ name, code: 'READ_FAILED' });
      }
    }
    return { canceled: false, items, errors };
  });
}

export default registerMediaPickIpc;

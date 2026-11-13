// 备份 / 角色卡的文件进出口（主进程）。
//
// 三个动作都要「对话框 + 真实文件系统」：
//   · backup:pick    选备份 JSON -> 复制到 cache/backup-import/，渲染层用流式读取；
//   · backup:saveAs  把渲染层生成的文件（documents/cache 内）经系统另存为对话框复制出去；
//   · card:pick      选角色卡 PNG/JSON -> 读成 base64（卡片上限 32MB）。
//
// 安全：saveAs 的**源**必须位于 documents/cache 内（渲染层不能借它读走任意文件）；
// pick/card 的目标由系统对话框决定，渲染层不传任何路径。
import fs from 'node:fs';
import path from 'node:path';

import { createPathResolver, toFileUrl } from '../paths.js';

export const MAX_CARD_BYTES = 32 * 1024 * 1024;
const BACKUP_EXTENSIONS = ['json'];
const CARD_EXTENSIONS = ['png', 'json'];

function extensionOf(name) {
  const value = String(name || '');
  const index = value.lastIndexOf('.');
  if (index < 0 || index === value.length - 1) return '';
  return value.slice(index + 1).toLowerCase();
}

function stamp(random = Math.random) {
  return String(random).replace(/^0\./, '').slice(0, 6) || '000000';
}

export function registerBackupFileIpc(ipcMain, {
  dialog,
  documentsRoot,
  cacheRoot,
  fsImpl = fs,
} = {}) {
  if (!dialog || !documentsRoot || !cacheRoot) {
    throw new Error('registerBackupFileIpc: dialog/documentsRoot/cacheRoot required');
  }
  const resolver = createPathResolver([documentsRoot, cacheRoot]);

  ipcMain.handle('backup:pick', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Backup', extensions: BACKUP_EXTENSIONS }],
    });
    if (result.canceled || !result.filePaths || !result.filePaths[0]) {
      return { canceled: true };
    }
    const source = String(result.filePaths[0]);
    const name = path.basename(source);
    if (!BACKUP_EXTENSIONS.includes(extensionOf(name))) {
      return { canceled: false, error: 'UNSUPPORTED' };
    }
    let size = 0;
    try {
      const stat = fsImpl.statSync(source);
      if (!stat.isFile()) return { canceled: false, error: 'NOT_FILE' };
      size = stat.size;
    } catch (error) {
      return { canceled: false, error: 'READ_FAILED' };
    }
    const directory = path.join(cacheRoot, 'backup-import');
    fsImpl.mkdirSync(directory, { recursive: true });
    const destination = path.join(directory, `backup-${Date.now()}-${stamp()}.json`);
    try {
      fsImpl.copyFileSync(source, destination);
    } catch (error) {
      return { canceled: false, error: 'READ_FAILED' };
    }
    return { canceled: false, uri: toFileUrl(destination), name, size };
  });

  ipcMain.handle('backup:saveAs', async (event, rawSourceUri, defaultName, filters) => {
    let source = '';
    try {
      source = resolver.resolve(String(rawSourceUri || ''));
    } catch (error) {
      const failure = new Error('Source is outside the allowed roots');
      failure.code = 'PATH_OUTSIDE_ROOT';
      throw failure;
    }
    const suggested = String(defaultName || path.basename(source) || 'easychat2-export');
    const result = await dialog.showSaveDialog({
      defaultPath: suggested,
      filters: Array.isArray(filters) && filters.length > 0
        ? filters
        : [{ name: 'JSON', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    fsImpl.copyFileSync(source, result.filePath);
    return { canceled: false, path: result.filePath };
  });

  ipcMain.handle('card:pick', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Character card', extensions: CARD_EXTENSIONS }],
    });
    if (result.canceled || !result.filePaths || !result.filePaths[0]) {
      return { canceled: true };
    }
    const source = String(result.filePaths[0]);
    const name = path.basename(source);
    const extension = extensionOf(name);
    if (!CARD_EXTENSIONS.includes(extension)) {
      return { canceled: false, error: 'UNSUPPORTED' };
    }
    try {
      const stat = fsImpl.statSync(source);
      if (!stat.isFile()) return { canceled: false, error: 'NOT_FILE' };
      if (stat.size > MAX_CARD_BYTES) {
        return { canceled: false, error: 'TOO_LARGE', size: stat.size, maxBytes: MAX_CARD_BYTES };
      }
      const buffer = fsImpl.readFileSync(source);
      return {
        canceled: false,
        name,
        extension,
        size: buffer.length,
        base64: buffer.toString('base64'),
      };
    } catch (error) {
      return { canceled: false, error: 'READ_FAILED' };
    }
  });
}

export default registerBackupFileIpc;

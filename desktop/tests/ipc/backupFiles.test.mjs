// 备份/角色卡文件 IPC：暂存到 cache、另存到用户位置、源路径边界、卡片大小上限。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  MAX_CARD_BYTES,
  registerBackupFileIpc,
} from '../../electron/ipc/backupFiles.js';

const DOCUMENTS = path.resolve('C:/Users/test/AppData/Roaming/EasyChat2/documents');
const CACHE = path.resolve('C:/Users/test/AppData/Roaming/EasyChat2/cache');

function createHarness({
  openPath = '',
  savePath = '',
  canceled = false,
  sizes = {},
  contents = {},
} = {}) {
  const handlers = new Map();
  const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn) };
  const calls = { openOptions: null, saveOptions: null, copies: [], mkdirs: [] };
  const dialog = {
    showOpenDialog: async options => {
      calls.openOptions = options;
      return { canceled, filePaths: openPath ? [openPath] : [] };
    },
    showSaveDialog: async options => {
      calls.saveOptions = options;
      return { canceled, filePath: savePath };
    },
  };
  const fsImpl = {
    statSync: filePath => ({ isFile: () => true, size: sizes[filePath] ?? 1024 }),
    mkdirSync: directory => calls.mkdirs.push(directory),
    copyFileSync: (from, to) => calls.copies.push({ from, to }),
    readFileSync: filePath => Buffer.from(contents[filePath] ?? 'x'),
  };
  registerBackupFileIpc(ipcMain, { dialog, documentsRoot: DOCUMENTS, cacheRoot: CACHE, fsImpl });
  return {
    invoke: (channel, ...args) => handlers.get(channel)(null, ...args),
    calls,
  };
}

test('backup:pick：复制到 cache/backup-import 并返回 file URL', async () => {
  const source = 'C:/Users/test/Downloads/my-backup.json';
  const { invoke, calls } = createHarness({ openPath: source, sizes: { [source]: 2048 } });
  const result = await invoke('backup:pick');
  assert.equal(result.canceled, false);
  assert.equal(result.name, 'my-backup.json');
  assert.equal(result.size, 2048);
  assert.ok(result.uri.includes('/cache/backup-import/backup-'));
  assert.equal(calls.copies.length, 1);
  assert.ok(calls.copies[0].to.includes('backup-import'));
  assert.deepEqual(calls.openOptions.filters[0].extensions, ['json']);
});

test('backup:pick：非 JSON 拒绝，不复制', async () => {
  const { invoke, calls } = createHarness({ openPath: 'C:/tmp/evil.exe' });
  assert.deepEqual(await invoke('backup:pick'), { canceled: false, error: 'UNSUPPORTED' });
  assert.equal(calls.copies.length, 0);
});

test('backup:saveAs：source 必须在 documents/cache 内，然后复制到用户选择的位置', async () => {
  const sourceUri = `file:///${DOCUMENTS.replace(/\\/g, '/')}/easychat2-backup-1.json`;
  const target = 'C:/Users/test/Desktop/export.json';
  const { invoke, calls } = createHarness({ savePath: target });
  const result = await invoke('backup:saveAs', sourceUri, 'export.json', [{ name: 'JSON', extensions: ['json'] }]);
  assert.deepEqual(result, { canceled: false, path: target });
  assert.equal(calls.copies.length, 1);
  assert.equal(calls.saveOptions.defaultPath, 'export.json');
});

test('backup:saveAs：越界 source 抛 PATH_OUTSIDE_ROOT', async () => {
  const { invoke } = createHarness({ savePath: 'C:/tmp/x.json' });
  await assert.rejects(
    () => invoke('backup:saveAs', 'file:///C:/Windows/System32/secret.json', 'x.json'),
    error => error && error.code === 'PATH_OUTSIDE_ROOT'
  );
});

test('card:pick：返回 base64/扩展名/大小', async () => {
  const source = 'C:/tmp/card.png';
  const { invoke } = createHarness({ openPath: source, contents: { [source]: 'PNGDATA' } });
  const result = await invoke('card:pick');
  assert.equal(result.canceled, false);
  assert.equal(result.extension, 'png');
  assert.equal(Buffer.from(result.base64, 'base64').toString('utf8'), 'PNGDATA');
});

test('card:pick：超过 32MB 拒绝', async () => {
  const source = 'C:/tmp/big.png';
  const { invoke } = createHarness({ openPath: source, sizes: { [source]: MAX_CARD_BYTES + 1 } });
  const result = await invoke('card:pick');
  assert.equal(result.error, 'TOO_LARGE');
});

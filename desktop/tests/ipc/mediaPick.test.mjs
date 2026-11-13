// 主进程媒体导入（media:pick）行为测试：对话框口径、复制目标、大小/扩展名校验、文本读取。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MAX_IMAGE_BYTES,
  MAX_TEXT_BYTES,
  MAX_VIDEO_BYTES,
  PICK_KINDS,
  extensionOf,
  pickFileName,
  registerMediaPickIpc,
} from '../../electron/ipc/mediaPick.js';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const DOCUMENTS = path.resolve('C:/Users/test/AppData/Roaming/EasyChat2/documents');
const CACHE = path.resolve('C:/Users/test/AppData/Roaming/EasyChat2/cache');

function createHarness({ selected = [], canceled = false, sizes = {}, contents = {} } = {}) {
  const handlers = new Map();
  const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn) };
  const calls = { dialogOptions: null, copies: [], mkdirs: [] };
  const dialog = {
    showOpenDialog: async options => {
      calls.dialogOptions = options;
      return { canceled, filePaths: selected };
    },
  };
  const fsImpl = {
    statSync: filePath => ({ isFile: () => true, size: sizes[filePath] ?? 1024 }),
    mkdirSync: directory => calls.mkdirs.push(directory),
    copyFileSync: (from, to) => calls.copies.push({ from, to }),
    readFileSync: filePath => Buffer.from(contents[filePath] ?? ''),
  };
  registerMediaPickIpc(ipcMain, { dialog, documentsRoot: DOCUMENTS, cacheRoot: CACHE, fsImpl });
  return { invoke: (kind) => handlers.get('media:pick')(null, kind), calls };
}

test('media:pick：图片多选、复制到 documents/chat-images 并返回 file URL', async () => {
  const source = 'C:/Users/test/Pictures/a.PNG';
  const { invoke, calls } = createHarness({ selected: [source], sizes: { [source]: 2048 } });
  const result = await invoke('image');
  assert.equal(result.canceled, false);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].name, 'a.PNG');
  assert.equal(result.items[0].size, 2048);
  assert.match(result.items[0].uri, /^file:\/\/\//);
  assert.ok(result.items[0].uri.includes('/chat-images/image-'));
  assert.ok(result.items[0].uri.endsWith('.png'));
  assert.deepEqual(calls.dialogOptions.properties, ['openFile', 'multiSelections']);
  assert.equal(calls.copies.length, 1);
  assert.ok(calls.copies[0].to.includes('chat-images'));
});

test('media:pick：超限/不支持的扩展名进入 errors，且不复制', async () => {
  const big = 'C:/tmp/big.jpg';
  const wrong = 'C:/tmp/note.exe';
  const { invoke, calls } = createHarness({
    selected: [big, wrong],
    sizes: { [big]: MAX_IMAGE_BYTES + 1, [wrong]: 10 },
  });
  const result = await invoke('image');
  assert.equal(result.items.length, 0);
  assert.deepEqual(result.errors.map(error => error.code), ['TOO_LARGE', 'UNSUPPORTED']);
  assert.equal(calls.copies.length, 0);
});

test('media:pick：视频单选，目标目录是 chat-videos', async () => {
  const source = 'C:/tmp/movie.mov';
  const { invoke, calls } = createHarness({ selected: [source], sizes: { [source]: 4096 } });
  const result = await invoke('video');
  assert.deepEqual(calls.dialogOptions.properties, ['openFile']);
  assert.match(result.items[0].uri, /\/chat-videos\/video-/);
  assert.ok(result.items[0].uri.endsWith('.mov'));
});

test('media:pick：文本按 base64 返回、不落盘', async () => {
  const source = 'C:/tmp/note.md';
  const { invoke, calls } = createHarness({ selected: [source], contents: { [source]: '# hello' } });
  const result = await invoke('text');
  assert.equal(result.items.length, 1);
  assert.equal(Buffer.from(result.items[0].base64, 'base64').toString('utf8'), '# hello');
  assert.equal(calls.copies.length, 0);
});

test('media:pick：表情包源图落到 cache/sticker-import', async () => {
  const source = 'C:/tmp/cute.png';
  const { invoke } = createHarness({ selected: [source], sizes: { [source]: 1024 } });
  const result = await invoke('sticker-source');
  assert.equal(result.items.length, 1);
  assert.ok(result.items[0].uri.includes('/cache/sticker-import/sticker-src-'));
  assert.ok(!result.items[0].uri.includes('/documents/'));
});

test('media:pick：取消返回 canceled', async () => {
  const { invoke } = createHarness({ canceled: true });
  assert.deepEqual(await invoke('image'), { canceled: true, items: [], errors: [] });
});

test('pickFileName/extensionOf：扩展名归一与文件名前缀', () => {
  assert.equal(extensionOf('A.JPEG'), 'jpeg');
  assert.equal(extensionOf('no-ext'), '');
  const name = pickFileName('image', 'C:/x/a.JPEG', 1700000000000, 0.123456);
  assert.match(name, /^image-1700000000000-123456\.jpeg$/);
  assert.match(pickFileName('video', 'C:/x/no-ext', 1, 0.5), /^video-1-5\.mp4$/);
});

test('限额常量与共享层 attachments.js 保持同源', () => {
  const source = fs.readFileSync(path.join(REPO_ROOT, 'src', 'chat', 'attachments.js'), 'utf8');
  const read = name => {
    const match = source.match(new RegExp(`export const ${name} = ([0-9_\\s*]+);`));
    return match ? Function(`return (${match[1]})`)() : NaN;
  };
  assert.equal(MAX_IMAGE_BYTES, read('MAX_IMAGE_BYTES'));
  assert.equal(MAX_VIDEO_BYTES, read('MAX_VIDEO_BYTES'));
  assert.equal(MAX_TEXT_BYTES, read('MAX_TEXT_BYTES'));
  assert.equal(PICK_KINDS.image.maxBytes, MAX_IMAGE_BYTES);
});

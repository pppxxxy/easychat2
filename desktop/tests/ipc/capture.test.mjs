// 应用内截图（capture:appScreen）行为测试。
//
// 钉住四件事（每一条错了都很隐蔽）：
//   1. 落盘后缀与真实内容一致（PNG）——消费者按后缀判 MIME，撒谎会读出坏图；
//   2. 滚动清扫只删该删的，且不会把刚拍的删掉；
//   3. 写盘失败不留半成品（.part 必须清掉）；
//   4. 没有窗口时返回结构化失败，而不是抛进 IPC 让渲染层看到 Unhandled。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createCaptureService,
  pickStaleCaptures,
  registerCaptureIpc,
  screenWatchDir,
  SCREEN_WATCH_DIR_NAME,
} from '../../electron/ipc/capture.js';

function tempDocuments() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'easychat2-capture-'));
}

test('screenWatchDir：落在 documents/screen-watch 下（与手机同名目录）', () => {
  assert.equal(SCREEN_WATCH_DIR_NAME, 'screen-watch');
  assert.equal(
    screenWatchDir('C:/docs').replace(/\\/g, '/'),
    'C:/docs/screen-watch'
  );
});

test('pickStaleCaptures：只挑截图，按 mtime 保留最新的 N 张', () => {
  const entries = [
    { name: 'cap-aaa-1.png', mtimeMs: 1000 },
    { name: 'cap-bbb-2.png', mtimeMs: 2000 },
    { name: 'cap-ccc-3.png', mtimeMs: 3000 },
    { name: 'overlay-avatar.jpg', mtimeMs: 4000 }, // 同目录的其他文件不能被动到
    { name: 'crash-20260101-000000.txt', mtimeMs: 5000 },
  ];
  assert.deepEqual(pickStaleCaptures(entries, 2), ['cap-aaa-1.png']);
  assert.deepEqual(pickStaleCaptures(entries, 5), []);
  // 非 .png（含旧的 .jpg 约定）一律不当作截图——扩展名必须与内容一致。
  assert.deepEqual(pickStaleCaptures([{ name: 'cap-aaa-1.jpg', mtimeMs: 1 }], 0), []);
  // 纯字符串输入（无 mtime）也接受：退回名字次序，不炸。
  assert.deepEqual(pickStaleCaptures(['cap-aaa-1.png', 'cap-bbb-2.png'], 1), ['cap-aaa-1.png']);
  // 同毫秒连拍：靠名字做稳定次序，绝不能两张都留下或都删掉。
  const sameMs = [
    { name: 'cap-a-aa.png', mtimeMs: 7 },
    { name: 'cap-b-bb.png', mtimeMs: 7 },
  ];
  assert.deepEqual(pickStaleCaptures(sameMs, 1), ['cap-a-aa.png']);
});

test('saveFrame：写成 .png、内容原样，并清掉同目录超额的旧截图', () => {
  const documentsRoot = tempDocuments();
  const service = createCaptureService({ documentsRoot });
  const buffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const first = service.saveFrame(buffer, 1000);
  assert.ok(first.endsWith('.png'), '必须存成 .png（内容就是 PNG）');
  assert.deepEqual(fs.readFileSync(first), buffer);
  assert.equal(service.dir, screenWatchDir(documentsRoot));

  // 填到超过保留上限，最新那张不能被删。
  const made = [];
  for (let i = 0; i < 22; i += 1) {
    made.push(service.saveFrame(Buffer.from([0]), 2000 + i));
  }
  const left = fs.readdirSync(service.dir).filter(name => name.endsWith('.png'));
  assert.ok(left.length <= 20, `应滚动清扫到 20 张以内，实际 ${left.length}`);
  assert.ok(fs.existsSync(made[made.length - 1]), '最新一张不能被清扫掉');
  assert.ok(!fs.existsSync(first), '最旧的一张应被清扫');
  fs.rmSync(documentsRoot, { recursive: true, force: true });
});

test('saveFrame：写盘失败不留 .part 半成品', () => {
  const documentsRoot = tempDocuments();
  const service = createCaptureService({ documentsRoot });
  const dir = service.dir;
  fs.mkdirSync(dir, { recursive: true });
  // 把目标目录设成只读不可行（跨平台差异大），改用「写入时抛错」的替身：
  // 直接调用底层，模拟 renameSync 失败。
  const originalRename = fs.renameSync;
  fs.renameSync = () => {
    throw new Error('rename boom');
  };
  try {
    assert.throws(() => service.saveFrame(Buffer.from([1, 2, 3]), 3000), /rename boom/);
  } finally {
    fs.renameSync = originalRename;
  }
  assert.deepEqual(fs.readdirSync(dir).filter(name => name.endsWith('.part')), [], '不得留下 .part');
  fs.rmSync(documentsRoot, { recursive: true, force: true });
});

function createHarness({ captureResult = null, throwOnCapture = false } = {}) {
  const handlers = new Map();
  const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn) };
  const documentsRoot = tempDocuments();
  const window = {
    isDestroyed: () => false,
    webContents: {
      capturePage: async () => {
        if (throwOnCapture) throw new Error('capture boom');
        return { toPNG: () => Buffer.from(captureResult || [0x89, 0x50]) };
      },
    },
  };
  registerCaptureIpc(ipcMain, { getWindow: () => window, documentsRoot });
  return { handlers, documentsRoot };
}

test('capture:appScreen：成功时返回 file:// uri，文件真的在磁盘上', async () => {
  const { handlers, documentsRoot } = createHarness();
  const result = await handlers.get('capture:appScreen')();
  assert.equal(result.ok, true);
  assert.match(result.uri, /^file:\/\/.*screen-watch\/cap-.*\.png$/);
  assert.ok(fs.existsSync(result.path), '返回的 path 必须真的落盘');
  fs.rmSync(documentsRoot, { recursive: true, force: true });
});

test('capture:appScreen：没有窗口 / 截图抛错都返回结构化失败', async () => {
  const noWindowHandlers = new Map();
  registerCaptureIpc(
    { handle: (channel, fn) => noWindowHandlers.set(channel, fn) },
    { getWindow: () => null, documentsRoot: tempDocuments() }
  );
  const noWindow = await noWindowHandlers.get('capture:appScreen')();
  assert.equal(noWindow.ok, false);
  assert.equal(noWindow.reason, 'no-window');

  const { handlers, documentsRoot } = createHarness({ throwOnCapture: true });
  const failed = await handlers.get('capture:appScreen')();
  assert.equal(failed.ok, false);
  assert.match(String(failed.reason), /capture boom/);
  fs.rmSync(documentsRoot, { recursive: true, force: true });
});
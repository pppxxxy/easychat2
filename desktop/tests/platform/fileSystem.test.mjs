// expo-file-system/legacy 适配 + 主进程 fs 服务行为测试。
//
// 覆盖 design.md 要求的性质：file:// 与系统路径互转、越界拒绝、
// readDirectoryAsync 只返回直接子项、EncodingType 与 expo 一致。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { makeSandbox } from '../helpers/sandbox.mjs';
import { createFileSystem } from '../../src/platform/fileSystem.js';

test('FileSystem 适配：documentDirectory 是带结尾斜杠的 file URL', () => {
  const sandbox = makeSandbox();
  try {
    const FileSystem = createFileSystem(sandbox.bridge);
    assert.match(FileSystem.documentDirectory, /^file:\/\/\//, '必须是 file:// URL');
    assert.ok(FileSystem.documentDirectory.endsWith('/'), '共享层按字符串拼接，必须以 / 结尾');
    assert.ok(FileSystem.cacheDirectory.endsWith('/'));
    assert.deepEqual(FileSystem.EncodingType, { UTF8: 'utf8', Base64: 'base64' });
  } finally {
    sandbox.cleanup();
  }
});

test('FileSystem 适配：UTF8/Base64 写读、目录、copy/move/delete 与 stat', async () => {
  const sandbox = makeSandbox();
  try {
    const FileSystem = createFileSystem(sandbox.bridge);
    const base = FileSystem.documentDirectory;

    await FileSystem.makeDirectoryAsync(`${base}nested/a/b`, { intermediates: true });
    assert.equal((await FileSystem.getInfoAsync(`${base}nested/a/b`)).isDirectory, true);

    await FileSystem.writeAsStringAsync(`${base}nested/a/b/hello.txt`, '你好，桌面 👋');
    assert.equal(await FileSystem.readAsStringAsync(`${base}nested/a/b/hello.txt`), '你好，桌面 👋');

    const info = await FileSystem.getInfoAsync(`${base}nested/a/b/hello.txt`);
    assert.equal(info.exists, true);
    assert.ok(info.size > 0);
    assert.equal((await FileSystem.getInfoAsync(`${base}nested/missing.txt`)).exists, false);

    // Base64 往返：二进制安全的落盘形态。
    const bytes = Buffer.from([0, 1, 2, 250, 251, 252]);
    await FileSystem.writeAsStringAsync(`${base}nested/bin.dat`, bytes.toString('base64'), { encoding: 'base64' });
    const readBack = await FileSystem.readAsStringAsync(`${base}nested/bin.dat`, { encoding: 'base64' });
    assert.deepEqual(Buffer.from(readBack, 'base64'), bytes);

    await FileSystem.copyAsync({ from: `${base}nested/bin.dat`, to: `${base}nested/bin-copy.dat` });
    assert.equal((await FileSystem.getInfoAsync(`${base}nested/bin-copy.dat`)).exists, true);
    await FileSystem.moveAsync({ from: `${base}nested/bin-copy.dat`, to: `${base}nested/bin-moved.dat` });
    assert.equal((await FileSystem.getInfoAsync(`${base}nested/bin-copy.dat`)).exists, false);
    assert.equal((await FileSystem.getInfoAsync(`${base}nested/bin-moved.dat`)).exists, true);

    await FileSystem.deleteAsync(`${base}nested/bin-moved.dat`);
    assert.equal((await FileSystem.getInfoAsync(`${base}nested/bin-moved.dat`)).exists, false);
    // idempotent（默认 true）：删除不存在文件不抛错。
    await FileSystem.deleteAsync(`${base}nested/bin-moved.dat`);

    // readDirectoryAsync 只返回直接子项名（不含路径分隔符，不递归）。
    const entries = (await FileSystem.readDirectoryAsync(`${base}nested`)).sort();
    assert.deepEqual(entries, ['a', 'bin.dat'], '只返回直接子项');
    assert.ok(!entries.includes('hello.txt'), '不得递归返回孙项');
    assert.deepEqual(await FileSystem.readDirectoryAsync(`${base}nested/a`), ['b']);
  } finally {
    sandbox.cleanup();
  }
});

test('FS 边界：documents/cache 之外的路径一律拒绝（PATH_OUTSIDE_ROOT）', async () => {
  const sandbox = makeSandbox();
  try {
    const outsideFileUrl = `file:///${path.join(sandbox.root, 'outside.txt').replace(/\\/g, '/')}`;
    await assert.rejects(
      () => sandbox.fsService.read(outsideFileUrl),
      error => error && error.code === 'PATH_OUTSIDE_ROOT',
      'file URL 越界必须拒绝'
    );
    await assert.rejects(
      () => sandbox.fsService.write(path.join(sandbox.root, 'outside.txt'), 'x'),
      error => error && error.code === 'PATH_OUTSIDE_ROOT',
      '裸绝对路径同样过边界校验'
    );
    await assert.rejects(
      () => sandbox.fsService.read('content://external/document/1'),
      error => error && error.code === 'PATH_OUTSIDE_ROOT',
      'content:// 等非 file 形态一律拒绝'
    );

    // 裸绝对路径落在允许根内：允许（导入历史数据时的兜底归一）。
    const insideBare = path.join(sandbox.documentsRoot, 'bare.txt');
    await sandbox.fsService.write(insideBare, 'ok');
    assert.equal(await sandbox.fsService.read(insideBare), 'ok');
  } finally {
    sandbox.cleanup();
  }
});

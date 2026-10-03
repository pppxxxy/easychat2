// 文件夹选择器的纯逻辑（picker.js）。
//
// 这里不 require 原生模块：picker.js 只在真正调用时才惰性加载 expo-file-system，
// 所以测试环境可以安全 import。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getFileSystemNext,
  isPickerAvailable,
  isPickerCancelled,
  normalizePickedDirectory,
  pickWorkspaceFolder,
  PICKER_CANCELLED,
} from '../src/workspace/picker.js';

test('测试环境惰性加载失败时安全降级', () => {
  // expo-file-system 的 Directory 需要原生模块，测试环境拿不到
  assert.equal(getFileSystemNext(), null);
  assert.equal(isPickerAvailable(), false);
  assert.equal(PICKER_CANCELLED, 'picker-cancelled');
});

test('isPickerCancelled：只认取消，真失败要放行', () => {
  assert.equal(isPickerCancelled(null), false);
  assert.equal(isPickerCancelled(undefined), false);
  assert.equal(isPickerCancelled({ name: 'PickerCancelledException', message: 'x' }), true);
  assert.equal(isPickerCancelled(new Error('The file picker was cancelled by the user')), true);
  assert.equal(isPickerCancelled(new Error('user cancelled')), true);
  // 真实失败不能被当成取消吞掉——否则用户永远看不到错误提示
  assert.equal(isPickerCancelled(new Error('Missing WRITE permission for accessing the file.')), false);
  assert.equal(isPickerCancelled(new Error('AppContextLost')), false);
});

test('normalizePickedDirectory：uri 为空返回 null，名字做百分号解码', () => {
  assert.equal(normalizePickedDirectory(null), null);
  assert.equal(normalizePickedDirectory({ uri: '' }), null);
  assert.equal(normalizePickedDirectory({}), null);
  const picked = normalizePickedDirectory({
    uri: 'content://com.android.externalstorage.documents/tree/primary%3ADocuments',
    name: 'primary%3ADocuments',
  });
  assert.equal(picked.name, 'primary:Documents');
  // 名字缺失或解码失败时退回 uri 末段，保证 UI 上永远有东西显示
  assert.equal(normalizePickedDirectory({ uri: 'content://tree/primary%3ADocs' }).name, 'primary%3ADocs');
  assert.equal(normalizePickedDirectory({ uri: 'content://tree/x', name: '%E4%B8%AD%E6%96%87' }).name, '中文');
  // 非法百分号编码不抛错（decodeURIComponent 会 throw），退回原串
  assert.equal(normalizePickedDirectory({ uri: 'content://tree/x', name: '%E4%B8' }).name, '%E4%B8');
});

test('pickWorkspaceFolder：能力不可用时明确报错，而不是静默返回 null', async () => {
  await assert.rejects(pickWorkspaceFolder(), /不支持选择文件夹/);
});

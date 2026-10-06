// 工作区根文件夹选择器（Android SAF / iOS 文件 App）。
//
// 用 expo-file-system v19 的新 API：Directory.pickDirectoryAsync() 打开系统目录选择器。
// Android 侧走 ACTION_OPEN_DOCUMENT_TREE 并且 **takePersistableUriPermission**，
// 用户选一次就在重启后仍然有效；iOS 侧只授予本次会话的临时访问（系统限制），
// 重启后需要重新选——这一点在设置页文案里如实说明，不承诺跨重启。
//
// 用户取消时原生抛 PickerCancelledException，这里吞掉并返回 null——
// 取消不是错误，调用方不该弹错误框。
//
// 惰性 require：测试环境 require 原生模块会抛（与 native.js 同一套路）。

import { tActive } from '../i18n/index.js';

export const PICKER_CANCELLED = 'picker-cancelled';

let fsModule;
let fsLoaded = false;

export function getFileSystemNext() {
  if (!fsLoaded) {
    fsLoaded = true;
    try {
      fsModule = require('expo-file-system');
    } catch (error) {
      fsModule = null;
    }
  }
  return fsModule;
}

export function isPickerAvailable() {
  const fileSystem = getFileSystemNext();
  return Boolean(fileSystem && typeof fileSystem.Directory === 'function'
    && typeof fileSystem.Directory.pickDirectoryAsync === 'function');
}

// 取消在 Android/iOS 都表现为原生异常；文案不稳定，故用「名称 + 关键字」双判定，
// 认不出来就当真实失败抛出（宁可多报一次错，也不把失败伪装成取消）。
export function isPickerCancelled(error) {
  if (!error) return false;
  if (error.name === 'PickerCancelledException') return true;
  const message = String(error.message || '');
  return /picker was cancelled|user cancelled|PickerCancelled/i.test(message);
}

export function normalizePickedDirectory(directory) {
  if (!directory) return null;
  const uri = String(directory.uri || '');
  if (!uri) return null;
  // content://.../tree/primary%3ADocuments 这类 uri 的 basename 是百分号编码的，
  // 显示名只是给人看的，不做解码以外的加工（解码失败就用原始串）。
  let name = '';
  try {
    name = decodeURIComponent(String(directory.name || ''));
  } catch (error) {
    name = String(directory.name || '');
  }
  return { uri, name: name || uri.split('/').filter(Boolean).pop() || uri };
}

export async function pickWorkspaceFolder() {
  const fileSystem = getFileSystemNext();
  if (!fileSystem || typeof fileSystem.Directory !== 'function'
    || typeof fileSystem.Directory.pickDirectoryAsync !== 'function') {
    throw new Error(tActive('error.workspace.pickerUnsupported'));
  }
  try {
    const directory = await fileSystem.Directory.pickDirectoryAsync();
    return normalizePickedDirectory(directory);
  } catch (error) {
    if (isPickerCancelled(error)) return null;
    throw error;
  }
}

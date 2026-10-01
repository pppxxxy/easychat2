import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// app.json 原生权限回归：语音消息需要 RECORD_AUDIO。
//
// 背景：expo-image-picker 插件在 `microphonePermission: false` 时会把它转成
// 「屏蔽权限」（withBlockedPermissions），在合并的 AndroidManifest 里对
// RECORD_AUDIO 写 tools:node="remove"——这会盖过 expo-audio 的声明，导致系统
// 设置里根本没有「麦克风」开关，录音请求被直接拒绝。因此这里锁定：
// 1) image-picker 不得再设 microphonePermission:false；
// 2) RECORD_AUDIO 不得出现在 android.blockedPermissions；
// 3) expo-audio 已配置开启 Android 录音。
const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_JSON = JSON.parse(readFileSync(path.join(HERE, '..', 'app.json'), 'utf8'));
const EXPO = APP_JSON.expo || {};
const PLUGINS = Array.isArray(EXPO.plugins) ? EXPO.plugins : [];

function pluginEntry(name) {
  return PLUGINS.find(entry => (Array.isArray(entry) ? entry[0] : entry) === name) || null;
}

function pluginOptions(name) {
  const entry = pluginEntry(name);
  return Array.isArray(entry) && entry[1] && typeof entry[1] === 'object' ? entry[1] : {};
}

test('expo-image-picker 不再把麦克风权限设为 false（否则会屏蔽 RECORD_AUDIO）', () => {
  const options = pluginOptions('expo-image-picker');
  assert.notEqual(
    options.microphonePermission,
    false,
    'image-picker 的 microphonePermission:false 会把 RECORD_AUDIO 加入屏蔽权限，导致无法录音'
  );
});

test('android.blockedPermissions 不得屏蔽 RECORD_AUDIO', () => {
  const blocked = EXPO.android?.blockedPermissions || [];
  assert.equal(
    blocked.includes('android.permission.RECORD_AUDIO'),
    false,
    'RECORD_AUDIO 被屏蔽后系统设置不显示麦克风开关，录音必然失败'
  );
});

test('expo-audio 已启用 Android 录音权限声明', () => {
  const options = pluginOptions('expo-audio');
  assert.notEqual(
    options.recordAudioAndroid,
    false,
    'expo-audio 需要 recordAudioAndroid 打开才会声明 RECORD_AUDIO'
  );
  assert.ok(pluginEntry('expo-audio'), 'app.json 应配置 expo-audio 插件');
});

// 备份导出/恢复真机级集成测试（无 Electron）：
//   共享层 backup.js + backupRead.js
//     -> esbuild 别名到桌面适配层（AsyncStorage / expo-file-system / File）
//     -> 真实主进程服务（kv / fs，临时目录）
// 覆盖：导出落盘 -> 跨平台 payload -> 恢复时媒体路径重写 -> 媒体/键值真实写回。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

import { makeSandbox } from '../helpers/sandbox.mjs';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(HERE, '../..');
const platform = file => path.join(DESKTOP, 'src', 'platform', file);

async function bundleBackup() {
  const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'easychat2-backup-bundle-'));
  const outfile = path.join(outdir, 'backup.cjs');
  await build({
    entryPoints: [path.join(DESKTOP, 'tests', 'fixtures', 'backupEntry.js')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile,
    absWorkingDir: DESKTOP,
    logLevel: 'silent',
    alias: {
      'expo-file-system/legacy': platform('fileSystem.js'),
      'expo-file-system': platform('fileNext.js'),
      '@react-native-async-storage/async-storage': platform('asyncStorage.js'),
      'react-native': platform('reactNative.js'),
      'expo-sqlite': platform('sqlite.js'),
      'expo-secure-store': platform('secureStore.js'),
      'expo-asset': platform('asset.js'),
      'expo-clipboard': platform('clipboard.js'),
      'expo-audio': platform('audio.js'),
      'expo-speech': platform('speech.js'),
      'expo-document-picker': platform('documentPicker.js'),
      'expo-image-picker': platform('imagePicker.js'),
      'expo-sharing': platform('sharing.js'),
      'expo-device': platform('device.js'),
      'expo-local-authentication': platform('localAuth.js'),
    },
  });
  return { outfile, outdir };
}

test('集成：导出 -> 跨平台路径改写 -> 恢复（媒体与键值真实写回）', async () => {
  const sandbox = makeSandbox();
  const previousBridge = globalThis.easychat2;
  globalThis.easychat2 = sandbox.bridge;
  const { outfile, outdir } = await bundleBackup();
  try {
    // 适配层的 documentDirectory 在模块加载期取值：必须先设好全局桥再 require 打包产物。
    const lib = require(outfile);

    sandbox.kvStore.set('@easychat2_character_index', JSON.stringify({
      characters: [{
        id: 'c1',
        name: 'Old Android Character',
        avatarUri: 'file:///data/user/0/old.pkg/files/avatars/c1.jpg',
      }],
    }));
    fs.mkdirSync(path.join(sandbox.documentsRoot, 'chat-images'), { recursive: true });
    const mediaPath = path.join(sandbox.documentsRoot, 'chat-images', 'a.jpg');
    fs.writeFileSync(mediaPath, Buffer.from([1, 2, 3, 4]));

    const exported = await lib.exportBackup({ appVersion: 'test', mode: 'full', includeSecrets: false });
    assert.ok(exported.uri.startsWith(sandbox.documentDirectory), '导出文件应在 documents 内');
    assert.equal(exported.storageCount, 1);
    assert.equal(exported.mediaCount, 1);

    // 流式读取（>16MB 才走分片；这里验证 direct 路径与接口形状）。
    const nextFs = await import('../../src/platform/fileNext.js');
    const read = await lib.readBackupText({
      uri: exported.uri,
      legacyFs: {
        getInfoAsync: uri => sandbox.bridge.fs.stat(uri),
        readAsStringAsync: (uri, options) => sandbox.bridge.fs.read(
          uri,
          options && options.encoding === 'base64' ? 'base64' : 'utf8'
        ),
        EncodingType: { UTF8: 'utf8', Base64: 'base64' },
      },
      nextFs,
    });
    const payload = JSON.parse(read.text);
    assert.equal(payload.schemaVersion, 1);
    assert.equal(payload.media[0].path, 'chat-images/a.jpg');

    // 模拟 Android 来源：媒体条目与存储值都带旧安装绝对路径。
    payload.media[0].path = 'file:///data/user/0/old.pkg/files/chat-images/a.jpg';
    payload.storage[0].value.characters[0].avatarUri =
      'file:///data/user/0/old.pkg/files/avatars/c1.jpg';

    // 恢复前删掉媒体，确保下面断言的是「真的写回来了」。
    fs.rmSync(path.join(sandbox.documentsRoot, 'chat-images'), { recursive: true, force: true });

    const result = await lib.importBackup(payload, 'merge');
    assert.equal(result.storageCount, 1);
    assert.equal(result.mediaCount, 1);
    assert.equal(result.rewrittenMediaPaths, 1, '绝对媒体路径应被改成相对路径');
    assert.ok(result.rewrittenUris >= 1, '存储值里的旧 URI 应被重写');

    assert.ok(fs.existsSync(mediaPath), '媒体文件应恢复');
    assert.deepEqual([...fs.readFileSync(mediaPath)], [1, 2, 3, 4]);

    const restored = JSON.parse(sandbox.kvStore.get('@easychat2_character_index'));
    const avatarUri = restored.characters[0].avatarUri;
    assert.ok(
      avatarUri.startsWith(sandbox.documentDirectory),
      `头像 URI 应收敛到当前 documents：${avatarUri}`
    );
    assert.ok(avatarUri.endsWith('avatars/c1.jpg'));
    assert.ok(!avatarUri.includes('/data/user/0/'), '不应保留旧安卓安装路径');
  } finally {
    globalThis.easychat2 = previousBridge;
    sandbox.cleanup();
    fs.rmSync(outdir, { recursive: true, force: true });
  }
});

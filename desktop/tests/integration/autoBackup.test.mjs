// S14 集成测试：桌面跑**真实**的自动备份执行器（共享层 backup/autoBackupRun）。
//
// 为什么这条必须有：界面点「立即备份」在冒烟里看不到落盘（UI 探针受弹层与渲染时序干扰，
// 结果不稳），而自动备份是**数据安全**功能——只看按钮点得到不算验证。这里用与
// backupRoundTrip 相同的做法：共享层编排 + 桌面适配层 + 真实主进程 fs/kv 服务（临时目录），
// 断言真的写出了备份包，且设置里的 lastBackupAt 被更新。
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

async function bundle() {
  const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'easychat2-autobackup-'));
  const outfile = path.join(outdir, 'bundle.cjs');
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
  return require(outfile);
}

test('桌面自动备份：走应用私有目录，真的写出备份包并记录时间', async () => {
  const sandbox = makeSandbox();
  const previous = { window: globalThis.window, easychat2: globalThis.easychat2 };
  globalThis.window = globalThis.window || {};
  globalThis.easychat2 = {
    fs: sandbox.bridge.fs,
    app: sandbox.bridge.app,
    kv: sandbox.bridge.kv,
    secret: sandbox.bridge.secret,
  };
  const module = await bundle();

  const store = module;
  const settings = store.normalizeAutoBackupSettings({ enabled: true, intervalMs: 86400000 });
  assert.equal(settings.location.kind, 'app', '桌面只支持应用私有目录');

  const deps = store.createAutoBackupDeps({
    exportBackup: store.exportBackup,
    getSettings: store.getAutoBackupSettings,
    recordLastBackupAt: store.recordAutoBackupAt,
    fileSystem: {
      documentDirectory: sandbox.bridge.app.paths.documentDirectory,
      cacheDirectory: sandbox.bridge.app.paths.cacheDirectory,
      readDirectoryAsync: uri => sandbox.bridge.fs.readDir(uri),
      deleteAsync: uri => sandbox.bridge.fs.delete(uri, true),
      writeAsStringAsync: (uri, data, options) => sandbox.bridge.fs.write(uri, data, (options && options.encoding) || 'utf8'),
      makeDirectoryAsync: uri => sandbox.bridge.fs.mkdir(uri, true),
    },
    // 桌面没有 FileHandle/SAF 适配器：非 SAF 分支完全不碰它们。
    nextFs: null,
    adapter: null,
  });

  const result = await store.runAutoBackup({ settings, deps, appVersion: 'test' });
  assert.equal(result.ok, true, `自动备份应成功，实际：${JSON.stringify(result)}`);
  assert.equal(result.target, 'app', '目标应为应用私有目录');
  assert.ok(result.bytes > 0, '备份包字节数应大于 0');

  // 落盘事实：通过 bridge 读目录（与渲染层同一入口，避免手拼 file:// 路径）。
  const dirUri = `${sandbox.bridge.app.paths.documentDirectory}${store.AUTO_BACKUP_APP_SUBDIR}/`;
  const names = await sandbox.bridge.fs.readDir(dirUri);
  assert.ok(
    (Array.isArray(names) ? names : []).some(name => String(name).includes('easychat2-auto-backup-')),
    `目录里应有备份包：${JSON.stringify(names)}；result=${JSON.stringify(result)}`
  );
  const stat = await sandbox.bridge.fs.stat(result.uri);
  assert.ok((stat && stat.size) > 0, '落盘文件应有字节');

  // 时间记录：写回设置后再读，lastBackupAt 必须已更新（否则到期判定永远为 true）。
  const after = await store.getAutoBackupSettings();
  assert.ok(after.lastBackupAt > 0, 'lastBackupAt 应被记录');
  assert.equal(store.isAutoBackupDue({ ...after, intervalMs: 86400000 }), false, '刚备份完不该仍然到期');

  globalThis.window = previous.window;
  globalThis.easychat2 = previous.easychat2;
  sandbox.cleanup();
});

test('桌面自动备份：关闭状态下不写文件（不误触发）', async () => {
  const sandbox = makeSandbox();
  const previous = { window: globalThis.window, easychat2: globalThis.easychat2 };
  globalThis.window = globalThis.window || {};
  globalThis.easychat2 = {
    fs: sandbox.bridge.fs,
    app: sandbox.bridge.app,
    kv: sandbox.bridge.kv,
    secret: sandbox.bridge.secret,
  };
  const store = await bundle();
  const result = await store.runAutoBackup({
    settings: store.normalizeAutoBackupSettings({ enabled: false }),
    deps: store.createAutoBackupDeps({
      exportBackup: store.exportBackup,
      getSettings: store.getAutoBackupSettings,
      recordLastBackupAt: store.recordAutoBackupAt,
      fileSystem: null,
      nextFs: null,
      adapter: null,
    }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.skipped, 'disabled', '关闭时不该执行导出');

  globalThis.window = previous.window;
  globalThis.easychat2 = previous.easychat2;
  sandbox.cleanup();
});
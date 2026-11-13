// S15 集成测试：桌面单角色锁**真的**拦得住（密码落 secureStore、校验常数时间比较）。
//
// 为什么必须有这条：单角色锁是安全功能，只看「设置页有个输入框」毫无意义。
// 这里用与 autoBackup / backupRoundTrip 相同的做法：共享层 storage/security.js + 桌面
// secureStore 适配层 + 真实主进程 secret 服务（临时目录），断言：
//   · 设置了密码后 isCharacterLocked 为 true；
//   · 正确密码能过、错误密码过不去；
//   · 移除后名单里没有该角色；
//   · 密码没有以明文形式出现在 AsyncStorage 的元数据键里。
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
  const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'easychat2-rolelock-'));
  const outfile = path.join(outdir, 'bundle.cjs');
  await build({
    entryPoints: [path.join(DESKTOP, 'tests', 'fixtures', 'securityEntry.js')],
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

function installBridge(sandbox) {
  const previous = { window: globalThis.window, easychat2: globalThis.easychat2 };
  globalThis.window = globalThis.window || {};
  globalThis.easychat2 = {
    fs: sandbox.bridge.fs,
    app: sandbox.bridge.app,
    kv: sandbox.bridge.kv,
    secret: sandbox.bridge.secret,
    clipboard: sandbox.bridge.clipboard,
  };
  return previous;
}

test('单角色锁：设置后拦住、正确密码放行、错误密码拒绝、移除后清除', async () => {
  const sandbox = makeSandbox();
  const previous = installBridge(sandbox);
  const security = await bundle();

  const characterId = 'char-locked';
  assert.equal(await security.isCharacterLocked(characterId), false, '初始不应上锁');

  const set = await security.setCharacterLock(characterId, '2580');
  assert.equal(set, true, '设置密码应成功');
  assert.equal(await security.isCharacterLocked(characterId), true, '设置后应在上锁名单里');

  assert.equal(await security.verifyCharacterPasscode(characterId, '2580'), true, '正确密码应通过');
  assert.equal(await security.verifyCharacterPasscode(characterId, '2581'), false, '错误密码应拒绝');
  assert.equal(await security.verifyCharacterPasscode(characterId, '258'), false, '长度不同应拒绝');
  assert.equal(await security.verifyCharacterPasscode(characterId, ''), false, '空密码应拒绝');

  // 密码不得以明文出现在元数据键（名单只存 id）。
  const raw = await sandbox.bridge.kv.get('@easychat2_security');
  assert.ok(raw, '安全元数据键应存在');
  assert.equal(String(raw).includes('2580'), false, '元数据里不应出现明文密码');

  // 提示可选，写失败不影响锁。
  await security.setCharacterLockHint(characterId, '常用那串');
  assert.equal(await security.getCharacterLockHint(characterId), '常用那串');

  await security.removeCharacterLock(characterId);
  assert.equal(await security.isCharacterLocked(characterId), false, '移除后不应再上锁');
  assert.equal(await security.verifyCharacterPasscode(characterId, '2580'), false, '移除后旧密码也不该通过');

  globalThis.window = previous.window;
  globalThis.easychat2 = previous.easychat2;
  sandbox.cleanup();
});

test('单角色锁：过短的密码直接拒绝；超长按共享层规则截断到上限', async () => {
  const sandbox = makeSandbox();
  const previous = installBridge(sandbox);
  const security = await bundle();
  // PIN_MIN_LENGTH=4，PIN_MAX_LENGTH=8。
  assert.equal(await security.setCharacterLock('c1', '12'), false, '太短应拒绝');
  assert.equal(await security.isCharacterLocked('c1'), false, '拒绝后不应留下上锁记录');
  // 超长不是「拒绝」：normalizePin 静默截断到 8 位（共享层既有规则，手机同款）。
  // 这里钉住该语义，避免以后误以为超长会被拒绝而据此写出错误的解锁体验。
  assert.equal(await security.setCharacterLock('c1', '123456789'), true, '超长按 8 位截断保存');
  assert.equal(await security.verifyCharacterPasscode('c1', '12345678'), true, '截断后的 8 位是有效密码');
  assert.equal(await security.verifyCharacterPasscode('c1', '123456789'), true, '再次输入超长也按截断比较');
  globalThis.window = previous.window;
  globalThis.easychat2 = previous.easychat2;
  sandbox.cleanup();
});
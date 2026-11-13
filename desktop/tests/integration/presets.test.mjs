// S16 集成测试：桌面全局预设的增/改/删**真的**落进共享存储。
//
// 为什么用集成而不是结构断言：预设是「写进去就要立刻生效」的数据（useChatSend
// 每轮读 getEnabledGlobalPresetPrompts）。界面有表单不等于写对了——必须验到
// 「saveGlobalPresets 往返后 getGlobalPresets 读回同一份」。
//
// 与 autoBackup / roleLock 同一做法：共享层 storage/globalPresets.js + 桌面
// AsyncStorage 适配层 + 真实主进程 kv 服务（临时目录）。
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
  const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'easychat2-presets-'));
  const outfile = path.join(outdir, 'bundle.cjs');
  await build({
    entryPoints: [path.join(DESKTOP, 'tests', 'fixtures', 'presetsEntry.js')],
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

test('全局预设：新增 → 编辑 → 删除，每一步都能读回', async () => {
  const sandbox = makeSandbox();
  const previous = installBridge(sandbox);
  const store = await bundle();

  const base = await store.getGlobalPresets();
  const baseIds = new Set(base.map(item => item.id));

  // 新增：id 由共享层生成（不与既有 id、也不与开关表里的键冲突）。
  const id = await store.createGlobalPresetId(base);
  assert.ok(id.startsWith('preset-'), `生成的 id 形状不对：${id}`);
  assert.equal(baseIds.has(id), false, '新 id 不得与既有 id 撞');
  const created = await store.saveGlobalPresets([
    ...base,
    { id, name: '控制篇幅', description: '短句', prompt: '每次回复不超过三句。' },
  ]);
  const found = created.find(item => item.id === id);
  assert.ok(found, '新增后应能读到该条目');
  assert.equal(found.name, '控制篇幅');
  assert.equal(found.prompt, '每次回复不超过三句。');

  // 编辑：同 id 替换，其余条目保持不动。
  const edited = await store.saveGlobalPresets(
    created.map(item => (item.id === id ? { ...item, name: '控制篇幅（改）', prompt: '两句话以内。' } : item))
  );
  const editedItem = edited.find(item => item.id === id);
  assert.equal(editedItem.name, '控制篇幅（改）');
  assert.equal(editedItem.prompt, '两句话以内。');
  assert.equal(edited.filter(item => item.id === id).length, 1, '编辑不得产生重复条目');

  // 删除：重读 → 过滤 → 写回（与界面同顺序）。
  const afterDelete = await store.saveGlobalPresets(
    (await store.getGlobalPresets()).filter(item => item.id !== id)
  );
  assert.equal(afterDelete.some(item => item.id === id), false, '删除后不应再有该条目');
  assert.equal(afterDelete.length, created.length - 1, '只删一条，其余保留');

  globalThis.window = previous.window;
  globalThis.easychat2 = previous.easychat2;
  sandbox.cleanup();
});

test('全局预设：名称或提示词为空白时拒绝保存（不写半截条目）', async () => {
  const sandbox = makeSandbox();
  const previous = installBridge(sandbox);
  const store = await bundle();
  const base = await store.getGlobalPresets();
  const id = await store.createGlobalPresetId(base);

  await assert.rejects(
    () => store.saveGlobalPresets([...base, { id, name: '   ', prompt: '有内容' }]),
    '空白名称必须被拒绝'
  );
  await assert.rejects(
    () => store.saveGlobalPresets([...base, { id, name: '有名字', prompt: '  ' }]),
    '空白提示词必须被拒绝'
  );
  // 拒绝后列表不应被改动。
  const after = await store.getGlobalPresets();
  assert.equal(after.some(item => item.id === id), false, '被拒绝的条目不得落盘');

  globalThis.window = previous.window;
  globalThis.easychat2 = previous.easychat2;
  sandbox.cleanup();
});

test('全局预设：开关只对存在的条目生效，删除后的开关不会让旧条目复活', async () => {
  const sandbox = makeSandbox();
  const previous = installBridge(sandbox);
  const store = await bundle();
  const base = await store.getGlobalPresets();
  const first = base[0];
  assert.ok(first, '内置预设应至少有一条（否则这条测试无意义）');

  const enabled = await store.saveGlobalPresetSettings({ [first.id]: true });
  assert.equal(enabled[first.id], true, '开关应能写入');

  // 删除该条目后，normalizeEnabledMap 以 presets 为准重建——旧键必须消失。
  await store.saveGlobalPresets(base.filter(item => item.id !== first.id));
  const prompts = await store.getEnabledGlobalPresetPrompts();
  assert.equal(
    prompts.some(prompt => prompt === first.prompt),
    false,
    '删除后的预设不得仍出现在发给模型的提示词里'
  );

  globalThis.window = previous.window;
  globalThis.easychat2 = previous.easychat2;
  sandbox.cleanup();
});
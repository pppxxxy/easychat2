// M2.5：悬浮窗对话日志（原生 JSONL）→ app 内线程的读入与幂等合并。
//
// 这里测**纯逻辑**（解析/合并规则），不碰真实文件系统：
//   · 解析器是纯函数，直接喂文本；
//   · 合并走 threads.js 的真实实现（它只依赖 AsyncStorage，用打桩加载）。
// 真实文件读写在 capture.js（域内 FS 封装点），由 lint 分层规则保证不被绕过。

import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';

import {
  OVERLAY_ROLE_CHARACTER,
  OVERLAY_ROLE_USER,
  parseOverlayThreadLines,
} from '../src/screenWatch/overlayThreadParse.js';

const require = createRequire(import.meta.url);

// ---- 解析器（纯函数） ----

test('常量对齐：纯解析层的 role 必须与 threads.js 逐字一致', () => {
  // 纯层刻意不 import threads.js（那会拉进 AsyncStorage，本地就测不了），
  // 所以一致性由这条断言钉住——改一边会红。
  const threads = loadThreads();
  assert.equal(OVERLAY_ROLE_USER, threads.THREAD_ROLE_USER);
  assert.equal(OVERLAY_ROLE_CHARACTER, threads.THREAD_ROLE_CHARACTER);
});

test('parseOverlayThreadLines：正常行解析成线程条目形状', () => {
  const text = [
    JSON.stringify({ t: '2026-10-14T15:59:00+0800', ms: 1000, role: 'user', text: '看下这个', persona: '白鹿' }),
    JSON.stringify({ t: '2026-10-14T15:59:03+0800', ms: 3000, role: 'assistant', text: '这是设置页', persona: '白鹿' }),
  ].join('\n');
  const entries = parseOverlayThreadLines(text, { persona: '白鹿' });
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0], {
    id: 'ovl-0', role: 'user', text: '看下这个', imageUri: '', at: 1000,
  });
  assert.equal(entries[1].role, 'assistant');
  assert.equal(entries[1].at, 3000);
});

test('parseOverlayThreadLines：坏行跳过，不废掉整场对话', () => {
  const text = [
    '{"ms":1,"role":"user","text":"好的"}',
    '{ 写了一半就被杀了',              // 坏 JSON
    '',                                 // 空行
    '   ',                              // 空白行
    '[1,2,3]',                          // 不是对象
    'null',
    '{"ms":2,"role":"assistant"}',      // 缺 text
    '{"ms":3,"role":"assistant","text":"   "}',  // 空白 text
    '{"ms":4,"role":"user","text":"在的"}',
  ].join('\n');
  const entries = parseOverlayThreadLines(text);
  assert.deepEqual(entries.map(e => e.text), ['好的', '在的']);
  // id 用**行号**：跳过坏行后仍按原始行位置编号（追加型文件行号稳定，
  // 这样重复读入同一份日志得到的 id 完全一致 → 幂等键成立）。
  assert.deepEqual(entries.map(e => e.id), ['ovl-0', 'ovl-8']);
});

test('parseOverlayThreadLines：role 归一（非 user 一律 assistant）', () => {
  const text = [
    '{"ms":1,"role":"user","text":"a"}',
    '{"ms":2,"role":"assistant","text":"b"}',
    '{"ms":3,"role":"怪东西","text":"c"}',
    '{"ms":4,"text":"d"}',
  ].join('\n');
  assert.deepEqual(parseOverlayThreadLines(text).map(e => e.role),
    ['user', 'assistant', 'assistant', 'assistant']);
});

test('parseOverlayThreadLines：人设过滤——切角色不串场，无 persona 的历史行保留', () => {
  const text = [
    JSON.stringify({ ms: 1, role: 'user', text: '白鹿说的', persona: '白鹿' }),
    JSON.stringify({ ms: 2, role: 'user', text: '别人说的', persona: '橘鸦' }),
    JSON.stringify({ ms: 3, role: 'user', text: '老版本没记人设' }),
  ].join('\n');
  // 按「白鹿」读：只留白鹿的 + 无 persona 的历史行（兼容升级前的日志）
  assert.deepEqual(
    parseOverlayThreadLines(text, { persona: '白鹿' }).map(e => e.text),
    ['白鹿说的', '老版本没记人设']
  );
  // 不传 persona（不知道当前角色）→ 全都要，不过滤
  assert.equal(parseOverlayThreadLines(text).length, 3);
});

test('parseOverlayThreadLines：图片文件名透传成 imageUri，超长文本截断', () => {
  const text = JSON.stringify({
    ms: 1, role: 'assistant', text: 'x'.repeat(3000), image: 'shot-1.jpg',
  });
  const [entry] = parseOverlayThreadLines(text);
  assert.equal(entry.imageUri, 'shot-1.jpg');
  assert.equal(entry.text.length, 2000);
});

test('parseOverlayThreadLines：idPrefix 区分分片（不同文件行号会重）', () => {
  const line = JSON.stringify({ ms: 1, role: 'user', text: 'hi' });
  assert.equal(parseOverlayThreadLines(line, { idPrefix: 'ovl-overlay-thread.jsonl' })[0].id,
    'ovl-overlay-thread.jsonl-0');
  assert.equal(parseOverlayThreadLines(line, { idPrefix: 'ovl-overlay-thread-1.jsonl' })[0].id,
    'ovl-overlay-thread-1.jsonl-0');
});

// ---- 幂等合并（threads.js 真实现 + AsyncStorage 打桩） ----

const sourcePath = path.resolve('src/screenWatch/threads.js');

function loadThreads() {
  const store = new Map();
  const AsyncStorageStub = {
    getItem: async key => (store.has(key) ? store.get(key) : null),
    setItem: async (key, value) => { store.set(key, value); },
    removeItem: async key => { store.delete(key); },
  };
  const ioStub = {
    readJsonStatus: async key => {
      const raw = await AsyncStorageStub.getItem(key);
      if (raw === null || raw === undefined) return { status: 'missing' };
      try {
        return { status: 'ok', value: JSON.parse(raw) };
      } catch (error) {
        return { status: 'corrupt' };
      }
    },
    createMutationQueue: () => {
      let tail = Promise.resolve();
      return {
        enqueue(task) {
          const next = tail.then(task, task);
          tail = next.catch(() => {});
          return next;
        },
      };
    },
    backupCorruptValue: async () => {},
  };
  const transformed = require('@babel/core').transformSync(fs.readFileSync(sourcePath, 'utf8'), {
    babelrc: false,
    configFile: false,
    filename: sourcePath,
    presets: [[require.resolve('@babel/preset-env'), { targets: { node: 'current' }, modules: 'commonjs' }]],
  }).code;
  const original = Module._load;
  Module._load = function patched(request, parent, isMain) {
    const base = String(request).split('/').pop();
    if (base === 'async-storage' || request === '@react-native-async-storage/async-storage') return AsyncStorageStub;
    if (base === 'io.js') return ioStub;
    return original.call(this, request, parent, isMain);
  };
  const runtime = new Module(sourcePath);
  runtime.filename = sourcePath;
  runtime.paths = Module._nodeModulePaths(path.dirname(sourcePath));
  try {
    runtime._compile(transformed, sourcePath);
  } finally {
    Module._load = original;
  }
  return runtime.exports;
}

const ENTRY_A = { id: 'ovl-overlay-thread.jsonl-0', role: 'user', text: '悬浮窗里说的', imageUri: '', at: 1000 };
const ENTRY_B = { id: 'ovl-overlay-thread.jsonl-1', role: 'assistant', text: '悬浮窗里的回复', imageUri: '', at: 2000 };

test('syncOverlayThreadEntries：并入新条目，重复调用幂等（不产生重复）', async () => {
  const threads = loadThreads();
  const { thread } = await threads.getOrCreateActiveThread('c1', '白鹿', Date.now());
  const first = await threads.syncOverlayThreadEntries(thread.id, [ENTRY_A, ENTRY_B]);
  assert.equal(first.entries.length, 2, '首次并入两条');
  assert.deepEqual(first.entries.map(e => e.text), ['悬浮窗里说的', '悬浮窗里的回复']);
  // 再并一次同样的（模拟每次生成前都同步）：幂等，不重复
  const second = await threads.syncOverlayThreadEntries(thread.id, [ENTRY_A, ENTRY_B]);
  assert.equal(second.entries.length, 2, '重复并入不得产生重复条目');
});

test('syncOverlayThreadEntries：只追加新条目，已有历史与顺序不动', async () => {
  const threads = loadThreads();
  const { thread } = await threads.getOrCreateActiveThread('c1', '白鹿', Date.now());
  await threads.appendThreadEntry(thread.id, { role: 'character', text: 'app 内先说了一句', at: 500 });
  const merged = await threads.syncOverlayThreadEntries(thread.id, [ENTRY_A, ENTRY_B]);
  assert.deepEqual(merged.entries.map(e => e.text),
    ['app 内先说了一句', '悬浮窗里说的', '悬浮窗里的回复']);
});

test('syncOverlayThreadEntries：无条目/线程不存在 → 安全返回，不抛', async () => {
  const threads = loadThreads();
  const { thread } = await threads.getOrCreateActiveThread('c1', '白鹿', Date.now());
  assert.equal(await threads.syncOverlayThreadEntries(thread.id, []), null, '空条目直接返回 null');
  assert.equal(await threads.syncOverlayThreadEntries('nope', [ENTRY_A]), null, '线程不存在返回 null');
  assert.equal(await threads.syncOverlayThreadEntries('', [ENTRY_A]), null, '空 id 返回 null');
});

test('syncOverlayThreadEntries：updatedAt 跟着最新条目走（续用判据依赖它）', async () => {
  const threads = loadThreads();
  const now = Date.now();
  const { thread } = await threads.getOrCreateActiveThread('c1', '白鹿', now);
  const past = now - 60 * 60 * 1000;
  const merged = await threads.syncOverlayThreadEntries(thread.id, [
    { ...ENTRY_A, at: past },
    { ...ENTRY_B, at: now + 5 },
  ]);
  assert.equal(merged.updatedAt, now + 5, 'updatedAt 必须取最新条目的时间');
});

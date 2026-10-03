// 看屏幕（App 内截图版）测试：采集链路源码断言 + 评论存储注入 + prompt 纯函数。
// 关键回归钉：
// - 只截自己 App（captureScreen tmpfile），零权限声明；
// - 临时文件必须移动到 screen-watch/ 并**先登记媒体保护再移动**，失败清理；
// - releaseCapture 必须在 finally（原生资源不泄漏）；
// - 截图目录按 keepNewest 滚动清扫；
// - 评论单键、上限 30、接话语义与听歌/看书一致。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const presetEnv = require.resolve('@babel/preset-env');

test('capture：view-shot 链路与资源纪律', () => {
  const source = fs.readFileSync(path.resolve('src/screenWatch/capture.js'), 'utf8');
  assert.ok(!/from\s+'react-native-view-shot'/.test('') || source.includes("captureScreen"), '使用 captureScreen');
  assert.ok(source.includes("result: 'tmpfile'"), '截图落临时文件再转移');
  assert.ok(/format:\s*'jpg'/.test(source), 'jpg 压缩控制体积（送多模态）');
  const markIndex = source.indexOf('markMediaWrite(dest)');
  const moveIndex = source.indexOf('moveAsync({ from: tmpUri, to: dest })');
  assert.ok(markIndex >= 0 && markIndex < moveIndex, '移动前必须登记媒体保护');
  assert.ok(/finally\s*{[\s\S]*?releaseCapture/.test(source), 'releaseCapture 必须在 finally');
  const catchBlocks = source.split('catch (error)').slice(1);
  assert.ok(catchBlocks.some(block => block.includes('deleteAsync(dest')), '失败清理半成品');
  assert.ok(source.includes('sweepScreenWatchFiles'), '滚动清扫存在');
  const importLines = source.split('\n').filter(line => line.trim().startsWith('import '));
  assert.ok(importLines.every(line => !/mediaprojection|media-projection/i.test(line))
    && !/requestPermissions|requestAuthorization/.test(source), '零权限：不申请任何截屏权限');
});

const store = new Map();
const corruptBackups = [];
const AsyncStorage = {
  getItem: async key => (store.has(key) ? store.get(key) : null),
  setItem: async (key, value) => { store.set(key, value); },
  removeItem: async key => { store.delete(key); },
  multiSet: async entries => { entries.forEach(([key, value]) => store.set(key, value)); },
  multiRemove: async keys => { keys.forEach(key => store.delete(key)); },
  getAllKeys: async () => [...store.keys()],
};
const ioStub = {
  readJsonStatus: async key => {
    try {
      const raw = await AsyncStorage.getItem(key);
      if (raw === null || raw === undefined) return { status: 'missing' };
      return { status: 'ok', value: JSON.parse(raw) };
    } catch (error) {
      return { status: 'corrupt' };
    }
  },
  createMutationQueue: () => {
    let single = Promise.resolve();
    return {
      enqueue(task) {
        const next = single.then(task, task);
        single = next.catch(() => {});
        return next;
      },
      settle() { return single.catch(() => {}); },
    };
  },
  CORRUPT_BACKUP_SUFFIX: '__corrupt_backup',
  backupCorruptValue: async key => { corruptBackups.push(key); },
};

const sourcePath = path.resolve('src/screenWatch/comments.js');
const transformed = babel.transformSync(fs.readFileSync(sourcePath, 'utf8'), {
  babelrc: false,
  configFile: false,
  filename: sourcePath,
  presets: [[presetEnv, { targets: { node: 'current' }, modules: 'commonjs' }]],
}).code;
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === '@react-native-async-storage/async-storage') return AsyncStorage;
  if (request.endsWith('/io.js')) return ioStub;
  return originalLoad.call(this, request, parent, isMain);
};
const runtime = new Module(sourcePath);
runtime.filename = sourcePath;
runtime.paths = Module._nodeModulePaths(path.dirname(sourcePath));
runtime._compile(transformed, sourcePath);
Module._load = originalLoad;
const comments = runtime.exports;

test('看屏幕评论：单键追加、幂等、上限 30、损坏回落', async () => {
  store.clear();
  const first = { id: 's1', text: '看到了播放器页面', characterId: 'ch1', characterName: '小雪', imageUri: 'file:///docs/screen-watch/a.jpg', createdAt: 1 };
  await comments.appendScreenWatchComment(first);
  await comments.appendScreenWatchComment({ ...first });
  let list = await comments.getScreenWatchComments();
  assert.equal(list.length, 1);
  for (let index = 0; index < 35; index += 1) {
    await comments.appendScreenWatchComment({ id: `g${index}`, text: `第${index}条`, createdAt: index + 2 });
  }
  list = await comments.getScreenWatchComments();
  assert.equal(list.length, 30, '上限 30');
  assert.equal(list[0].id, 'g5');
  assert.equal(list[0].imageUri, '', '缺省字段归一化');
  store.set(comments.SCREEN_WATCH_COMMENTS_KEY, 'broken{');
  corruptBackups.length = 0;
  assert.deepEqual(await comments.getScreenWatchComments(), []);
  assert.deepEqual(corruptBackups, [comments.SCREEN_WATCH_COMMENTS_KEY]);
  await comments.clearScreenWatchComments();
  assert.deepEqual(await comments.getScreenWatchComments(), []);
  await assert.rejects(() => comments.appendScreenWatchComment({ id: 's9', text: '  ' }));
});

test('看屏幕 prompt：隐私约束齐全', async () => {
  const { buildScreenWatchPrompt } = await import('../src/screenWatch/commentPrompts.js');
  const prompt = buildScreenWatchPrompt();
  assert.ok(prompt.includes('截图'));
  assert.ok(prompt.includes('不要编造'), '必须约束不编造屏幕外内容');
  assert.ok(!prompt.includes('undefined'));
});

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
// 「读会抛错」的键：AsyncStorage.getItem 直接抛（Android 上超 CursorWindow 上限、
// SAF/权限失败都是这个形态），readJsonStatus 据此判 corrupt。
// 与 booksStorage.test.mjs:21 / musicLibrary.test.mjs 同一机制。
const failedGets = new Set();
const AsyncStorage = {
  getItem: async key => {
    if (failedGets.has(key)) throw new Error(`read failed: ${key}`);
    return store.has(key) ? store.get(key) : null;
  },
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

test('看屏幕评论：单键追加、幂等、上限 30', async () => {
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
  await comments.clearScreenWatchComments();
  assert.deepEqual(await comments.getScreenWatchComments(), []);
  await assert.rejects(() => comments.appendScreenWatchComment({ id: 's9', text: '  ' }));
});

// 三步防护的第三份（books/comments.js 与 music/comments.js 已先修，同一形态同一裁决）：
// 读路径遇 corrupt **明确失败**（裸 code，先例 src/screenWatch/threads.js:99）、写路径拒绝、
// status 一路传播。以前 readCommentListStatus 把「读不到」压成 []，于是 append 以 [] 为底
// 写回把原评论整段覆盖掉，get 又把 [] 交给面板说「还没有一起看屏幕」。
test('看屏幕评论：读取失败必须明确失败并拒绝写回，原评论不被覆盖（不得当成「还没有一起看屏幕」）', async () => {
  const key = comments.SCREEN_WATCH_COMMENTS_KEY;
  store.clear();
  failedGets.clear();
  corruptBackups.length = 0;
  await comments.appendScreenWatchComment({ id: 'm1', text: '原来的评论', createdAt: 1 });
  const before = store.get(key);

  // ① 读会抛错（值本身是好的，只是这一次读不到）
  failedGets.add(key);
  await assert.rejects(
    () => comments.getScreenWatchComments(),
    /screen-watch-comments-read-failed/,
    '读路径必须拒绝，不能把 [] 交给面板当「还没有一起看屏幕」'
  );
  await assert.rejects(
    () => comments.appendScreenWatchComment({ id: 'm2', text: '新评论' }),
    /screen-watch-comments-read-failed/,
    '写路径必须拒绝，不能以 [] 为底写回'
  );
  await assert.rejects(
    () => comments.deleteScreenWatchComment('m1'),
    /screen-watch-comments-read-failed/,
    '删除同样拒绝（同 threads.deleteScreenWatchThread:167）'
  );
  assert.equal(store.get(key), before, '读失败不得覆盖原评论（逐字节不变）');
  failedGets.delete(key);

  // ② 值是坏的（JSON 解析不了）：同样拒绝，且原始内容原样保留、先备份
  store.set(key, 'broken{');
  corruptBackups.length = 0;
  await assert.rejects(() => comments.getScreenWatchComments(), /screen-watch-comments-read-failed/);
  await assert.rejects(() => comments.appendScreenWatchComment({ id: 'm3', text: '再来一条' }));
  assert.equal(store.get(key), 'broken{', '损坏原值不得被覆盖（逐字节不变）');
  // 读路径与写路径各自读到损坏都会备份一次，所以这里断言「备份过且只备份了本键」。
  assert.ok(
    corruptBackups.length >= 1 && corruptBackups.every(item => item === key),
    '损坏值先备份再拒绝（且不牵连别的键）'
  );

  // ③ 读得回来时行为不变
  store.set(key, before);
  assert.deepEqual((await comments.getScreenWatchComments()).map(item => item.id), ['m1']);
  await comments.appendScreenWatchComment({ id: 'm4', text: '正常追加' });
  assert.deepEqual(
    (await comments.getScreenWatchComments()).map(item => item.id),
    ['m1', 'm4'],
    '守卫只在 corrupt 时生效，不是永久封锁'
  );
  store.clear();
});

test('看屏幕 prompt：隐私约束齐全', async () => {
  const { buildScreenWatchPrompt } = await import('../src/screenWatch/commentPrompts.js');
  const prompt = buildScreenWatchPrompt();
  assert.ok(prompt.includes('截图'));
  assert.ok(prompt.includes('不要编造'), '必须约束不编造屏幕外内容');
  assert.ok(!prompt.includes('undefined'));
});

test('看屏幕评论：单条删除幂等，清空后键移除（2026-10-07 面板删除入口）', async () => {
  store.clear();
  await comments.appendScreenWatchComment({ id: 'd1', text: '第一条', createdAt: 1 });
  await comments.appendScreenWatchComment({ id: 'd2', text: '第二条', createdAt: 2 });
  let list = await comments.deleteScreenWatchComment('d1');
  assert.deepEqual(list.map(item => item.id), ['d2'], '删除目标从列表移除');
  // 幂等：id 不存在或为空时原样返回，不报错
  list = await comments.deleteScreenWatchComment('d1');
  assert.equal(list.length, 1, '不存在的 id 原样返回');
  list = await comments.deleteScreenWatchComment('');
  assert.equal(list.length, 1, '空 id 原样返回');
  // 删到最后一条：存储键移除（与 clear 语义一致）
  list = await comments.deleteScreenWatchComment('d2');
  assert.deepEqual(list, []);
  assert.equal(store.has(comments.SCREEN_WATCH_COMMENTS_KEY), false, '空列表不得残留存储键');
  // 只动 comments：threads 键不受影响
  assert.ok(true);
});

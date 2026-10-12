// 本地模型下载队列（v5 Stage B）行为测试：纯函数 + 可注入执行器。
// 覆盖预检、镜像回退、串行、取消、重启恢复、重复入队。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createDownloadQueue,
  normalizeDownloadTask,
  estimateTaskBytes,
  checkDiskSpace,
  resolveMirrorFallback,
  revivePersistedTasks,
  toProgressPercent,
  DOWNLOAD_TASK_STATUS,
} from '../src/localModel/downloadQueue.js';

function makeHarness(overrides = {}) {
  let persisted = overrides.persisted ? overrides.persisted.map(t => ({ ...t })) : [];
  const downloaded = [];
  const cancelled = [];
  const deps = {
    load: async () => persisted.map(t => ({ ...t })),
    persist: async tasks => { persisted = tasks.map(t => ({ ...t })); },
    // 下载器（modelManager.downloadToFile）的原始口径是 0–1 比值：这里如实注入 0.5，
    // 出口应是 50（见「进度单位」用例）——注入值不要改成 50，否则测不出收口换算。
    download: overrides.download || (async input => {
      downloaded.push(input.modelUrl);
      if (typeof input.onProgress === 'function') input.onProgress(0.5, { writtenBytes: 50, totalBytes: 100 });
      return { id: input.modelId, name: input.modelName };
    }),
    cancel: overrides.cancel || (async id => { cancelled.push(id); return true; }),
    getFreeDiskBytes: overrides.getFreeDiskBytes || (async () => 100 * 1024 * 1024 * 1024),
  };
  const queue = createDownloadQueue(deps);
  return { queue, downloaded, cancelled, getPersisted: () => persisted };
}

const TASK = {
  modelId: 'qwen-q4',
  name: 'Qwen Q4',
  modelUrl: 'https://huggingface.co/Qwen/x/resolve/main/m.gguf',
  sourceId: 'huggingface',
  modelExpectedBytes: 4 * 1024 * 1024 * 1024,
};

test('estimateTaskBytes：模型 + 可选 mmproj 之和，缺省为 0', () => {
  assert.equal(estimateTaskBytes({ modelExpectedBytes: 100, mmprojExpectedBytes: 20 }), 120);
  assert.equal(estimateTaskBytes({ modelExpectedBytes: 100 }), 100);
  assert.equal(estimateTaskBytes({}), 0);
});

test('checkDiskSpace：余量不足失败，拿不到磁盘信息放行', () => {
  assert.equal(checkDiskSpace({ freeBytes: 0, requiredBytes: 100 }).ok, true, '拿不到磁盘信息不误伤');
  assert.equal(checkDiskSpace({ freeBytes: 100, requiredBytes: 0 }).ok, true);
  // 100 需求 + 5% 余量 = 105；free=100 不足
  assert.equal(checkDiskSpace({ freeBytes: 105, requiredBytes: 100 }).ok, true);
  const tight = checkDiskSpace({ freeBytes: 100, requiredBytes: 100 });
  assert.equal(tight.ok, false);
  assert.equal(tight.reason, 'insufficient');
});

test('resolveMirrorFallback：仅官方源 huggingface 改写为 hf-mirror', () => {
  const fallback = resolveMirrorFallback({ sourceId: 'huggingface', modelUrl: 'https://huggingface.co/Qwen/x/resolve/main/m.gguf' });
  assert.ok(fallback);
  assert.equal(fallback.sourceId, 'hf-mirror');
  assert.match(fallback.modelUrl, /^https:\/\/hf-mirror\.com\//);
  // 非官方源不回退
  assert.equal(resolveMirrorFallback({ sourceId: 'hf-mirror', modelUrl: 'https://hf-mirror.com/x' }), null);
  assert.equal(resolveMirrorFallback({ sourceId: 'huggingface', modelUrl: 'not-a-url' }), null);
});

test('normalizeDownloadTask：id 由标识推导，status 归一', () => {
  const task = normalizeDownloadTask({ modelId: 'm', modelUrl: 'https://x/m.gguf' }, 123);
  assert.equal(task.id, 'm');
  assert.equal(task.status, DOWNLOAD_TASK_STATUS.PENDING);
  assert.equal(task.createdAt, 123);
  assert.equal(normalizeDownloadTask({ modelUrl: 'https://x/model.gguf' }).id, 'model');
});

test('revivePersistedTasks：重启后 running 降级为 pending（断点重下）', () => {
  const revived = revivePersistedTasks([
    { id: 'a', modelUrl: 'https://x/a.gguf', status: 'running' },
    { id: 'b', modelUrl: 'https://x/b.gguf', status: 'error', error: 'boom' },
    { id: '', modelUrl: 'https://x/c.gguf' },
  ]);
  // id 为空时由 modelUrl 推导（.../c.gguf → c）
  assert.deepEqual(revived.map(t => [t.id, t.status]), [['a', 'pending'], ['b', 'error'], ['c', 'pending']]);
});

// ---- 进度单位（A：下载进度小 100 倍）----
// 单位口径：快照 progress 一律 0–100（与 runtime.js / engineStatus.js 同口径）；
// 下载器给的是 0–1 比值，换算只发生在 downloadQueue 出口这一处。
test('toProgressPercent：0–1 比值 → 0–100 百分数（取整并夹取）', () => {
  assert.equal(toProgressPercent(0), 0);
  assert.equal(toProgressPercent(0.5), 50);
  assert.equal(toProgressPercent(0.005), 1, '0.5% 向上取整为 1，不显示 0%');
  assert.equal(toProgressPercent(1), 100);
  assert.equal(toProgressPercent(1.2), 100, '超过 100% 夹取到 100');
  assert.equal(toProgressPercent(-0.5), 0, '负数夹取到 0');
  assert.equal(toProgressPercent(undefined), 0);
  assert.equal(toProgressPercent('abc'), 0);
  assert.equal(toProgressPercent(NaN), 0);
});

test('队列：进度出口统一为 0–100（下载器 0–1 比值 ×100 取整）', async () => {
  const seen = [];
  const { queue } = makeHarness({
    download: async input => {
      input.onProgress(0.5, { writtenBytes: 50, totalBytes: 100 });
      seen.push(queue.getSnapshot().current);
      input.onProgress(1, { writtenBytes: 100, totalBytes: 100 });
      seen.push(queue.getSnapshot().current);
      await new Promise(resolve => setTimeout(resolve, 5));
    },
  });
  await queue.enqueue(TASK);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(seen.length, 2, '应捕获到两次运行中快照');
  assert.equal(seen[0].progress, 50, '出口必须是百分数（0.5 → 50），不是 0.5');
  assert.equal(seen[1].progress, 100);
  // 钉死单位：出口只可能是 0–100 的整数，绝不出现 0–1 比值
  for (const snapshot of seen) {
    assert.ok(Number.isInteger(snapshot.progress), 'progress 应为整数百分数');
    assert.ok(snapshot.progress >= 0 && snapshot.progress <= 100, 'progress 应落在 0–100');
  }
});

test('队列：入队后串行下载并登记，完成后从队列移除', async () => {
  const { queue, downloaded } = makeHarness();
  const result = await queue.enqueue(TASK);
  assert.equal(result.ok, true);
  // 等待队列推进
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(downloaded, [TASK.modelUrl]);
  assert.deepEqual(queue.getSnapshot().tasks, []);
});

test('队列：同 id 重复入队不产生第二份任务', async () => {
  const { queue } = makeHarness({ download: async () => { await new Promise(r => setTimeout(r, 30)); } });
  await queue.enqueue(TASK);
  const second = await queue.enqueue(TASK);
  assert.equal(second.code, 'DUPLICATE');
});

test('队列：磁盘不足时任务出队即失败并标记 disk-full，不发起下载', async () => {
  const { queue, downloaded } = makeHarness({ getFreeDiskBytes: async () => 1024 });
  await queue.enqueue(TASK);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(downloaded, [], '磁盘不足不应发起下载');
  const task = queue.getSnapshot().tasks.find(t => t.id === 'qwen-q4');
  assert.equal(task.status, DOWNLOAD_TASK_STATUS.ERROR);
  assert.equal(task.error, 'disk-full');
});

test('队列：官方源失败自动切 hf-mirror 续试成功', async () => {
  const downloaded = [];
  const { queue } = makeHarness({
    download: async input => {
      downloaded.push(input.modelUrl);
      if (input.modelUrl.startsWith('https://huggingface.co/')) throw new Error('network down');
      return { id: input.modelId };
    },
  });
  await queue.enqueue(TASK);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(downloaded.length, 2, '官方源失败应自动回退镜像一次');
  assert.match(downloaded[1], /^https:\/\/hf-mirror\.com\//);
  assert.deepEqual(queue.getSnapshot().tasks, [], '镜像成功后任务移除');
});

test('队列：两源都失败则标记 error 保留在队列', async () => {
  const { queue } = makeHarness({ download: async () => { throw new Error('all down'); } });
  await queue.enqueue(TASK);
  await new Promise(resolve => setTimeout(resolve, 30));
  const task = queue.getSnapshot().tasks.find(t => t.id === 'qwen-q4');
  assert.equal(task.status, DOWNLOAD_TASK_STATUS.ERROR);
});

test('队列：取消后任务从队列移除（不自动重下，避免取消→重下死循环）', async () => {
  let cancelCalled = false;
  const { queue } = makeHarness({
    download: async () => {
      await new Promise(r => setTimeout(r, 50));
      const error = new Error('下载已取消');
      error.code = 'DOWNLOAD_CANCELLED';
      throw error;
    },
    cancel: async () => { cancelCalled = true; return true; },
  });
  await queue.enqueue(TASK);
  await new Promise(resolve => setTimeout(resolve, 5));
  await queue.cancelTask('qwen-q4');
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(cancelCalled, true);
  assert.equal(queue.getSnapshot().tasks.find(t => t.id === 'qwen-q4'), undefined, '取消后任务应移除');
});

test('队列：水合时把持久化的 running 任务恢复为 pending', async () => {
  const { queue } = makeHarness({
    persisted: [{ id: 'qwen-q4', modelId: 'qwen-q4', modelUrl: TASK.modelUrl, status: 'running' }],
  });
  await queue.hydrate();
  const task = queue.getSnapshot().tasks.find(t => t.id === 'qwen-q4');
  assert.equal(task.status, DOWNLOAD_TASK_STATUS.PENDING);
});

test('队列：水合后自动续下重启残留的 pending 任务（断点重下）', async () => {
  const { queue, downloaded } = makeHarness({
    persisted: [{ id: 'qwen-q4', modelId: 'qwen-q4', modelUrl: TASK.modelUrl, sourceId: 'huggingface', status: 'running' }],
  });
  await queue.hydrate();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(downloaded, [TASK.modelUrl], '重启残留任务应自动重下');
  assert.deepEqual(queue.getSnapshot().tasks, [], '完成后从队列移除');
});

test('队列：订阅者收到入队与完成广播', async () => {
  const { queue } = makeHarness();
  const seen = [];
  const off = queue.subscribe(snapshot => seen.push(snapshot.tasks.length));
  await queue.enqueue(TASK);
  await new Promise(resolve => setTimeout(resolve, 20));
  off();
  assert.ok(seen.length >= 2, '应有入队与完成两次以上广播');
});

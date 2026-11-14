// 桌面自动备份调度器行为测试（settings/useDesktopAutoBackupScheduler.js）。
//
// 手机侧用 AppState 的 active/background 驱动；桌面用 document 的 visibilitychange。
// 这里用假 document + 假计时器把语义钉死，避免「只在某次真机点击里看起来对」：
//   1. 启动后**不立刻**备份（延迟 startDelay 再查到期）——手机端真机教训；
//   2. 回到前台 → 恢复轮询 + 重新排一次延迟查；隐藏 → 停表 + 跑退出备份；
//   3. 同一次备份不重入（定时器与可见性事件可能同时到）；
//   4. stop() 之后不再有任何调用（组件卸载/开关关闭）。
import test from 'node:test';
import assert from 'node:assert/strict';

import { startDesktopAutoBackupScheduler } from '../../src/settings/useDesktopAutoBackupScheduler.js';

// 假计时器：手动推进，避免真等 15 分钟。
function makeTimers() {
  let nextId = 1;
  const intervals = new Map();
  const timeouts = new Map();
  return {
    setInterval: (fn, ms) => {
      const id = nextId += 1;
      intervals.set(id, { fn, ms });
      return id;
    },
    clearInterval: id => { intervals.delete(id); },
    setTimeout: (fn, ms) => {
      const id = nextId += 1;
      timeouts.set(id, { fn, ms });
      return id;
    },
    clearTimeout: id => { timeouts.delete(id); },
    // 手动触发：模拟「时间到了」。
    fireTimeouts: () => {
      const list = [...timeouts.values()];
      timeouts.clear();
      for (const entry of list) entry.fn();
    },
    fireIntervals: () => {
      for (const entry of intervals.values()) entry.fn();
    },
    counts: () => ({ intervals: intervals.size, timeouts: timeouts.size }),
  };
}

function makeDocument() {
  const listeners = new Set();
  const doc = {
    visibilityState: 'visible',
    addEventListener: (name, fn) => { if (name === 'visibilitychange') listeners.add(fn); },
    removeEventListener: (name, fn) => { if (name === 'visibilitychange') listeners.delete(fn); },
  };
  return {
    doc,
    hide: () => { doc.visibilityState = 'hidden'; for (const fn of listeners) fn(); },
    show: () => { doc.visibilityState = 'visible'; for (const fn of listeners) fn(); },
    listenerCount: () => listeners.size,
  };
}

function makeDeps({ failDue = false } = {}) {
  const calls = [];
  // deps 只被传给共享层的 runAutoBackupIfDue / runAutoBackupOnExit；测试里
  // 通过一个可控的 getSettings 让共享层走到「不备份」分支，避免真的读写文件。
  return {
    calls,
    deps: {
      getSettings: async () => {
        calls.push('getSettings');
        if (failDue) throw new Error('boom');
        return { enabled: true, intervalHours: 24, onExit: false, location: { kind: 'app' } };
      },
      recordLastBackupAt: async () => { calls.push('recordLastBackupAt'); },
      exportBackup: async () => ({ data: '{}' }),
      appDirectory: () => '/tmp/auto-backups/',
      readTextFile: async () => '',
      writeTextFile: async () => {},
      listDirectory: async () => [],
      deleteFile: async () => {},
    },
  };
}

test('启动后不立刻备份：先排一次延迟查，再起轮询', async () => {
  const timers = makeTimers();
  const { doc } = makeDocument();
  const { calls, deps } = makeDeps();
  const stop = startDesktopAutoBackupScheduler({ deps, doc, timers });
  // 同步阶段不应发生任何存储调用。
  assert.equal(calls.length, 0, '启动瞬间不该读设置');
  assert.deepEqual(timers.counts(), { intervals: 1, timeouts: 1 });
  stop();
});

test('延迟到点后查一次到期（走到共享层的 isAutoBackupDue）', async () => {
  const timers = makeTimers();
  const { doc } = makeDocument();
  const { calls, deps } = makeDeps();
  const stop = startDesktopAutoBackupScheduler({ deps, doc, timers, startDelayMs: 1000 });
  timers.fireTimeouts();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(calls.includes('getSettings'), '延迟到点应读一次设置');
  stop();
});

test('隐藏 → 停轮询且跑退出备份；回到前台 → 恢复轮询并重排延迟查', async () => {
  const timers = makeTimers();
  const { doc, hide, show } = makeDocument();
  const { deps } = makeDeps();
  const stop = startDesktopAutoBackupScheduler({ deps, doc, timers });
  assert.deepEqual(timers.counts(), { intervals: 1, timeouts: 1 });

  hide();
  // 隐藏时两件事：停表（时间①）+ 立刻跑退出备份（那是一次独立调用，不排新定时器）。
  assert.equal(timers.counts().intervals, 0, '隐藏后应停轮询');
  assert.equal(timers.counts().timeouts, 0, '隐藏后应清掉待触发的延迟查');

  show();
  assert.equal(timers.counts().intervals, 1, '回到前台应恢复轮询');
  assert.equal(timers.counts().timeouts, 1, '回到前台应重排延迟查');
  stop();
});

test('重入保护：定时器与可见性事件同时到只跑一次', async () => {
  const timers = makeTimers();
  const { doc, hide } = makeDocument();
  let running = 0;
  let maxConcurrent = 0;
  const deps = {
    getSettings: async () => {
      running += 1;
      maxConcurrent = Math.max(maxConcurrent, running);
      await new Promise(resolve => setTimeout(resolve, 10));
      running -= 1;
      return { enabled: false, intervalHours: 24, onExit: true };
    },
  };
  const stop = startDesktopAutoBackupScheduler({ deps, doc, timers });
  // 同时触发延迟查与隐藏（后者会跑 exit）。
  timers.fireTimeouts();
  hide();
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(maxConcurrent, 1, '同一时刻只能有一次备份在跑');
  stop();
});

test('stop() 之后不再触发任何回调，并摘掉监听', async () => {
  const timers = makeTimers();
  const harness = makeDocument();
  const { calls, deps } = makeDeps();
  const stop = startDesktopAutoBackupScheduler({ deps, doc: harness.doc, timers });
  stop();
  assert.equal(harness.listenerCount(), 0, 'stop 后应摘掉 visibilitychange 监听');
  assert.deepEqual(timers.counts(), { intervals: 0, timeouts: 0 }, 'stop 后应清掉所有定时器');
  harness.hide();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(!calls.includes('recordLastBackupAt'), 'stop 后不应再产生备份动作');
});

test('任务抛错被吞掉，不影响后续轮次', async () => {
  const timers = makeTimers();
  const { doc } = makeDocument();
  const { deps } = makeDeps({ failDue: true });
  const stop = startDesktopAutoBackupScheduler({ deps, doc, timers });
  timers.fireTimeouts();
  await new Promise(resolve => setTimeout(resolve, 30));
  // 出错后仍应能再跑（busy 已复位）。
  timers.fireTimeouts();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(timers.counts(), { intervals: 1, timeouts: 0 }, '轮询应仍然存在');
  stop();
});
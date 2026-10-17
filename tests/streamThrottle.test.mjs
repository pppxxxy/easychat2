// 流式节流器的行为测试。
//
// 三条口径都要钉住：前沿立即放行（首字不延迟）、窗口内只留最后一个（中间值无信息）、
// 后沿一定补上（窗口内的最后一份文本不能丢）。定时器行为用可注入的 now/schedule 精确
// 复现；另有一条用**真实定时器**的端到端用例，防止注入面与真实实现脱节。

import test from 'node:test';
import assert from 'node:assert/strict';

import { createReasoningStreamThrottle, createStreamThrottle, STREAM_THROTTLE_INTERVAL_MS } from '../src/chat/streamThrottle.js';

// 可控时钟：只实现 now / schedule 两个注入点，语义与真实 setTimeout 一致（到点回调一次）。
function createClock() {
  let time = 0;
  const timers = [];
  return {
    now: () => time,
    schedule: (fn, ms) => {
      const timer = { fn, at: time + Math.max(0, Number(ms) || 0), fired: false };
      timers.push(timer);
      return timer;
    },
    // 推进时间并按到期顺序触发回调（回调里可能再排新定时器，故循环到没有到期项为止）。
    advance(ms) {
      time += ms;
      let guard = 0;
      while (guard < 100) {
        guard += 1;
        const due = timers.find(item => !item.fired && item.at <= time);
        if (!due) break;
        due.fired = true;
        due.fn();
      }
    },
    pending: () => timers.filter(item => !item.fired).length,
  };
}

test('createStreamThrottle：首个值立即放行（前沿，不做纯后沿节流）', () => {
  const clock = createClock();
  const seen = [];
  const throttle = createStreamThrottle(value => seen.push(value), { now: clock.now, schedule: clock.schedule });
  throttle.push('a');
  assert.deepEqual(seen, ['a'], '第一个 token 必须同步落地，否则首字延迟一个窗口');
  assert.equal(clock.pending(), 0, '前沿放行时不该再排后沿定时器');
});

test('createStreamThrottle：窗口内的中间值被合并，只留最后一个', () => {
  const clock = createClock();
  const seen = [];
  const throttle = createStreamThrottle(value => seen.push(value), { now: clock.now, schedule: clock.schedule });
  throttle.push('a');
  clock.advance(1);
  throttle.push('ab');
  clock.advance(1);
  throttle.push('abc');
  assert.deepEqual(seen, ['a'], '窗口内不重复落地');
  clock.advance(STREAM_THROTTLE_INTERVAL_MS);
  assert.deepEqual(seen, ['a', 'abc'], '后沿补的是**最后一个**值，不是队列里的每一个');
  assert.equal(clock.pending(), 0);
});

test('createStreamThrottle：flush 立刻补发待发值；没有待发值就是空操作', () => {
  const clock = createClock();
  const seen = [];
  const throttle = createStreamThrottle(value => seen.push(value), { now: clock.now, schedule: clock.schedule });
  throttle.push('a');
  clock.advance(1);
  throttle.push('ab');
  assert.equal(throttle.flush(), true);
  assert.deepEqual(seen, ['a', 'ab']);
  assert.equal(throttle.flush(), false, '没有待发值时 flush 不重复发');
  assert.deepEqual(seen, ['a', 'ab']);
});

test('createStreamThrottle：窗口过后新值重新走前沿（持续流不会被永久压住）', () => {
  const clock = createClock();
  const seen = [];
  const throttle = createStreamThrottle(value => seen.push(value), { now: clock.now, schedule: clock.schedule });
  throttle.push('a');
  clock.advance(STREAM_THROTTLE_INTERVAL_MS + 1);
  throttle.push('ab');
  clock.advance(STREAM_THROTTLE_INTERVAL_MS + 1);
  throttle.push('abc');
  assert.deepEqual(seen, ['a', 'ab', 'abc'], '每帧至少落地一次');
});

test('createStreamThrottle：非法 intervalMs 回落到默认窗口（不变成 0 而失去节流）', () => {
  const clock = createClock();
  const seen = [];
  const throttle = createStreamThrottle(value => seen.push(value), { intervalMs: 0, now: clock.now, schedule: clock.schedule });
  throttle.push('a');
  clock.advance(1);
  throttle.push('ab');
  assert.deepEqual(seen, ['a'], '0 被视为非法 → 用默认 16ms 窗口');
  clock.advance(STREAM_THROTTLE_INTERVAL_MS);
  assert.deepEqual(seen, ['a', 'ab']);
});

test('createStreamThrottle：真实定时器下窗口内的值也不会丢（端到端）', async () => {
  const seen = [];
  const throttle = createStreamThrottle(value => seen.push(value), { intervalMs: 10 });
  // 同步连推 5 个值：第一个走前沿，其余合并
  for (const value of ['1', '12', '123', '1234', '12345']) throttle.push(value);
  assert.deepEqual(seen, ['1']);
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.deepEqual(seen, ['1', '12345'], '真实定时器兜底把最后一份文本补上');
});

// ---- reasoning 节流器（2026-10-17 性能修复）-------------------------------
// 修复前 reasoning **不**节流：推理模型每个思考 token 都 setMessages 一次 ⇒ 每次整表
// 重渲、随历史线性恶化。它与文本完全同构（回调都带完整 fullReasoning），共用同一套口径。
// 这里钉住：① 只覆写 reasoning，不动 text/pending；② 非当前会话的迟到写入必须丢掉。

test('createReasoningStreamThrottle：只覆写 reasoning，不动 text/pending', () => {
  const before = { id: 'p', text: '正文', reasoning: '旧思考', pending: true, waitingForResponse: true };
  let current = [before];
  const throttle = createReasoningStreamThrottle({
    isCurrentSession: () => true,
    setMessages: updater => { current = updater(current); },
    pendingId: 'p',
    intervalMs: 0,
  });
  throttle.push('新思考内容');
  const after = current[0];
  assert.equal(after.reasoning, '新思考内容', 'reasoning 必须更新');
  assert.equal(after.text, '正文', '不得改动正文');
  assert.equal(after.pending, true, '不得改动 pending');
  assert.equal(after.waitingForResponse, true, '不得改动 waitingForResponse');
});

test('createReasoningStreamThrottle：非当前会话的思考不得写进消息列表', () => {
  let current = [{ id: 'p', text: 'x', reasoning: 'r', pending: true }];
  const throttle = createReasoningStreamThrottle({
    isCurrentSession: () => false,
    setMessages: updater => { current = updater(current); },
    pendingId: 'p',
    intervalMs: 0,
  });
  const snapshot = JSON.stringify(current);
  throttle.push('不该写入');
  throttle.flush();
  assert.equal(JSON.stringify(current), snapshot, '切走后的迟到思考必须丢弃');
});

test('createReasoningStreamThrottle：真实定时器下窗口内的最后一份思考不会丢', async () => {
  let current = [{ id: 'p', text: '', reasoning: '', pending: true }];
  const throttle = createReasoningStreamThrottle({
    isCurrentSession: () => true,
    setMessages: updater => { current = updater(current); },
    pendingId: 'p',
    intervalMs: 10,
  });
  for (const value of ['思', '思考', '思考中', '思考中间']) throttle.push(value);
  assert.equal(current[0].reasoning, '思', '前沿立即放行');
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(current[0].reasoning, '思考中间', '后沿兜底，最后一份思考不丢');
});

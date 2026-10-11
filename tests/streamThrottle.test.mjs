// 流式节流器的行为测试。
//
// 三条口径都要钉住：前沿立即放行（首字不延迟）、窗口内只留最后一个（中间值无信息）、
// 后沿一定补上（窗口内的最后一份文本不能丢）。定时器行为用可注入的 now/schedule 精确
// 复现；另有一条用**真实定时器**的端到端用例，防止注入面与真实实现脱节。

import test from 'node:test';
import assert from 'node:assert/strict';

import { createStreamThrottle, STREAM_THROTTLE_INTERVAL_MS } from '../src/chat/streamThrottle.js';

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

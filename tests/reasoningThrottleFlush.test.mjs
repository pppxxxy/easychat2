// M1：reasoningThrottle 必须与文本节流器一样在结算前 flush。
//
// 缺陷（审核助手指出，已核实属实）：useChatSend 里有两个独立的流式节流器：
//   streamThrottle     —— 正文
//   reasoningThrottle  —— 思考过程（推理模型）
// 全文件搜索 reasoningThrottle.flush 此前是 **0 处**，而 streamThrottle.flush 有 1 处
// （结算前的 catch 分支）。后果：节流窗口里压着的最后一份 reasoning 在结算时被丢弃。
//
// 为什么丢的偏偏是「最后一份」而不是随机一份：节流器的语义是「窗口内只保留最新一份」
// （见 streamThrottle.js 的口径 ②）。所以未 flush ⇒ 丢的就是最新那段思考。
//
// 本文件做两件事：
//   ① 行为测试：证明「不 flush 会丢最后一份」这个机制真实存在（用真节流器）；
//   ② 接线契约：证明 useChatSend 的结算路径确实调了两个 flush。
//      —— 这条只能靠锚点，因为 useChatSend 是 1960 行的 hook，在 Node 里整片渲染
//      需要几十个假 props，那测的是假货（仓库既有先例同口径）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { createStreamThrottle, STREAM_THROTTLE_INTERVAL_MS } from '../src/chat/streamThrottle.js';

// 可控时钟：让节流窗口行为确定，不依赖真实时间。
function makeClock() {
  let now = 0;
  const timers = [];
  return {
    now: () => now,
    advance: ms => { now += ms; },
    schedule: (fn, delay) => {
      const entry = { fn, at: now + delay, cancelled: false };
      timers.push(entry);
      return entry;
    },
    // 触发所有到期的后沿定时器（模拟 setTimeout 到点）
    fireDue: () => {
      timers.filter(t => !t.cancelled && t.at <= now).forEach(t => { t.cancelled = true; t.fn(); });
    },
  };
}

test('机制：不 flush 时，窗口里压着的最后一份值会丢', () => {
  const clock = makeClock();
  const delivered = [];
  const throttle = createStreamThrottle(v => delivered.push(v), {
    intervalMs: 16,
    now: clock.now,
    schedule: clock.schedule,
  });
  // 前沿立即放行第一份
  throttle.push('first');
  assert.deepEqual(delivered, ['first'], '前沿必须立即放行');
  // 窗口内连续推两份：只保留最后一份待发
  clock.advance(5);
  throttle.push('middle');
  clock.advance(5);
  throttle.push('latest');
  assert.deepEqual(delivered, ['first'], '窗口内不应立即发出');
  // 不 flush、也不让定时器到点 ⇒ 最后一份永远发不出去（这就是丢的那一份）
  assert.equal(delivered.length, 1);
  // flush 之后才拿到最新值
  throttle.flush();
  assert.deepEqual(delivered, ['first', 'latest'], 'flush 应放出**最新**那份，不是中间那份');
});

test('机制：flush 是幂等的（没有待发值时不重复发）', () => {
  const clock = makeClock();
  const delivered = [];
  const throttle = createStreamThrottle(v => delivered.push(v), {
    intervalMs: 16,
    now: clock.now,
    schedule: clock.schedule,
  });
  throttle.push('a');
  throttle.flush();
  assert.equal(throttle.flush(), false, '第二次 flush 应返回 false（无待发值）');
  assert.deepEqual(delivered, ['a']);
});

test('机制：后沿定时器本身也会兜底发出（不依赖 flush）', () => {
  const clock = makeClock();
  const delivered = [];
  const throttle = createStreamThrottle(v => delivered.push(v), {
    intervalMs: 16,
    now: clock.now,
    schedule: clock.schedule,
  });
  throttle.push('a');
  clock.advance(5);
  throttle.push('b');
  clock.advance(STREAM_THROTTLE_INTERVAL_MS);
  clock.fireDue();
  assert.deepEqual(delivered, ['a', 'b'], '定时器到点应自动发出待发值');
});

test('接线：useChatSend 的结算路径同时 flush 文本与思考两条节流器', () => {
  const source = fs.readFileSync(path.resolve('src/chat/useChatSend.js'), 'utf8');
  assert.ok(source.includes('reasoningThrottle'), '前提：思考节流器必须存在');
  assert.ok(source.includes('streamThrottle'), '前提：文本节流器必须存在');
  // 核心断言：必须有 reasoningThrottle.flush 调用（此前 0 处）。
  assert.ok(
    /reasoningThrottle\.flush\(\)/.test(source),
    '必须真的调用 reasoningThrottle.flush()——否则结算时丢掉最后一段思考'
  );
  // 两条 flush 必须在**同一处结算路径**上（不能一个在 A 分支、一个在别处）：
  // 判据是它们相邻出现（允许中间有注释/空白）。
  const pair = /streamThrottle\.flush\(\);[\s\S]{0,120}reasoningThrottle\.flush\(\);/.test(source);
  assert.ok(pair, '两条 flush 必须紧邻出现在同一结算路径上（文本在前、思考紧随）');
});

test('接线：flush 必须发生在 catch（停止/失败）路径里，而不是只在成功路径', () => {
  const source = fs.readFileSync(path.resolve('src/chat/useChatSend.js'), 'utf8');
  const flushAt = source.indexOf('reasoningThrottle.flush()');
  assert.ok(flushAt > 0);
  // 往前找最近的 catch —— 说明它就在错误/停止收尾分支里。
  const before = source.slice(0, flushAt);
  const lastCatch = before.lastIndexOf('catch (error)');
  assert.ok(lastCatch > 0, 'flush 应位于 catch 分支内（用户点停止/请求失败都要保住最后一段）');
  // 且 flush 与那个 catch 之间不能跨过函数结束（防止误命中远处的 catch）。
  const between = source.slice(lastCatch, flushAt);
  assert.equal(between.includes('\n  };\n'), false, 'flush 不应跨出当前函数');
});

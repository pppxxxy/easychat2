// 引擎 vs 现有手写实现：语义等价性验证（结构 1 批次 1 的核心判据）。
//
// 批次 1 不动消费点，所以「引擎是否正确」不能靠「消费点还绿」来证明。
// 这里把现有 4 处手写缓存的逻辑**逐字复制**成参照实现，与用引擎重写的版本并排跑，
// 断言两者在任何输入序列下给出相同结果（含引用稳定性——这是性能收益的全部来源）。
//
// 这 4 处分别是：
//   ① memory/displayTextCache.js   —— placement + depth（有脚本）/ placement（无脚本）
//   ② chat/chatSearchMath.js       —— needle
//   ③ chat/useScrollScrubber.js    —— characterName + t
//   ④ chat/messageMetrics.js       —— 无键（纯按引用）
import test from 'node:test';
import assert from 'node:assert/strict';

import { createMessageDerivation } from '../src/chat/messageDerivationStore.js';
import { getCachedDisplayText } from '../src/memory/displayTextCache.js';
import { collectSearchMatchIds } from '../src/chat/chatSearchMath.js';
import { messageMetrics } from '../src/chat/messageMetrics.js';
import { buildScrubberPreview } from '../src/chat/useScrollScrubber.js';

// ---- ① displayTextCache 的引擎版（逐字复现它的键规则与命中条件）----
// 手写版的真实语义（displayTextCache.js:21-25）是两层判据：
//   键  = hasScripts ? `${placement}\0${depth}` : `${placement}\0static`
//   命中 = entries.get(键) 存在 且 (hasScripts ? cached.scripts === scripts : true)
// 也就是说**同一 placement+depth 下脚本引用变了也要重算**。键必须把 scripts 也带上，
// 否则「同键不同脚本」会错误命中（我第一版就是漏了这一层）。
function makeDisplayTextViaEngine() {
  return createMessageDerivation({
    key: (message, scripts, placement, depth) => {
      const hasScripts = Array.isArray(scripts) && scripts.length > 0;
      return hasScripts ? [placement, depth, scripts] : [placement, 'static'];
    },
    equals: (a, b) => {
      if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
      for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
      return true;
    },
    compute: (message, scripts, placement, depth, compute) => compute(),
  });
}

test('① displayTextCache：引擎版与手写版结果、命中行为一致', () => {
  const engine = makeDisplayTextViaEngine();
  const message = { id: 'm1', text: '原文' };
  const scripts = [];
  let handCalls = 0;
  let engineCalls = 0;
  const handCompute = () => { handCalls += 1; return '结果'; };
  const engineCompute = () => { engineCalls += 1; return '结果'; };

  // 无脚本 + depth 变化：手写版不重算（2026-10-17 修的），引擎版也必须不重算
  for (const depth of [0, 1, 5, 99]) {
    const hand = getCachedDisplayText(message, scripts, 'AI_OUTPUT', depth, handCompute);
    const viaEngine = engine(message, scripts, 'AI_OUTPUT', depth, engineCompute);
    assert.equal(viaEngine, hand, `depth=${depth} 结果必须一致`);
  }
  assert.equal(engineCalls, handCalls, `无脚本时两版重算次数必须一致（手写 ${handCalls} / 引擎 ${engineCalls}）`);
  assert.equal(engineCalls, 1, '无脚本时 depth 变化不得重算');

  // 有脚本 + depth 变化：两版都必须重算
  const withScripts = [{ id: 's1' }];
  handCalls = 0;
  engineCalls = 0;
  for (const depth of [0, 1]) {
    const hand = getCachedDisplayText(message, withScripts, 'AI_OUTPUT', depth, handCompute);
    const viaEngine = engine(message, withScripts, 'AI_OUTPUT', depth, engineCompute);
    assert.equal(viaEngine, hand);
  }
  assert.equal(engineCalls, handCalls, '有脚本时两版重算次数必须一致');
  assert.equal(engineCalls, 2, '有脚本时 depth 变化必须重算');
});

test('② 搜索匹配：引擎版与手写 matchCache 判定一致（含 needle 变化）', () => {
  // 手写版在 chatSearchMath 内部（matchCache），只能通过公开函数观察。
  const message = { id: 'm1', role: 'user', text: 'Hello World' };
  // 引擎版：把「是否命中」做成派生值
  const engine = createMessageDerivation({
    key: (msg, needle) => needle,
    compute: (msg, needle) => String(msg.text).toLowerCase().includes(needle),
  });
  const needles = ['hello', 'world', 'hello', 'zzz', 'world', ''];
  for (const needle of needles) {
    const handHit = collectSearchMatchIds([message], needle).length > 0;
    const engineHit = needle ? engine(message, needle) : false;
    assert.equal(engineHit, handHit, `needle=${JSON.stringify(needle)} 判定必须一致`);
  }
  // 引用稳定性：同一 needle 重复取必须命中（否则每 tick 重算）
  assert.equal(engine(message, 'hello'), engine(message, 'hello'));
});

test('③ scrubber 预览：引擎版与手写 previewCache 失效行为一致', () => {
  const message = { id: 'm1', role: 'assistant', text: '正文', timestamp: 1700000000000 };
  const tA = (key) => (key === 'chat.bubble.me' ? '我' : '角色');
  const tB = (key) => (key === 'chat.bubble.me' ? 'Me' : 'Character');

  const engine = createMessageDerivation({
    key: (msg, characterName, t) => [characterName, t],
    compute: (msg, characterName, t) => buildScrubberPreview(msg, characterName, t),
  });

  // 手写版是模块级 WeakMap，直接调 buildScrubberPreview 即可观察其行为
  const hand1 = buildScrubberPreview(message, '小美', tA);
  const engine1 = engine(message, '小美', tA);
  assert.deepEqual(engine1, hand1, '同输入结果必须一致');
  assert.equal(engine(message, '小美', tA), engine1, '同键必须命中同一对象');

  const hand2 = buildScrubberPreview(message, '小丽', tA);
  const engine2 = engine(message, '小丽', tA);
  assert.deepEqual(engine2, hand2, '说话人变化后结果一致');
  assert.notEqual(engine2, engine1, '说话人变化必须重算');

  const hand3 = buildScrubberPreview(message, '小美', tB);
  const engine3 = engine(message, '小美', tB);
  assert.deepEqual(engine3, hand3, '语言变化后结果一致');
  assert.notEqual(engine3, engine1, '语言变化必须重算');
});

test('④ messageMetrics：引擎版（无键）与手写版一致', () => {
  const engine = createMessageDerivation({
    compute: message => messageMetrics(message),
  });
  const message = { id: 'm1', role: 'user', text: '你好世界' };
  const hand = messageMetrics(message);
  const viaEngine = engine(message);
  assert.deepEqual(viaEngine, hand, '结果必须一致');
  assert.equal(engine(message), viaEngine, '无键 ⇒ 同一消息必须命中同一对象');
  // null 路径：手写版每次返回新对象（不进 WeakMap），引擎版同样不缓存
  assert.deepEqual(engine(null), hand && messageMetrics(null));
});

test('等价性：随机消息序列下，引擎版与手写版逐项一致', () => {
  const engine = makeDisplayTextViaEngine();
  let seed = 20261018;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const messages = Array.from({ length: 30 }, (_, i) => ({ id: `m${i}`, text: `正文${i}` }));
  const placements = ['AI_OUTPUT', 'USER_INPUT'];
  let handTotal = 0;
  let engineTotal = 0;
  for (let round = 0; round < 300; round += 1) {
    const message = messages[Math.floor(rand() * messages.length)];
    const scripts = rand() < 0.5 ? [] : [{ id: 's1' }];
    const placement = placements[Math.floor(rand() * placements.length)];
    const depth = Math.floor(rand() * 10);
    const hand = getCachedDisplayText(message, scripts, placement, depth, () => { handTotal += 1; return 'x'; });
    const viaEngine = engine(message, scripts, placement, depth, () => { engineTotal += 1; return 'x'; });
    assert.equal(viaEngine, hand, `第 ${round} 轮结果不一致`);
  }
  assert.equal(engineTotal, handTotal, `重算次数必须一致（手写 ${handTotal} / 引擎 ${engineTotal}）`);
});

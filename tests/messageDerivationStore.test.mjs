// 消息派生引擎（结构 1 批次 1）：引擎本身的行为测试。
//
// 批次 1 只抽引擎、不迁移消费点，所以本文件的判据是「引擎能精确复现现有 4 处手写缓存
// 的语义」——包括每一处的失效键、命中时的引用稳定性、非对象入参的退化路径。
// 迁移（批次 2）之后，这些语义由消费点自己的测试继续守护。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createListDerivation,
  createMessageDerivation,
  prefixLength,
} from '../src/chat/messageDerivationStore.js';

test('createMessageDerivation：同一消息 + 同一键 ⇒ 复用同一结果引用', () => {
  let calls = 0;
  const derive = createMessageDerivation({
    key: (message, suffix) => suffix,
    compute: (message, suffix) => {
      calls += 1;
      return { text: `${message.text}${suffix}` };
    },
  });
  const message = { id: 'm1', text: '正文' };
  const first = derive(message, '-a');
  const second = derive(message, '-a');
  assert.equal(second, first, '命中必须返回同一对象（下游 memo 依赖引用稳定）');
  assert.equal(calls, 1);
});

test('createMessageDerivation：键变化必须重算（失效语义）', () => {
  let calls = 0;
  const derive = createMessageDerivation({
    key: (message, needle) => needle,
    compute: (message, needle) => {
      calls += 1;
      return `${message.text}:${needle}`;
    },
  });
  const message = { id: 'm1', text: '正文' };
  assert.equal(derive(message, 'a'), '正文:a');
  assert.equal(derive(message, 'a'), '正文:a');
  assert.equal(calls, 1);
  assert.equal(derive(message, 'b'), '正文:b', '键变了必须重算');
  assert.equal(calls, 2);
  // 切回旧键：**命中**而不是重算 —— 每条消息缓存多个键（与 displayTextCache 的
  // `entries` Map 语义一致）。这一点必须钉住：只留最后一个键会让「两个 placement /
  // 两个 needle 交替取」每次都白算（实测 300 轮里多算 56 次）。
  assert.equal(derive(message, 'a'), '正文:a', '切回旧键必须命中缓存');
  assert.equal(calls, 2, '切回旧键不得重算');
});

test('createMessageDerivation：键数量有界（FIFO），且不因超限而算错', () => {
  let calls = 0;
  const derive = createMessageDerivation({
    key: (message, n) => n,
    maxKeysPerMessage: 3,
    compute: (message, n) => {
      calls += 1;
      return n * 10;
    },
  });
  const message = { id: 'm1' };
  // 塞 3 个键（上限内）
  [1, 2, 3].forEach(n => assert.equal(derive(message, n), n * 10));
  assert.equal(calls, 3);
  // 再塞 1 个：最旧的键（1）被挤掉
  assert.equal(derive(message, 4), 40);
  assert.equal(calls, 4);
  // 1 已被挤掉 ⇒ 重算；2/3/4 仍在 ⇒ 命中
  assert.equal(derive(message, 1), 10);
  assert.equal(calls, 5, '被挤掉的键必须重算');
  assert.equal(derive(message, 3), 30);
  assert.equal(calls, 5, '未被挤掉的键仍命中');
  // 无论怎么挤，**结果必须永远正确**（有界只影响命中率，不影响正确性）
  for (const n of [1, 2, 3, 4, 1, 2]) {
    assert.equal(derive(message, n), n * 10, `n=${n} 结果必须始终正确`);
  }
});

test('createMessageDerivation：引用相等键（t 函数 / 脚本数组）语义正确', () => {
  // 复现 scrubber previewCache 与 displayTextCache 的失效条件：语言函数 t、脚本数组
  // 都是「同一引用才算没变」。默认 equals 是逐项 ===，对数组就是逐位比引用。
  let calls = 0;
  const tA = () => 'A';
  const tB = () => 'B';
  const derive = createMessageDerivation({
    key: (message, t, scripts) => [t, scripts],
    compute: () => {
      calls += 1;
      return calls;
    },
  });
  const message = { id: 'm1' };
  const scripts = [];
  derive(message, tA, scripts);
  derive(message, tA, scripts);
  assert.equal(calls, 1, '同引用必须命中');
  derive(message, tB, scripts);
  assert.equal(calls, 2, 't 换引用必须重算');
  derive(message, tA, []);
  assert.equal(calls, 3, '脚本数组换引用必须重算（即使内容相同）');
});

test('createMessageDerivation：无 key 时纯按引用缓存（messageMetrics 那种）', () => {
  let calls = 0;
  const derive = createMessageDerivation({
    compute: message => {
      calls += 1;
      return message.text.length;
    },
  });
  const message = { text: '四个字' };
  assert.equal(derive(message), 3);
  assert.equal(derive(message), 3);
  assert.equal(calls, 1, '无键 ⇒ 同一条消息永远命中');
  assert.equal(derive({ text: '新的' }), 2, '不同消息对象各自算');
  assert.equal(calls, 2);
});

test('createMessageDerivation：非对象入参不进缓存、每次现算（与手写实现一致）', () => {
  let calls = 0;
  const derive = createMessageDerivation({
    compute: message => {
      calls += 1;
      return message == null ? 4 : 0;
    },
  });
  assert.equal(derive(null), 4);
  assert.equal(derive(null), 4);
  assert.equal(calls, 2, 'null 不能进 WeakMap ⇒ 每次现算（手写实现也是这个行为）');
  assert.equal(derive(undefined), 4);
  assert.equal(calls, 3);
});

test('createMessageDerivation：自定义 equals（内容相等也算命中）', () => {
  let calls = 0;
  const derive = createMessageDerivation({
    key: (message, needle) => needle,
    equals: (a, b) => String(a).toLowerCase() === String(b).toLowerCase(),
    compute: () => {
      calls += 1;
      return calls;
    },
  });
  const message = { id: 'm1' };
  derive(message, 'Hello');
  derive(message, 'hello');
  assert.equal(calls, 1, '自定义 equals 认为等价 ⇒ 命中');
  derive(message, 'world');
  assert.equal(calls, 2);
});

test('createMessageDerivation：缺少 compute 直接抛错（早失败胜过静默返回 undefined）', () => {
  assert.throws(() => createMessageDerivation({}), TypeError);
  assert.throws(() => createMessageDerivation(), TypeError);
});

test('prefixLength：逐位引用比对，任一位置不等即截断', () => {
  const a = { id: 'a' };
  const b = { id: 'b' };
  const c = { id: 'c' };
  assert.equal(prefixLength([a, b], [a, b]), 2);
  assert.equal(prefixLength([a, b], [a, c]), 1);
  assert.equal(prefixLength([a, b], [c, b]), 0);
  assert.equal(prefixLength([a], [a, b]), 1, '新数组更长：前缀仍可复用');
  assert.equal(prefixLength([a, b], [a]), 1, '新数组更短：前缀仍可复用');
  assert.equal(prefixLength(null, [a]), 0);
  assert.equal(prefixLength([a], null), 0);
  assert.equal(prefixLength([], []), 0);
});

test('createListDerivation：同一数组引用直接返回上次结果', () => {
  let calls = 0;
  const derive = createListDerivation({
    compute: list => {
      calls += 1;
      return list.map(item => item.id);
    },
  });
  const list = [{ id: 'a' }];
  const first = derive(list);
  const second = derive(list);
  assert.equal(second, first, '同一引用必须返回同一结果对象');
  assert.equal(calls, 1);
});

test('createListDerivation：把可复用前缀长度交给 compute（增量重算的入口）', () => {
  const seen = [];
  const derive = createListDerivation({
    compute: (list, reused, previous) => {
      seen.push({ reused, hasPrevious: previous !== undefined });
      return list.length;
    },
  });
  const a = { id: 'a' };
  const b = { id: 'b' };
  derive([a, b]);
  derive([a, b, { id: 'c' }]);
  derive([a, { id: 'b2' }, { id: 'c' }]);
  derive([{ id: 'x' }]);
  assert.deepEqual(seen, [
    { reused: 0, hasPrevious: false },  // 首次：无可复用
    { reused: 2, hasPrevious: true },   // 尾部追加：前 2 条引用相同
    { reused: 1, hasPrevious: true },   // 中间变化：前缀只到第 1 条
    { reused: 0, hasPrevious: true },   // 全新数组：无前缀
  ]);
});

test('createListDerivation：非数组入参按空处理', () => {
  const derive = createListDerivation({ compute: list => list.length });
  assert.equal(derive(null), 0);
  assert.equal(derive(undefined), 0);
});

test('createListDerivation：缺少 compute 直接抛错', () => {
  assert.throws(() => createListDerivation({}), TypeError);
});

test('引擎不共享状态：两个实例互不影响', () => {
  let aCalls = 0;
  let bCalls = 0;
  const a = createMessageDerivation({ compute: () => { aCalls += 1; return 'a'; } });
  const b = createMessageDerivation({ compute: () => { bCalls += 1; return 'b'; } });
  const message = { id: 'shared' };
  assert.equal(a(message), 'a');
  assert.equal(b(message), 'b');
  assert.equal(a(message), 'a');
  assert.equal(b(message), 'b');
  assert.equal(aCalls, 1);
  assert.equal(bCalls, 1);
});

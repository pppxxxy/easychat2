import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  STEERING_MAX_ITEMS,
  STEERING_TEXT_MAX,
  createSteeringQueue,
} from '../src/agent/steering.js';

// 整合（Z/M/D 三线）：steering 队列的**容器**换成 Z 系采纳 #6 的类型化命令队列
// （runtime/commandQueue.js）。对外契约不变（push/drain/size），但容量、截断、FIFO
// 语义现在由共用队列保证。这几条断言钉住契约，防止后人再把容器换回自建数组。

test('空文本 / 空白 / null 一律拒绝（调用方不必再判）', () => {
  const queue = createSteeringQueue();
  assert.equal(queue.push(''), false);
  assert.equal(queue.push('   '), false);
  assert.equal(queue.push('\n\t '), false);
  assert.equal(queue.push(null), false);
  assert.equal(queue.push(undefined), false);
  assert.equal(queue.size, 0);
});

test('单条截断 500 字符（超出的是新任务，不是补充指令）', () => {
  const queue = createSteeringQueue();
  const long = 'x'.repeat(STEERING_TEXT_MAX + 200);
  assert.equal(queue.push(long), true);
  const [text] = queue.drain();
  assert.equal(text.length, STEERING_TEXT_MAX);
});

test('drain 按入队顺序（同级 FIFO）返回，并一次取空', () => {
  const queue = createSteeringQueue();
  ['先修数据层', '再动 UI', '最后补测试'].forEach(item => queue.push(item));
  assert.equal(queue.size, 3);
  assert.deepEqual(queue.drain(), ['先修数据层', '再动 UI', '最后补测试']);
  assert.equal(queue.size, 0, '取空——下一轮不会重复注入');
  assert.deepEqual(queue.drain(), [], '空队列 drain 返回空数组，不是 undefined');
});

test(`容量 ${STEERING_MAX_ITEMS}：满则挤掉最旧（新指令更相关）`, () => {
  const queue = createSteeringQueue();
  for (let i = 1; i <= STEERING_MAX_ITEMS; i += 1) queue.push(`指令${i}`);
  assert.equal(queue.size, STEERING_MAX_ITEMS);
  queue.push('指令6');
  assert.equal(queue.size, STEERING_MAX_ITEMS, '超出容量不增长');
  const drained = queue.drain();
  assert.equal(drained.includes('指令1'), false, '最旧的被挤掉');
  assert.deepEqual(drained, ['指令2', '指令3', '指令4', '指令5', '指令6']);
});

test('容器是共用的类型化命令队列（不是自建数组）', () => {
  const source = fs.readFileSync('src/agent/steering.js', 'utf8');
  assert.match(source, /import\s*\{\s*createCommandQueue\s*\}\s*from\s*'\.\/runtime\/commandQueue\.js'/);
  assert.match(source, /createCommandQueue\(\)/);
  // 自建数组的痕迹：旧实现是 `let items = []` + `items.push/shift`。
  assert.equal(/let\s+items\s*=/.test(source), false, '不得退回自建数组');
});

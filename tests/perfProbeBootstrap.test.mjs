// 卡顿取证：启动同步（startup/perfProbeBootstrap.js）与样本辅助的行为测试。
//
// 背景：探针的 enabled 是**内存态**，而开关是**持久化**的（storage/settings/perfProbe.js）。
// 真机上「开启 → 重启 → 复现卡顿」是常规流程，所以启动时必须把盘上的开关同步回来；
// 否则用户重启后探针回到默认关闭，复现完一条样本都没有，取证工具等于无效。
import test from 'node:test';
import assert from 'node:assert/strict';

import { bootstrapPerfProbe } from '../src/startup/perfProbeBootstrap.js';
import {
  clearPerfSamples,
  getPerfSamples,
  isPerfProbeEnabled,
  measureSync,
  __resetPerfProbeForTests,
  summarizePerfSamples,
} from '../src/logging/perfProbe.js';

test('启动同步：盘上开着就打开探针（端到端，用真实的 apply）', async () => {
  __resetPerfProbeForTests();
  const result = await bootstrapPerfProbe({ read: async () => true });
  assert.equal(result, true);
  assert.equal(isPerfProbeEnabled(), true, '盘上是开的，启动后探针必须真的在记');
});

test('启动同步：盘上关着就保持关闭（默认关闭是硬约束）', async () => {
  __resetPerfProbeForTests();
  const result = await bootstrapPerfProbe({ read: async () => false });
  assert.equal(result, false);
  assert.equal(isPerfProbeEnabled(), false);
});

test('启动同步：读抛错时不外泄异常，且明确把探针关掉', async () => {
  __resetPerfProbeForTests();
  const applied = [];
  const result = await bootstrapPerfProbe({
    read: async () => { throw new Error('storage down'); },
    apply: value => applied.push(value),
  });
  assert.equal(result, false, '读失败不得让启动看到 rejected promise');
  assert.deepEqual(applied, [false], '必须明确同步成关闭，而不是保持原状（状态要确定）');
});

test('启动同步：apply 自己抛错也不外泄（取证工具不得拖垮启动）', async () => {
  const result = await bootstrapPerfProbe({
    read: async () => true,
    apply: () => { throw new Error('apply exploded'); },
  });
  assert.equal(result, false);
});

test('启动同步：非布尔真值只认 true（1 / 字符串都不算开启）', async () => {
  const applied = [];
  const read = value => async () => value;
  for (const value of [1, 'true', {}, [], null, undefined, 0]) {
    applied.length = 0;
    await bootstrapPerfProbe({ read: read(value), apply: v => applied.push(v) });
    assert.deepEqual(applied, [false], `${JSON.stringify(value)} 不得被当成开启`);
  }
});

test('启动同步：默认路径在原生存储不可用时返回 false 且不抛（Node 即是这个场景）', async () => {
  // 这个用例刻意**不注入** read：走真实的 storage 读取。测试环境没有 RN 原生模块，
  // 正好等价于真机上「存储层坏了」——启动绝不能因此带上异常。
  __resetPerfProbeForTests();
  const result = await bootstrapPerfProbe();
  assert.equal(result, false);
  assert.equal(isPerfProbeEnabled(), false);
});

test('样本辅助：clearPerfSamples 清空并返回清掉的条数，且不影响探针开关', async () => {
  __resetPerfProbeForTests();
  const { setPerfProbeEnabled } = await import('../src/logging/perfProbe.js');
  setPerfProbeEnabled(true);
  // 阈值 -1 ⇒ 任何耗时都算超标，稳定产出样本（不依赖真实耗时分布）。
  measureSync('t', () => 1, -1);
  measureSync('t', () => 1, -1);
  assert.equal(getPerfSamples().length, 2);
  assert.equal(clearPerfSamples(), 2, '返回值是清掉的条数');
  assert.deepEqual(getPerfSamples(), [], '样本必须真的清空');
  assert.equal(isPerfProbeEnabled(), true, '清样本不得顺手关掉开关');
  __resetPerfProbeForTests();
});

test('样本辅助：summarizePerfSamples 取条数与最慢的一条', () => {
  assert.deepEqual(summarizePerfSamples([]), { count: 0, worst: null });
  assert.deepEqual(
    summarizePerfSamples([
      { label: 'a', ms: 12 },
      { label: 'b', ms: 480 },
      { label: 'c', ms: 90 },
    ]),
    { count: 3, worst: { label: 'b', ms: 480 } }
  );
  // 脏数据不得让面板崩：非对象项与缺 ms 的项直接忽略。
  assert.deepEqual(summarizePerfSamples([null, 'x', { label: 'no-ms' }, { label: 'ok', ms: 5 }]), {
    count: 1,
    worst: { label: 'ok', ms: 5 },
  });
  // 非数组入参按空处理，不抛。
  assert.deepEqual(summarizePerfSamples(null), { count: 0, worst: null });
});

test('样本辅助：默认参数读的是**当前**样本（面板直接调用即最新）', async () => {
  __resetPerfProbeForTests();
  const { setPerfProbeEnabled } = await import('../src/logging/perfProbe.js');
  setPerfProbeEnabled(true);
  measureSync('x', () => 1, -1);
  measureSync('y', () => 1, -1);
  const summary = summarizePerfSamples();
  assert.equal(summary.count, 2, '不传参时必须读实时样本');
  __resetPerfProbeForTests();
});

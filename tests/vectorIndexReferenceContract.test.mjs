// 引用契约：indexMessages 在**内容没变时**必须返回同一个数组引用。
//
// 真机证据（2026-10-20 用户日志，我上一批加的守卫抓到的）：
//   storage: 向量索引返回了新引用但内容未变（上游应原样返回当前数组…）
//   context: card-mvgqns3h-ogdu59：updater 返回了新引用但内容未变（应原样返回 current）
//
// 为什么这条契约重要（vector.js updateVectorIndex 有完整说明）：
//   next !== status.index ⇒ 走 saveVectorIndexInternal ⇒ normalize + JSON.stringify
//   + 整键写盘，全是 O(条数×维度)。实测 1024 维 1000 条 ≈ 19.8MB、stringify 145ms。
//   内容没变却返回新引用 = 每次落盘白付一遍，用户看到的是「卡」。
//
// 本次定位到的触发路径：
//   indexMessages 的 catch 分支 `return [...current, ...added.map(...)]`
//   —— embedTexts 失败（网络/超时）且**没有新消息**时，added 为空 ⇒ 等价于 [...current]，
//   新引用 + 内容完全相同。每次失败重试都白写一次盘。
import test from 'node:test';
import assert from 'node:assert/strict';

import { chunkMessages, indexMessages } from '../src/vectorMemory/index.js';

const CONFIG = {
  enabled: true,
  provider: 'openai-embeddings',
  baseUrl: 'https://example.invalid/v1',
  apiKey: 'k',
  model: 'text-embedding-3-small',
  maxChars: 400,
  batchSize: 20,
};

// 消息（chunkMessages 的输入形态）
function msg(id, text = `text-${id}`) {
  return { id, role: 'user', text };
}

// 已索引条目：**用 chunkMessages 真实产出来构造**，否则字段（sessionId / text 前缀 /
// id 形态）对不上，"已存在" 判定永远失败，测试就变成在测「全部新增」。
// 第一版手写 entry 就是这么错的。
function entryFrom(m, { vector = [0.1, 0.2], signature = 'sig-A' } = {}) {
  const [segment] = chunkMessages([m], CONFIG);
  return { ...segment, dim: vector.length, vector, signature };
}

function entry(msgId, options) {
  return entryFrom(msg(msgId), options);
}

test('内容没变时必须返回同一引用（不触发写盘）', async () => {
  const existing = [entry('m1')];
  const result = await indexMessages({
    messages: [msg('m1')],
    config: CONFIG,
    existing,
  });
  assert.equal(result, existing, 'pending 为空时必须原样返回 current（同一引用）');
});

test('嵌入失败且没有新消息时，必须返回同一引用（曾经返回 [...current] 新数组）', async () => {
  // 构造：现有条目 signature 与当前签名不一致 ⇒ 进入 pending ⇒ 尝试 embedTexts。
  // baseUrl 非法 ⇒ embedTexts 必然失败 ⇒ 走 catch 分支。
  // 关键：没有新消息（added 为空），失败后什么都没变，不该返回新引用。
  const existing = [entry('m1', { signature: 'old-signature' })];
  const result = await indexMessages({
    messages: [msg('m1')],
    config: CONFIG,
    existing,
  });
  assert.equal(
    result,
    existing,
    '嵌入失败且无新增时，必须返回同一引用——否则每次失败都白写一次盘'
  );
});

test('有新增分段时，即使嵌入失败也要返回新数组（新分段必须落盘）', async () => {
  const existing = [entry('m1')];
  const result = await indexMessages({
    messages: [msg('m1'), msg('m2')],
    config: CONFIG,
    existing,
  });
  assert.notEqual(result, existing, '有新增就必须返回新数组，否则新分段会丢');
  assert.equal(result.length, 2, `新分段要进结果（实际 ${result.length}）`);
  const added = result.find(item => item.messageId === 'm2');
  assert.ok(added, 'm2 必须出现在结果里');
  assert.deepEqual(added.vector, [], '嵌入失败时新分段以空向量占位（下次再嵌）');
});

test('开关关闭时返回同一引用（原有行为，不得回退）', async () => {
  const existing = [entry('m1')];
  const result = await indexMessages({
    messages: [msg('m1')],
    config: { ...CONFIG, enabled: false },
    existing,
  });
  assert.equal(result, existing, '向量记忆关闭时必须原样返回');
});

test('从空到有内容时必须返回新数组', async () => {
  const existing = [];
  const result = await indexMessages({
    messages: [msg('m1')],
    config: CONFIG,
    existing,
  });
  assert.notEqual(result, existing, '从空到有内容 ⇒ 必须返回新数组');
  assert.equal(result.length, 1);
});

test('接线：indexMessages 源码里不得再有裸 `[...current, ...added...]` 的失败回退', async () => {
  // 这条防回归：catch 分支若又写成无条件 [...current, ...added.map(...)]，
  // 「没有新消息时」就会退化成「新引用 + 内容不变」。
  // ESM 里没有 require，用 fs 的默认导入（本文件顶部没导 fs，这里动态 import）。
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../src/vectorMemory/index.js', import.meta.url), 'utf8');
  assert.ok(
    /if \(added\.length === 0\) return current;/.test(source),
    'catch 分支必须先判「没有新增 ⇒ 原样返回 current」'
  );
  assert.ok(
    /sameIndexContent\(next, current\) \? current : next/.test(source),
    '成功分支必须用内容比较决定是否返回新引用'
  );
});

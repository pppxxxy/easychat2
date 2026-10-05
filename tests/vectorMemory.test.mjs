import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const sourcePath = path.resolve('src/vectorMemory/index.js');
const transformed = babel.transformSync(fs.readFileSync(sourcePath, 'utf8'), {
  babelrc: false,
  configFile: false,
  filename: sourcePath,
  presets: [[require.resolve('@babel/preset-env'), { targets: { node: 'current' }, modules: 'commonjs' }]],
}).code;
const filename = path.resolve('src/vectorMemory/index.js');
const runtimeModule = new Module(filename);
runtimeModule.filename = filename;
runtimeModule.paths = Module._nodeModulePaths(path.dirname(filename));
runtimeModule._compile(transformed, filename);
const {
  buildMemoryContext,
  chunkMessages,
  cosineSimilarity,
  indexMessages,
  selectVectorHits,
  vectorSignature,
} = runtimeModule.exports;

const message = {
  id: 'shared-message',
  role: 'assistant',
  text: '同一段角色记忆',
  timestamp: 1,
};

test('相同消息 id 的不同会话片段可以同时建立索引', async () => {
  const first = await indexMessages({
    messages: [message],
    config: { enabled: true },
    sessionId: 'session-a',
    existing: [],
  });
  const second = await indexMessages({
    messages: [message],
    config: { enabled: true },
    sessionId: 'session-b',
    existing: first,
  });
  assert.equal(second.length, 2);
  assert.deepEqual(second.map(item => item.sessionId), ['session-a', 'session-b']);
});

test('不同维度的向量不会被截断后当成高相似度', () => {
  assert.equal(cosineSimilarity([1, 0], [1, 0, 999]), 0);
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
});

test('低于相关性门槛的向量命中被过滤', () => {
  const signature = vectorSignature({ enabled: true, model: 'm', maxChars: 400 });
  const items = [
    { id: 'strong', signature, vector: [1, 0] },
    { id: 'weak', signature, vector: [0.1, 1] },
    { id: 'stale', signature: 'other', vector: [1, 0] },
  ];
  const hits = selectVectorHits(items, [1, 0], { signature, topK: 5, minScore: 0.5 });
  assert.deepEqual(hits.map(item => item.id), ['strong']);
  // minScore=0 时保留弱命中，但仍排除指纹不匹配项
  const loose = selectVectorHits(items, [1, 0], { signature, topK: 5, minScore: 0 });
  assert.deepEqual(loose.map(item => item.id), ['strong', 'weak']);
});

test('记忆上下文总长度不会超过配置上限', () => {
  const context = buildMemoryContext([{ text: 'a'.repeat(2000) }], { maxTotalChars: 1200 });
  assert.ok(context.length <= 1210);
  assert.ok(context.endsWith('a'.repeat(1200)));
});

test('索引片段会带上向量配置指纹', async () => {
  const items = await indexMessages({
    messages: [message],
    config: { enabled: true, model: 'embed-a', maxChars: 400 },
    sessionId: 'session-sig',
    existing: [],
  });
  assert.equal(items[0].signature, vectorSignature({ enabled: true, model: 'embed-a', maxChars: 400 }));
  assert.notEqual(
    vectorSignature({ enabled: true, model: 'embed-a', maxChars: 400 }),
    vectorSignature({ enabled: true, model: 'embed-b', maxChars: 400 })
  );
  assert.notEqual(
    vectorSignature({ enabled: true, model: 'embed-a', maxChars: 400 }),
    vectorSignature({ enabled: true, model: 'embed-a', maxChars: 800 })
  );
});

test('同一会话同一消息不会重复建立片段', async () => {
  const first = await indexMessages({
    messages: [message],
    config: { enabled: true },
    sessionId: 'session-a',
    existing: [],
  });
  const second = await indexMessages({
    messages: [message],
    config: { enabled: true },
    sessionId: 'session-a',
    existing: first,
  });
  assert.deepEqual(second, first);
  assert.equal(chunkMessages([message], { sessionId: 'session-a' })[0].id, 'shared-message-0');
});

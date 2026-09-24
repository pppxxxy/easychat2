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
const filename = path.resolve('src/vectorMemory/index.test-runtime.cjs');
const runtimeModule = new Module(filename);
runtimeModule.filename = filename;
runtimeModule.paths = Module._nodeModulePaths(path.dirname(filename));
runtimeModule._compile(transformed, filename);
const { chunkMessages, indexMessages } = runtimeModule.exports;

const message = {
  id: 'shared-message',
  role: 'assistant',
  text: '同一段角色记忆',
  timestamp: 1,
};

test('相同消息 id 的不同会话片段可以同时建立索引', async () => {
  const first = await indexMessages({
    messages: [message],
    config: { enabled: false },
    sessionId: 'session-a',
    existing: [],
  });
  const second = await indexMessages({
    messages: [message],
    config: { enabled: false },
    sessionId: 'session-b',
    existing: first,
  });
  assert.equal(second.length, 2);
  assert.deepEqual(second.map(item => item.sessionId), ['session-a', 'session-b']);
});

test('同一会话同一消息不会重复建立片段', async () => {
  const first = await indexMessages({
    messages: [message],
    config: { enabled: false },
    sessionId: 'session-a',
    existing: [],
  });
  const second = await indexMessages({
    messages: [message],
    config: { enabled: false },
    sessionId: 'session-a',
    existing: first,
  });
  assert.deepEqual(second, first);
  assert.equal(chunkMessages([message], { sessionId: 'session-a' })[0].id, 'shared-message-0');
});

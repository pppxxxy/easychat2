import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const sourcePath = path.resolve('src/api.js');
const transformed = babel.transformSync(fs.readFileSync(sourcePath, 'utf8'), {
  babelrc: false,
  configFile: false,
  filename: sourcePath,
  presets: [[require.resolve('@babel/preset-env'), { targets: { node: 'current' }, modules: 'commonjs' }]],
}).code;

const storageMock = {
  getActiveApiConfig: async () => ({}),
  getActiveModel: config => String(config.activeModel || config.model || ''),
  getSamplingSettings: async () => ({}),
  getThinkingSettings: async () => ({}),
};
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === './storage' || request.endsWith('/storage')) return storageMock;
  if (request === './secrets' || request.endsWith('/secrets')) return { registerSecretValues: () => {} };
  return originalLoad.call(this, request, parent, isMain);
};
const filename = path.resolve('src/api.test-runtime.cjs');
const runtimeModule = new Module(filename);
runtimeModule.filename = filename;
runtimeModule.paths = Module._nodeModulePaths(path.dirname(filename));
runtimeModule._compile(transformed, filename);
Module._load = originalLoad;
const { getConfigFingerprint } = runtimeModule.exports;

test('API 配置指纹覆盖地址、模型和密钥变化', () => {
  const base = {
    id: 'config-1',
    baseUrl: 'https://example.com/v1',
    activeModel: 'model-a',
    apiKey: 'key-a',
  };
  const original = getConfigFingerprint(base);
  assert.equal(original, getConfigFingerprint({ ...base }));
  assert.notEqual(original, getConfigFingerprint({ ...base, activeModel: 'model-b' }));
  assert.notEqual(original, getConfigFingerprint({ ...base, apiKey: 'key-b' }));
  assert.notEqual(original, getConfigFingerprint({ ...base, baseUrl: 'https://other.example/v1' }));
  assert.equal(original.includes('key-a'), false);
});

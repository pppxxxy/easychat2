import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const sourcePath = path.resolve('src/imageGen/index.js');
const transformed = babel.transformSync(fs.readFileSync(sourcePath, 'utf8'), {
  babelrc: false,
  configFile: false,
  filename: sourcePath,
  presets: [[require.resolve('@babel/preset-env'), { targets: { node: 'current' }, modules: 'commonjs' }]],
}).code;
const filename = path.resolve('src/imageGen/index.test-runtime.cjs');
const runtimeModule = new Module(filename);
runtimeModule.filename = filename;
runtimeModule.paths = Module._nodeModulePaths(path.dirname(filename));
runtimeModule._compile(transformed, filename);
const { generateImage } = runtimeModule.exports;

const provider = {
  id: 'test',
  baseUrl: 'https://example.com/v1',
  t2i: { template: { prompt: '{{prompt}}' }, endpoint: 'https://example.com/image' },
  response: { path: 'data', urlField: 'url' },
  timeoutMs: 1000,
  retries: 1,
};

class FakeXHR {
  static instances = [];
  static status = 200;
  static response = { data: [{ url: 'https://example.com/result.png' }] };

  constructor() {
    this.headers = {};
    this.aborted = false;
    FakeXHR.instances.push(this);
  }

  open(method, url) {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(key, value) {
    this.headers[key] = value;
  }

  send() {
    if (FakeXHR.status === 0) return;
    this.status = FakeXHR.status;
    this.responseText = JSON.stringify(FakeXHR.response);
    this.onload();
  }

  abort() {
    this.aborted = true;
    if (this.onabort) this.onabort();
  }
}

test('生图默认不自动重试付费请求', async () => {
  FakeXHR.instances = [];
  FakeXHR.status = 500;
  globalThis.XMLHttpRequest = FakeXHR;
  await assert.rejects(
    () => generateImage({ provider, config: { apiKey: 'key' }, prompt: '猫' }),
    /HTTP 500/
  );
  assert.equal(FakeXHR.instances.length, 1);
});

test('生图请求响应取消信号', async () => {
  FakeXHR.instances = [];
  FakeXHR.status = 0;
  globalThis.XMLHttpRequest = FakeXHR;
  const controller = new AbortController();
  const pending = generateImage({
    provider,
    config: { apiKey: 'key' },
    prompt: '猫',
    signal: controller.signal,
  });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, error => error && error.name === 'AbortError');
  assert.equal(FakeXHR.instances[0].aborted, true);
});

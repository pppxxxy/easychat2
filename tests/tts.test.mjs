import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const sourcePath = path.resolve('src/tts/index.js');
const transformed = babel.transformSync(fs.readFileSync(sourcePath, 'utf8'), {
  babelrc: false,
  configFile: false,
  filename: sourcePath,
  presets: [[require.resolve('@babel/preset-env'), { targets: { node: 'current' }, modules: 'commonjs' }]],
}).code;

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === './providers') {
    return {
      TTS_MAX_CHARS: 800,
      getTtsProvider: () => null,
    };
  }
  if (request === '../secrets') {
    return { registerSecretValues: () => {} };
  }
  if (request === 'expo-av') {
    return {
      Audio: {
        Sound: {
          createAsync: async () => ({
            sound: {
              setOnPlaybackStatusUpdate() {},
              async playAsync() {},
              async stopAsync() {},
              async unloadAsync() {},
            },
          }),
        },
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

function loadTts() {
  const filename = path.resolve('src/tts/index.test-runtime.cjs');
  const runtimeModule = new Module(filename);
  runtimeModule.filename = filename;
  runtimeModule.paths = Module._nodeModulePaths(path.dirname(filename));
  runtimeModule._compile(transformed, filename);
  return runtimeModule.exports;
}

test('并发 speak 只保留最后一次播报请求', async () => {
  const originalXHR = globalThis.XMLHttpRequest;
  class DeferredXHR {
    static instances = [];
    constructor() {
      this.aborted = false;
      DeferredXHR.instances.push(this);
    }
    open() {}
    setRequestHeader() {}
    send() {
      this.status = 200;
      this.response = Uint8Array.from([1, 2, 3]).buffer;
    }
    respond() {
      if (this.onload) this.onload();
    }
    abort() {
      this.aborted = true;
      if (this.onabort) this.onabort();
    }
  }
  globalThis.XMLHttpRequest = DeferredXHR;
  try {
    const { speak } = loadTts();
    const provider = {
      engine: 'remote',
      method: 'POST',
      baseUrl: 'https://example.test/tts',
      textField: 'text',
      response: { mode: 'binary' },
    };
    const config = { apiKey: 'key-12345678' };
    const first = speak({ provider, config, text: 'first' });
    const second = speak({ provider, config, text: 'second' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(DeferredXHR.instances.length, 1);
    DeferredXHR.instances[0].respond();
    await Promise.all([first, second]);
  } finally {
    globalThis.XMLHttpRequest = originalXHR;
  }
});

test('二进制 TTS 响应按 ArrayBuffer 转为 Base64', async () => {
  const originalXHR = globalThis.XMLHttpRequest;
  class BinaryXHR {
    open() {}
    setRequestHeader() {}
    send() {
      this.status = 200;
      this.response = Uint8Array.from([0x00, 0xff, 0x10, 0x80]).buffer;
      queueMicrotask(() => this.onload && this.onload());
    }
    abort() {}
  }
  globalThis.XMLHttpRequest = BinaryXHR;
  try {
    const { synthesize } = loadTts();
    const result = await synthesize({
      provider: {
        engine: 'remote',
        method: 'POST',
        baseUrl: 'https://example.test/tts',
        textField: 'text',
        response: { mode: 'binary' },
      },
      config: { apiKey: 'key-12345678' },
      text: '你好',
    });
    assert.equal(result.base64, 'AP8QgA==');
  } finally {
    globalThis.XMLHttpRequest = originalXHR;
  }
});
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
test('MiniMax 请求同时携带 GroupId 查询参数与 Bearer 密钥头', () => {
  const tts = loadTts();
  const request = tts.buildTtsRequest({
    id: 'minimax',
    method: 'POST',
    baseUrl: 'https://api.minimax.chat/v1/t2a_v2',
    auth: { type: 'query', keyName: 'GroupId', bearer: true },
    textField: 'text',
  }, { appId: 'group-1', apiKey: 'key-1' }, '你好');
  assert.match(request.url, /GroupId=group-1$/);
  assert.equal(request.headers.Authorization, 'Bearer key-1');
  assert.equal(JSON.parse(request.body).text, '你好');
});

test('阿里云请求把 AppKey 拼进 appkey 查询参数', () => {
  const tts = loadTts();
  const request = tts.buildTtsRequest({
    id: 'aliyun',
    method: 'POST',
    baseUrl: 'https://nls-gateway-cn-shanghai.aliyuncs.com/stream/v1/tts',
    auth: { type: 'header', keyName: 'Authorization', prefix: 'Bearer ' },
    queryFields: [{ name: 'appkey', from: 'appId' }],
    textField: 'text',
  }, { apiKey: 'token-1', appId: 'app-1' }, '你好');
  assert.equal(request.headers.Authorization, 'Bearer token-1');
  assert.match(request.url, /appkey=app-1$/);
});

test('queryFields 未填值时不拼空参数', () => {
  const tts = loadTts();
  const request = tts.buildTtsRequest({
    id: 'aliyun',
    method: 'POST',
    baseUrl: 'https://nls-gateway-cn-shanghai.aliyuncs.com/stream/v1/tts',
    auth: { type: 'header', keyName: 'Authorization', prefix: 'Bearer ' },
    queryFields: [{ name: 'appkey', from: 'appId' }],
    textField: 'text',
  }, { apiKey: 'token-1' }, '你好');
  assert.equal(request.url.includes('appkey='), false);
});

test('腾讯云签名未实现时明确失败且绝不发送 SecretKey', () => {
  const tts = loadTts();
  assert.throws(() => tts.buildTtsRequest({
    id: 'tencent-cloud',
    method: 'POST',
    baseUrl: 'https://tts.tencentcloudapi.com',
    auth: { type: 'header', keyName: 'Authorization' },
    signer: 'tencent',
    textField: 'Text',
  }, { apiKey: 'secret-key' }, '你好'), /尚未实现/);
});

test('wss 语音地址明确提示当前引擎不支持', () => {
  const tts = loadTts();
  assert.throws(() => tts.buildTtsRequest({
    id: 'iflytek-spark',
    method: 'POST',
    baseUrl: 'wss://tts-api.xfyun.cn/v2/tts',
    signer: 'iflytek',
    textField: 'text',
  }, {}, '你好'), /WebSocket/);
});

test('TTS 声明表的小米 MiMo 配置与官方端点一致', async () => {
  // 直接导入真实 providers.js（纯数据模块），防止域名/鉴权回退到错误版本
  const { getTtsProvider } = await import('../src/tts/providers.js');
  const mimo = getTtsProvider('xiaomi-mimo');
  assert.equal(mimo.baseUrl, 'https://api.xiaomimimo.com/v1/audio/speech');
  assert.equal(mimo.auth.keyName, 'api-key');
  assert.equal(mimo.auth.prefix, undefined);
  assert.equal(mimo.response.mode, 'base64');
  assert.equal(mimo.response.path, 'message.audio.data');
  const minimax = getTtsProvider('minimax');
  assert.equal(minimax.auth.bearer, true);
  const aliyun = getTtsProvider('aliyun');
  assert.deepEqual(aliyun.queryFields, [{ name: 'appkey', from: 'appId' }]);
});

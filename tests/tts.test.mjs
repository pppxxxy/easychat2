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

test('TTS 声明表与官方端点逐家一致', async () => {
  // 直接导入真实 providers.js（纯数据模块），防止域名/鉴权回退到错误版本
  const { getTtsProvider } = await import('../src/tts/providers.js');
  // 小米：仅有 /v1/chat/completions（实测 405=存在），audio/speech 实测 404
  const mimo = getTtsProvider('xiaomi-mimo');
  assert.equal(mimo.baseUrl, 'https://api.xiaomimimo.com/v1/chat/completions');
  assert.equal(mimo.requestMode, 'chat');
  assert.equal(mimo.auth.keyName, 'api-key');
  assert.equal(mimo.response.mode, 'base64');
  assert.equal(mimo.response.path, 'choices.0.message.audio.data');
  // MiniMax：现行域名 + data.audio 是 hex（官方默认 output_format=hex）
  const minimax = getTtsProvider('minimax');
  assert.equal(minimax.baseUrl, 'https://api.minimaxi.com/v1/t2a_v2');
  assert.equal(minimax.auth.bearer, true);
  assert.equal(minimax.response.mode, 'hex');
  assert.equal(minimax.response.path, 'data.audio');
  // 百度：tok 参数名 + 表单编码 + 必填默认值 + 60 字上限
  const baidu = getTtsProvider('baidu');
  assert.equal(baidu.auth.keyName, 'tok');
  assert.equal(baidu.requestFormat, 'form');
  assert.equal(baidu.maxChars, 60);
  assert.deepEqual(baidu.payloadDefaults, { ctp: 1, lan: 'zh', cuid: 'easychat2', aue: 3 });
  // 火山：官方嵌套结构 + encoding 默认 mp3
  const volcano = getTtsProvider('volcano');
  assert.equal(volcano.textField, 'request.text');
  assert.equal(volcano.voiceField, 'audio.voice_type');
  assert.equal(volcano.speedField, 'audio.speed_ratio');
  assert.equal(volcano.formatField, 'audio.encoding');
  assert.deepEqual(volcano.payloadDefaults, { audio: { encoding: 'mp3' } });
  // 阿里云：X-NLS-Token 头（非 Bearer）+ appkey 查询参数 + format 默认 mp3
  const aliyun = getTtsProvider('aliyun');
  assert.equal(aliyun.auth.keyName, 'X-NLS-Token');
  assert.equal(aliyun.auth.prefix, undefined);
  assert.deepEqual(aliyun.queryFields, [{ name: 'appkey', from: 'appId' }]);
  assert.deepEqual(aliyun.payloadDefaults, { format: 'mp3' });
  // 讯飞/腾讯云：声明为暂不支持
  assert.equal(getTtsProvider('iflytek-spark').unsupported, true);
  assert.equal(getTtsProvider('tencent-cloud').unsupported, true);
});

test('chat 模式把合成文本作为 assistant 消息发送', () => {
  const tts = loadTts();
  const request = tts.buildTtsRequest({
    id: 'xiaomi-mimo',
    method: 'POST',
    baseUrl: 'https://api.xiaomimimo.com/v1/chat/completions',
    requestMode: 'chat',
    auth: { type: 'header', keyName: 'api-key' },
    response: { mode: 'base64', path: 'choices.0.message.audio.data' },
    fields: [
      { key: 'baseUrl', label: '接口地址' },
      { key: 'apiKey', label: 'API Key', secret: true },
      { key: 'model', label: '模型名' },
    ],
  }, { apiKey: 'mimo-key', model: 'MiMo-V2.5-TTS' }, '你好，世界');
  assert.equal(request.headers['api-key'], 'mimo-key');
  const body = JSON.parse(request.body);
  assert.equal(body.model, 'MiMo-V2.5-TTS');
  assert.deepEqual(body.messages, [{ role: 'assistant', content: '你好，世界' }]);
});

test('hex 响应按 hex 解码为 base64 音频', async () => {
  const originalXHR = globalThis.XMLHttpRequest;
  const hexAudio = Buffer.from('fake-audio-bytes').toString('hex');
  class HexXHR {
    constructor() { this.status = 200; this.responseText = JSON.stringify({ choices: [], data: { audio: hexAudio } }); }
    open() {}
    setRequestHeader() {}
    send() { queueMicrotask(() => this.onload && this.onload()); }
    abort() {}
  }
  globalThis.XMLHttpRequest = HexXHR;
  try {
    const { synthesize } = loadTts();
    const result = await synthesize({
      provider: {
        id: 'minimax', method: 'POST',
        baseUrl: 'https://api.minimaxi.com/v1/t2a_v2',
        auth: { type: 'query', keyName: 'GroupId', bearer: true },
        textField: 'text',
        response: { mode: 'hex', path: 'data.audio' },
        fields: [
          { key: 'apiKey', label: 'API Key', secret: true },
          { key: 'appId', label: 'GroupId' },
          { key: 'model', label: '模型名' },
        ],
        timeoutMs: 5000,
      },
      config: { apiKey: 'key-1', appId: 'group-1', model: 'speech-2.8-hd' },
      text: '你好',
    });
    assert.equal(result.base64, Buffer.from('fake-audio-bytes').toString('base64'));
  } finally {
    globalThis.XMLHttpRequest = originalXHR;
  }
});

test('表单模式按 urlencoded 提交且令牌参数名为 tok', () => {
  const tts = loadTts();
  const request = tts.buildTtsRequest({
    id: 'baidu',
    method: 'POST',
    baseUrl: 'https://tsn.baidu.com/text2audio',
    requestFormat: 'form',
    auth: { type: 'token', keyName: 'tok' },
    payloadDefaults: { ctp: 1, lan: 'zh', cuid: 'easychat2', aue: 3 },
    textField: 'tex',
    voiceField: 'per',
    response: { mode: 'binary' },
    fields: [
      { key: 'apiKey', label: 'API Key', secret: true },
      { key: 'appSecretKey', label: 'Secret Key', secret: true },
    ],
  }, { apiKey: 'k', appSecretKey: 's', voice: '0' }, '你好', 'token-123');
  assert.match(request.url, /[?&]tok=token-123$/);
  assert.equal(request.headers['Content-Type'], 'application/x-www-form-urlencoded');
  const params = new URLSearchParams(request.body);
  assert.equal(params.get('tex'), '你好');
  assert.equal(params.get('ctp'), '1');
  assert.equal(params.get('lan'), 'zh');
  assert.equal(params.get('cuid'), 'easychat2');
  assert.equal(params.get('aue'), '3');
  assert.equal(params.get('per'), '0');
});

test('火山签名补齐官方必填并写进嵌套结构', () => {
  const tts = loadTts();
  const request = tts.buildTtsRequest({
    id: 'volcano',
    method: 'POST',
    baseUrl: 'https://openspeech.bytedance.com/api/v1/tts',
    auth: { type: 'header', keyName: 'Authorization', prefix: 'Bearer;' },
    signer: 'volcano',
    textField: 'request.text',
    voiceField: 'audio.voice_type',
    speedField: 'audio.speed_ratio',
    formatField: 'audio.encoding',
    payloadDefaults: { audio: { encoding: 'mp3' } },
    response: { mode: 'base64', path: 'data' },
    fields: [
      { key: 'appId', label: 'AppID' },
      { key: 'apiKey', label: 'Access Token', secret: true },
    ],
  }, { appId: 'app-1', apiKey: 'tok-1', voice: 'BV001_streaming', speed: '1.0' }, '你好');
  const body = JSON.parse(request.body);
  assert.equal(body.request.text, '你好');
  assert.equal(body.request.operation, 'query');
  assert.equal(body.request.text_type, 'plain');
  assert.ok(body.request.reqid);
  assert.equal(body.app.cluster, 'volcano_tts');
  assert.equal(body.app.appid, 'app-1');
  assert.equal(body.app.token, 'tok-1');
  assert.equal(body.user.uid, 'easychat2');
  assert.equal(body.audio.voice_type, 'BV001_streaming');
  assert.equal(body.audio.speed_ratio, 1.0);
  assert.equal(body.audio.encoding, 'mp3');
});

test('阿里云用 X-NLS-Token 头并默认请求 mp3', () => {
  const tts = loadTts();
  const request = tts.buildTtsRequest({
    id: 'aliyun',
    method: 'POST',
    baseUrl: 'https://nls-gateway-cn-shanghai.aliyuncs.com/stream/v1/tts',
    auth: { type: 'header', keyName: 'X-NLS-Token' },
    queryFields: [{ name: 'appkey', from: 'appId' }],
    textField: 'text',
    payloadDefaults: { format: 'mp3' },
    response: { mode: 'binary' },
    fields: [
      { key: 'apiKey', label: '访问令牌', secret: true },
      { key: 'appId', label: 'AppKey' },
    ],
  }, { apiKey: 'nls-token', appId: 'appkey-1' }, '你好');
  assert.equal(request.headers['X-NLS-Token'], 'nls-token');
  assert.equal(request.headers.Authorization, undefined);
  assert.match(request.url, /[?&]appkey=appkey-1$/);
  assert.equal(JSON.parse(request.body).format, 'mp3');
});

test('model 标必填后缺失在本地明确报错', () => {
  const tts = loadTts();
  assert.throws(() => tts.buildTtsRequest({
    id: 'siliconflow',
    method: 'POST',
    baseUrl: 'https://api.siliconflow.cn/v1/audio/speech',
    auth: { type: 'header', keyName: 'Authorization', prefix: 'Bearer ' },
    textField: 'input',
    response: { mode: 'binary' },
    fields: [
      { key: 'baseUrl', label: '接口地址' },
      { key: 'apiKey', label: 'API Key', secret: true },
      { key: 'model', label: '模型名' },
    ],
  }, { apiKey: 'k' }, '你好'), /请先填写模型名/);
});

test('令牌获取失败不再被吞掉', async () => {
  const originalXHR = globalThis.XMLHttpRequest;
  class FailTokenXHR {
    constructor() { this.status = 400; this.responseText = JSON.stringify({ error: 'invalid_client' }); }
    open() {}
    setRequestHeader() {}
    send() { queueMicrotask(() => this.onload && this.onload()); }
    abort() {}
  }
  globalThis.XMLHttpRequest = FailTokenXHR;
  try {
    const { synthesize } = loadTts();
    await assert.rejects(() => synthesize({
      provider: {
        id: 'baidu', method: 'POST',
        baseUrl: 'https://tsn.baidu.com/text2audio',
        auth: { type: 'token', keyName: 'tok', tokenUrl: 'https://aip.baidubce.com/oauth/2.0/token', tokenPath: 'access_token' },
        textField: 'tex',
        response: { mode: 'binary' },
        fields: [
          { key: 'apiKey', label: 'API Key', secret: true },
          { key: 'appSecretKey', label: 'Secret Key', secret: true },
        ],
        timeoutMs: 5000,
      },
      config: { apiKey: 'bad', appSecretKey: 'bad' },
      text: '你好',
    }), /令牌获取失败/);
  } finally {
    globalThis.XMLHttpRequest = originalXHR;
  }
});

test('HTTP 200 的 JSON 错误体抛出真实原因', async () => {
  const originalXHR = globalThis.XMLHttpRequest;
  class ErrorBodyXHR {
    constructor() {
      this.status = 200;
      const json = JSON.stringify({ err_no: 501, err_msg: 'invalid token' });
      this.response = new TextEncoder().encode(json).buffer;
      this.responseText = json;
    }
    open() {}
    setRequestHeader() {}
    send() { queueMicrotask(() => this.onload && this.onload()); }
    abort() {}
  }
  globalThis.XMLHttpRequest = ErrorBodyXHR;
  try {
    // 用免令牌的 Bearer 供应商，避免令牌步骤先拦截，直测音频响应的错误体检测
    const { synthesize } = loadTts();
    await assert.rejects(() => synthesize({
      provider: {
        id: 'binary-error-test', method: 'POST',
        baseUrl: 'https://example.test/tts',
        auth: { type: 'header', keyName: 'Authorization', prefix: 'Bearer ' },
        textField: 'input',
        response: { mode: 'binary' },
        fields: [{ key: 'apiKey', label: 'API Key', secret: true }],
        timeoutMs: 5000,
      },
      config: { apiKey: 'k' },
      text: '你好',
    }), /invalid token/);
  } finally {
    globalThis.XMLHttpRequest = originalXHR;
  }
});

test('百度 60 字上限生效且超出部分截断', () => {
  const tts = loadTts();
  assert.equal(tts.truncateText('一'.repeat(100), 60).length, 60);
  assert.equal(tts.truncateText('一'.repeat(30), 60).length, 30);
  assert.equal(tts.truncateText('一'.repeat(900)).length, 800);
});

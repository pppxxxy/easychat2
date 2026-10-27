import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const sourcePath = path.resolve('src/tts/index.js');
const sourceText = fs.readFileSync(sourcePath, 'utf8');
const babelOptions = {
  babelrc: false,
  configFile: false,
  filename: sourcePath,
  presets: [[require.resolve('@babel/preset-env'), { targets: { node: 'current' }, modules: 'commonjs' }]],
};
const compile = code => babel.transformSync(code, babelOptions).code;
const transformed = compile(sourceText);

// 记录 expo-audio 播放调用，供「云端音频播放链」测试断言。
const audioCalls = { created: [], played: 0 };

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === './providers.js') {
    return {
      TTS_MAX_CHARS: 800,
      getTtsProvider: () => null,
    };
  }
  if (request.endsWith('/secrets.js')) {
    return { registerSecretValues: () => {} };
  }
  if (request === 'expo-audio') {
    return {
      createAudioPlayer: source => {
        audioCalls.created.push(source);
        return {
          addListener: () => ({ remove() {} }),
          play: () => { audioCalls.played += 1; },
          pause() {},
          remove() {},
        };
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

function loadTts(code = transformed) {
  const filename = path.resolve('src/tts/index.js');
  const runtimeModule = new Module(filename);
  runtimeModule.filename = filename;
  runtimeModule.paths = Module._nodeModulePaths(path.dirname(filename));
  runtimeModule._compile(code, filename);
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
  // 预设音色走 audio.voice；模型 placeholder 必须是官方小写 Model ID，不是产品名
  assert.equal(mimo.voiceField, 'audio.voice');
  assert.ok(Array.isArray(mimo.voices) && mimo.voices.includes('mimo_default'));
  const mimoModelField = mimo.fields.find(field => field.key === 'model');
  assert.equal(mimoModelField.placeholder, 'mimo-v2.5-tts');
  assert.ok(mimo.fields.some(field => field.key === 'voice'), 'MiMo 应提供音色字段');
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
  // 阿里云：官方确认的凭据写法是查询参数 token（X-NLS-Token 头未在官方页命中，不采用）
  const aliyun = getTtsProvider('aliyun');
  assert.deepEqual(aliyun.auth, {});
  assert.deepEqual(aliyun.queryFields, [
    { name: 'appkey', from: 'appId' },
    { name: 'token', from: 'apiKey' },
  ]);
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
  }, { apiKey: 'mimo-key', model: 'mimo-v2.5-tts', voice: 'Mia' }, '你好，世界');
  assert.equal(request.headers['api-key'], 'mimo-key');
  const body = JSON.parse(request.body);
  assert.equal(body.model, 'mimo-v2.5-tts');
  assert.deepEqual(body.messages, [{ role: 'assistant', content: '你好，世界' }]);
  // 该内联声明未设 payloadDefaults/voiceField：不该凭空出现 audio 载荷
  assert.equal(body.audio, undefined);
});

test('hex 响应按 hex 解码为 base64 音频', async () => {
  const originalXHR = globalThis.XMLHttpRequest;
  const hexAudio = Buffer.from('fake-audio-bytes').toString('hex');
  let responseTypeSet = null;
  class HexXHR {
    constructor() { this.status = 200; this.responseText = JSON.stringify({ choices: [], data: { audio: hexAudio } }); }
    set responseType(value) { responseTypeSet = value; }
    get responseType() { return responseTypeSet; }
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
    // hex 走 responseText 解析：绝不能设 arraybuffer，否则 RN 的 responseText getter 抛错
    assert.notEqual(responseTypeSet, 'arraybuffer');
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

test('云端音频合成后交给 expo-audio 以 data URI 播放', async () => {
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
  audioCalls.created = [];
  audioCalls.played = 0;
  try {
    const { speak } = loadTts();
    await speak({
      provider: {
        engine: 'remote',
        method: 'POST',
        baseUrl: 'https://example.test/tts',
        textField: 'text',
        response: { mode: 'binary' },
        responseMime: 'audio/mp3',
      },
      config: { apiKey: 'key-12345678' },
      text: '你好',
    });
    // 迁移后播放必须走 expo-audio.createAudioPlayer，且源是 base64 data URI
    assert.equal(audioCalls.created.length, 1);
    assert.equal(audioCalls.created[0].uri, 'data:audio/mp3;base64,AP8QgA==');
    assert.equal(audioCalls.played, 1);
  } finally {
    globalThis.XMLHttpRequest = originalXHR;
  }
});

test('真实声明表驱动五家请求体逐家断言', async () => {
  // 直接导入真实 providers.js，用引擎真实实现构建请求：
  // 防止"合成 provider 测试通过、真实声明表却配错"的缺口。
  const { TTS_PROVIDERS } = await import('../src/tts/providers.js');
  const tts = loadTts();
  const find = id => TTS_PROVIDERS.find(item => item.id === id);

  // 小米：chat 模式 + audio.format=mp3 显式请求 + api-key 头 + 音色写 audio.voice
  const mimo = tts.buildTtsRequest(find('xiaomi-mimo'), {
    apiKey: 'mimo-key', model: 'mimo-v2.5-tts', voice: 'mimo_default',
  }, '你好');
  const mimoBody = JSON.parse(mimo.body);
  assert.equal(mimo.headers['api-key'], 'mimo-key');
  assert.deepEqual(mimoBody.messages, [{ role: 'assistant', content: '你好' }]);
  assert.equal(mimoBody.audio.format, 'mp3');
  assert.equal(mimoBody.audio.voice, 'mimo_default');
  assert.equal(mimoBody.model, 'mimo-v2.5-tts');

  // MiniMax：GroupId 查询 + Bearer 头 + hex 响应声明
  const minimax = tts.buildTtsRequest(find('minimax'), {
    apiKey: 'mm-key', appId: 'group-1', model: 'speech-2.8-hd',
  }, '你好');
  assert.match(minimax.url, /GroupId=group-1$/);
  assert.equal(minimax.headers.Authorization, 'Bearer mm-key');
  assert.equal(find('minimax').response.mode, 'hex');

  // 百度：表单编码 + tok 在表单体（不在查询串）+ ctp/lan/cuid/aue 默认值
  const baidu = tts.buildTtsRequest(find('baidu'), {
    apiKey: 'ak', appSecretKey: 'sk', voice: '0',
  }, '你好', 'oauth-token');
  assert.equal(baidu.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(baidu.url.includes('tok='), false);
  const baiduForm = new URLSearchParams(baidu.body);
  assert.equal(baiduForm.get('tok'), 'oauth-token');
  assert.equal(baiduForm.get('tex'), '你好');
  assert.equal(baiduForm.get('ctp'), '1');
  assert.equal(baiduForm.get('lan'), 'zh');
  assert.equal(baiduForm.get('cuid'), 'easychat2');
  assert.equal(baiduForm.get('aue'), '3');
  assert.equal(baiduForm.get('per'), '0');

  // 火山：嵌套载荷 + signer 必填 + Bearer; 头
  const volcano = tts.buildTtsRequest(find('volcano'), {
    appId: 'vol-app', apiKey: 'vol-token', voice: 'BV001_streaming',
  }, '你好');
  assert.equal(volcano.headers.Authorization, 'Bearer;vol-token');
  const volcanoBody = JSON.parse(volcano.body);
  assert.equal(volcanoBody.request.text, '你好');
  assert.equal(volcanoBody.request.operation, 'query');
  assert.ok(volcanoBody.request.reqid);
  assert.equal(volcanoBody.app.cluster, 'volcano_tts');
  assert.equal(volcanoBody.user.uid, 'easychat2');
  assert.equal(volcanoBody.audio.voice_type, 'BV001_streaming');
  assert.equal(volcanoBody.audio.encoding, 'mp3');

  // 阿里云：appkey+token 查询参数、format 默认 mp3、无 Authorization 头
  const aliyun = tts.buildTtsRequest(find('aliyun'), {
    apiKey: 'nls-token', appId: 'appkey-1',
  }, '你好');
  assert.equal(aliyun.headers.Authorization, undefined);
  assert.match(aliyun.url, /appkey=appkey-1/);
  assert.match(aliyun.url, /token=nls-token/);
  assert.equal(JSON.parse(aliyun.body).format, 'mp3');
});

test('语音播报面板：渲染预置音色选择并修 Android 键盘抖动', () => {
  const panel = fs.readFileSync(path.resolve('src/TtsPanel.js'), 'utf8');
  // 1a：声明表的 voices 必须真正渲染成可点选音色，否则「有音色却不能选」
  assert.ok(panel.includes('provider.voices'), '面板应使用 provider.voices');
  assert.ok(panel.includes('预置音色'), '应有音色选择区');
  assert.match(panel, /setField\('voice'/, '点选音色应写入 voice 字段');
  // 1c：Android 不能再用 behavior="height"（与 softwareKeyboardLayoutMode:resize 叠加会抖动）
  assert.match(panel, /behavior=\{Platform\.OS === 'ios' \? 'padding' : undefined\}/);
  assert.ok(!panel.includes("? 'padding' : 'height'"), 'Android 不应再叠 height 键盘避让');
});

test('resolveToken：凭据走 POST body、缓存按凭据指纹区分且 TTL 过期后重取', async () => {
  const originalXHR = globalThis.XMLHttpRequest;
  const requests = [];
  class TokenXHR {
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader() {}
    send(body) {
      requests.push({ method: this.method, url: this.url, body });
      this.status = 200;
      this.responseText = JSON.stringify({ access_token: `token-${requests.length}` });
      queueMicrotask(() => this.onload && this.onload());
    }
    abort() {}
  }
  globalThis.XMLHttpRequest = TokenXHR;
  try {
    const { resolveToken } = loadTts();
    const provider = {
      auth: {
        type: 'token',
        tokenUrl: 'https://oauth.test/token',
        tokenFields: { grant_type: 'client_credentials' },
        tokenPath: 'access_token',
        tokenTtlSec: 2592000,
      },
    };
    const base = { apiKey: 'key-one-123456', appSecretKey: 'secret-1' };
    // 首次：POST body 携带凭据（不进 URL 查询串）
    assert.equal(await resolveToken(provider, base, { now: 1000 }), 'token-1');
    assert.equal(requests[0].method, 'POST');
    assert.equal(requests[0].url, 'https://oauth.test/token');
    const body = new URLSearchParams(requests[0].body);
    assert.equal(body.get('client_id'), 'key-one-123456');
    assert.equal(body.get('client_secret'), 'secret-1');
    assert.equal(body.get('grant_type'), 'client_credentials');
    assert.equal(requests[0].url.includes('client_id'), false);
    // 同凭据命中缓存：只发一次请求
    assert.equal(await resolveToken(provider, base, { now: 2000 }), 'token-1');
    assert.equal(requests.length, 1);
    // 换密钥：凭据指纹变化，重新获取
    assert.equal(await resolveToken(provider, { ...base, apiKey: 'key-two-123456' }, { now: 3000 }), 'token-2');
    assert.equal(requests.length, 2);
    // TTL 过期后重取（新凭据避免命中前两项缓存）
    const ttlProvider = { auth: { ...provider.auth, tokenTtlSec: 10 } };
    const ttlBase = { apiKey: 'key-ttl-123456', appSecretKey: 'secret-ttl' };
    assert.equal(await resolveToken(ttlProvider, ttlBase, { now: 5000 }), 'token-3');
    assert.equal(await resolveToken(ttlProvider, ttlBase, { now: 5000 + 11 * 1000 }), 'token-4');
    assert.equal(requests.length, 4);
    // 非 token 类型直接返回空令牌
    assert.equal(await resolveToken({ auth: { type: 'header' } }, base, {}), '');
  } finally {
    globalThis.XMLHttpRequest = originalXHR;
  }
});

// ---- 归错因 / 中断语义 ----
// 修复内容：synthesize 里原本多套了一层
// `.catch(error => { if (error.name === 'AbortError') throw error;
//                    throw new Error(error.message || tActive('error.tts.tokenFailed')); })`。
// 实测复核（本批用「让网络层 reject 一个带标记的 AbortError」跑过旧实现）：
// 对 AbortError 这条路径**行为等价**——第一句原样 re-throw，identity 保住了。
// 所以这不是一个可利用缺陷，只是「重包一层」的冗余：它丢掉普通错误的原始对象
// （栈与自定义字段），并在 catch 里留了一处将来很容易被改错的逻辑。
// 下面这条**不是旧实现的阳性对照**（旧实现也能过），而是把「错误对象必须原样穿过
// synthesize」这条契约钉死，防止有人日后把 re-throw 改成重包。
test('取令牌被中断：synthesize 原样上抛 resolveToken 的错误对象，不得重包', async () => {
  const TOKEN_ABORT = new Error('令牌端点已中断');
  TOKEN_ABORT.name = 'AbortError';
  TOKEN_ABORT.canceled = true;
  TOKEN_ABORT.marker = 'token-layer-marker';
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === '../network/vendorHttp.js') {
      // __esModule 让 babel 的 interop 按 ESM 默认导出取值（否则 default 会被当成整个
      // 命名空间对象，调用时报 "is not a function"）。
      return { __esModule: true, default: () => Promise.reject(TOKEN_ABORT) };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const { synthesize } = loadTts();
    const provider = {
      id: 'token-abort-test',
      method: 'POST',
      baseUrl: 'https://example.test/tts',
      auth: { type: 'token', keyName: 'tok', tokenInBody: true, tokenUrl: 'https://oauth.test/token' },
      textField: 'tex',
      response: { mode: 'binary' },
      fields: [
        { key: 'apiKey', label: 'API Key', secret: true },
        { key: 'appSecretKey', label: 'Secret Key', secret: true },
      ],
    };
    await assert.rejects(
      () => synthesize({ provider, config: { apiKey: 'bad-1', appSecretKey: 'bad-2' }, text: '你好' }),
      error => {
        assert.equal(error, TOKEN_ABORT, '必须原样上抛，不能 new Error(...) 重包');
        assert.equal(error.name, 'AbortError', '中断语义的 name 不得被抹掉');
        assert.equal(error.canceled, true, '自定义字段不得丢失');
        return true;
      },
    );
  } finally {
    Module._load = originalLoad;
  }
});

function makeAbortableTokenXHR() {
  return class AbortableTokenXHR {
    static instances = [];
    constructor() {
      AbortableTokenXHR.instances.push(this);
      this.status = 0;
    }
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader() {}
    send() {}
    abort() {
      this.aborted = true;
      queueMicrotask(() => this.onabort && this.onabort());
    }
  };
}

test('取令牌阶段被中断：synthesize 必须保持 AbortError 身份（不得重包成普通 Error）', async () => {
  const originalXHR = globalThis.XMLHttpRequest;
  globalThis.XMLHttpRequest = makeAbortableTokenXHR();
  try {
    const { synthesize } = loadTts();
    const controller = new AbortController();
    const pending = synthesize({
      provider: {
        id: 'baidu-abort',
        method: 'POST',
        baseUrl: 'https://tsn.baidu.com/text2audio',
        auth: { type: 'token', keyName: 'tok', tokenInBody: true, tokenUrl: 'https://aip.baidubce.com/oauth/2.0/token' },
        textField: 'tex',
        response: { mode: 'binary' },
        fields: [
          { key: 'apiKey', label: 'API Key', secret: true },
          { key: 'appSecretKey', label: 'Secret Key', secret: true },
        ],
      },
      config: { apiKey: 'abort-key-1', appSecretKey: 'abort-secret-1' },
      text: '你好',
      signal: controller.signal,
    });
    await new Promise(resolve => setImmediate(resolve));
    controller.abort();
    await assert.rejects(pending, error => error && error.name === 'AbortError');
  } finally {
    globalThis.XMLHttpRequest = originalXHR;
  }
});

test('speak 在取令牌阶段被停止：不回调 onError（用户主动停止不是失败）', async () => {
  const originalXHR = globalThis.XMLHttpRequest;
  globalThis.XMLHttpRequest = makeAbortableTokenXHR();
  const errors = [];
  let done = 0;
  try {
    // 同一个模块实例里取 speak 与 stop：两次 loadTts() 会各自持一份
    // speakGeneration/activeRequestController，跨实例 stop 根本停不到这次播报。
    const tts = loadTts();
    const provider = {
      id: 'baidu-stop',
      method: 'POST',
      baseUrl: 'https://tsn.baidu.com/text2audio',
      auth: { type: 'token', keyName: 'tok', tokenInBody: true, tokenUrl: 'https://aip.baidubce.com/oauth/2.0/token' },
      textField: 'tex',
      response: { mode: 'binary' },
      fields: [
        { key: 'apiKey', label: 'API Key', secret: true },
        { key: 'appSecretKey', label: 'Secret Key', secret: true },
      ],
    };
    const pending = tts.speak({
      provider,
      config: { apiKey: 'abort-key-2', appSecretKey: 'abort-secret-2' },
      text: '你好',
      onDone: () => { done += 1; },
      onError: error => errors.push(error),
    });
    await new Promise(resolve => setImmediate(resolve));
    await tts.stop();
    await pending;
    assert.deepEqual(errors, [], '用户主动停止不得被当成播报失败回调 onError');
    assert.equal(done, 0);
  } finally {
    globalThis.XMLHttpRequest = originalXHR;
  }
});


// 背景：src/tts/index.js 的 setByPath 与 src/imageGen/index.js 曾是同形实现
//（`node[key] = {}` 后 `node = node[key]`，没有任何键名校验）。生图侧那条已经实测
// 可被 `{"__proto__.x": "…"}` 写脏 Object.prototype（见 tests/imageGen.test.mjs）。
//
// 复核结论（详见本批报告）：TTS 这条路上，路径目前**全部**来自内置声明表
//（providers.js 的 textField / voiceField / speedField / formatField / appIdField /
// auth.keyName）或本文件写死的常量，用户能编辑的只有**字段值**——键名进不来，
// 所以今天是**潜伏**而非可利用。但 buildTtsRequest 是导出的、且吃调用方传入的
// provider 对象：一旦有人给 TTS 加「自定义 provider / 导入声明表」这类入口
//（生图侧的「额外参数(JSON)」就是先例），同一行代码立刻变成可利用。
// 下面按「先钉死不可利用的现状、再钉死拦截生效」写：攻击形态走 provider 声明字段。
const POLLUTION_SENTINEL = '__proto_pollution_sentinel__';

// 攻击 provider：textField 的**键名**被当成点路径（真实 provider 只会写 'text' 这种
// 普通键名；这里模拟「键名来自不可信声明表」的那一天）。
const attackProvider = {
  id: 'proto-attack',
  method: 'POST',
  baseUrl: 'https://example.test/tts',
  auth: { type: 'header', keyName: 'Authorization', prefix: 'Bearer ' },
  response: { mode: 'binary' },
  fields: [{ key: 'apiKey', label: 'API Key', secret: true }],
};

test('声明表的点路径不得污染 Object.prototype（textField 与 auth.keyName 两条路）', () => {
  assert.equal(({})[POLLUTION_SENTINEL], undefined, '前置：哨兵键此刻不应存在');
  const tts = loadTts();

  // 路 1：provider.textField（真实实现里写的是 'text' / 'input' / 'request.text'）
  const fromTextField = tts.buildTtsRequest(
    { ...attackProvider, textField: `__proto__.${POLLUTION_SENTINEL}` },
    { apiKey: 'k' },
    '你好',
  );
  assert.ok(fromTextField, '合法 provider 应当能构建出请求');
  assert.equal(({})[POLLUTION_SENTINEL], undefined, 'Object.prototype 被写脏（全局原型污染）');
  const body = JSON.parse(fromTextField.body);
  assert.equal(body[POLLUTION_SENTINEL], undefined, '危险键必须整键丢弃，不能变成载荷的 own 属性');
  assert.equal(Object.prototype.hasOwnProperty.call(body, '__proto__'), false, '不得留成 own 属性');
  assert.equal(Object.getPrototypeOf(body), Object.prototype, '载荷的原型必须仍是 Object.prototype');

  // 路 2：auth.keyName 在 tokenInBody 分支同样被当成点路径写进载荷
  const fromAuthKeyName = tts.buildTtsRequest({
    ...attackProvider,
    auth: { type: 'token', keyName: `constructor.${POLLUTION_SENTINEL}`, tokenInBody: true, tokenUrl: 'https://oauth.test/token' },
  }, { apiKey: 'k' }, '你好', 'token-1');
  assert.ok(fromAuthKeyName);
  assert.equal(({})[POLLUTION_SENTINEL], undefined, 'auth.keyName 这条路上同样不得污染原型');
  // `constructor.<x>` 在旧实现下会沿继承链取到 Object 构造函数并把 x 挂到它上面
  // （全局副作用，不是本对象的 own 属性），所以这里连构造函数一起查。
  assert.equal(Object[POLLUTION_SENTINEL], undefined, 'constructor 链不得被写穿');
  assert.equal(JSON.parse(fromAuthKeyName.body)[POLLUTION_SENTINEL], undefined);
});

test('正常嵌套点路径仍然写入（防过度拦截）', () => {
  const tts = loadTts();
  // 火山声明表就是真实的多层点路径：request.text / audio.voice_type / user.uid …
  const volcanoProvider = {
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
  };
  const request = tts.buildTtsRequest(volcanoProvider, {
    appId: 'app-1', apiKey: 'tok-1', voice: 'BV001_streaming', speed: '1.0',
  }, '你好');
  const body = JSON.parse(request.body);
  // 多层嵌套全部照写：拦截不能把正常路径一起挡掉
  assert.equal(body.request.text, '你好');
  assert.equal(body.audio.voice_type, 'BV001_streaming');
  assert.equal(body.audio.speed_ratio, 1.0);
  assert.equal(body.audio.encoding, 'mp3');
  assert.equal(body.app.cluster, 'volcano_tts');
  assert.equal(body.user.uid, 'easychat2');
  assert.equal(body.app.appid, 'app-1');
  // 声明表本体不得被写穿（payloadDefaults 深拷贝基底，不是浅拷贝共享对象）
  assert.deepEqual(volcanoProvider.payloadDefaults, { audio: { encoding: 'mp3' } }, 'payloadDefaults 本体被写脏');
  assert.equal(Object.getPrototypeOf(body), Object.prototype);
});

test('阳性对照：去掉保留键拦截后，同一条攻击确实会写脏 Object.prototype', async () => {
  // 拦截清单在共享叶子模块里，所以「关掉拦截」= 让该模块的 isReservedPathKey 恒假。
  const sharedPath = require.resolve('../src/utils/reservedPathKeys.js');
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === '../utils/reservedPathKeys.js' || request === sharedPath) {
      return { RESERVED_PATH_KEYS: new Set(), isReservedPathKey: () => false };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const unguarded = loadTts();
    unguarded.buildTtsRequest(
      { ...attackProvider, textField: `__proto__.${POLLUTION_SENTINEL}` },
      { apiKey: 'k' },
      '你好',
    );
    // 写进 Object.prototype 的是这次要合成的**文本**（旧实现下 textField 的值原样写穿）。
    assert.equal(({})[POLLUTION_SENTINEL], '你好', '对照未复现旧实现的泄漏，说明哨兵断言已失去灵敏度');
  } finally {
    Module._load = originalLoad;
    delete Object.prototype[POLLUTION_SENTINEL];
  }
  assert.equal(({})[POLLUTION_SENTINEL], undefined, '对照必须清理干净，不然后面的用例会被误判');
  // 拦截清单的共享来源：确认 TTS 侧确实在用这份清单，而不是自己另写了一份
  const { isReservedPathKey } = await import('../src/utils/reservedPathKeys.js');
  assert.equal(isReservedPathKey('__proto__'), true);
  assert.equal(isReservedPathKey('constructor'), true);
  assert.equal(isReservedPathKey('prototype'), true);
  assert.equal(isReservedPathKey('text'), false);
  assert.match(
    fs.readFileSync(sourcePath, 'utf8'),
    /from '\.\.\/utils\/reservedPathKeys\.js'/,
    'tts 引擎必须复用共享保留键模块（另抄一份清单就是留一条旁路）',
  );
});

// ---- 播报面板 i18n（审查批次定位：英文界面漏出中文引擎名 / 中文占位符）----
//
// 为什么这组断言必须有：eslint 的 no-hardcoded-chinese(-text) 只查 Alert / JSX /
// 模块级常量，**看不见数据文件（tts/providers.js）里的 label**——审查方实测
// `eslint src/tts/providers.js src/TtsPanel.js` exit=0。规则盲区 + 同族一处做对
// 一处没做（CharacterOverridesSection 走 i18n、TtsPanel 直接渲染常量），
// 于是英文用户进「播报源」看到的是中文引擎名与中文占位符。
// 这里用「剥注释后的源码断言 + 词条实测」把这条路径钉死。

// 剥注释：反向断言（不得再直接渲染 xx.label）之前必须先去注释——否则注释里写一句
// `// item.label` 就能让它假通过。口径同 scripts/i18nKeyAudit.mjs 的「整行注释跳过」。
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(line => !line.trim().startsWith('//'))
    .join('\n');
}

const readSrc = rel => fs.readFileSync(path.resolve(rel), 'utf8');

// 中日韩汉字 + 中文标点：全角标点里一个汉字都没有，只查汉字会整类漏掉
//（同 eslint-rules/no-hardcoded-chinese.mjs 把中文标点纳入匹配的理由）。
const CJK = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]/;

test('播报面板：引擎名 / 字段 label / placeholder 全部走 i18n，不再直接渲染声明表常量', () => {
  const panel = stripComments(readSrc('src/TtsPanel.js'));
  // 正向：五处用户可见文案都必须经共享取值函数（内部 t(key)）
  assert.match(panel, /ttsProviderLabel\(t, item\)/, '引擎名必须经共享取值函数取词条');
  assert.match(panel, /ttsProviderLabel\(t, provider\)/, '「获取 API Key」的无障碍名称也要走 i18n');
  assert.match(panel, /ttsFieldLabel\(t, field\)/, '字段 label 必须经共享取值函数取词条');
  assert.match(panel, /ttsFieldPlaceholder\(t, field\)/, '字段 placeholder 必须经共享取值函数取词条');
  assert.match(panel, /ttsUnsupportedNote\(t, /, '「暂不支持」的原因说明同样是中文常量，必须走 i18n');
  // 反向：不得再直接渲染 .label / .placeholder（那正是英文界面漏中文的形态）
  assert.equal(/\bitem\.label\b/.test(panel), false, '不得直接渲染 item.label');
  assert.equal(/\bprovider\.label\b/.test(panel), false, '不得直接渲染 provider.label');
  assert.equal(/\bfield\.label\b/.test(panel), false, '不得直接渲染 field.label');
  assert.equal(/\bfield\.placeholder\b/.test(panel), false, '不得直接渲染 field.placeholder');
});

test('播报面板：每个引擎名与字段文案在英文下都取到英文（translate("en", key) 实测）', async () => {
  const {
    TTS_PROVIDERS, ttsFieldLabel, ttsFieldPlaceholder, ttsProviderLabel, ttsUnsupportedNote,
  } = await import('../src/tts/providers.js');
  const { translate } = await import('../src/i18n/index.js');
  const en = key => translate('en', key);

  for (const provider of TTS_PROVIDERS) {
    assert.ok(provider.labelKey, `${provider.id} 缺 labelKey（英文界面会回落中文常量）`);
    const name = ttsProviderLabel(en, provider);
    assert.equal(CJK.test(name), false, `英文界面下引擎名仍是中文：${provider.id} → ${name}`);
    assert.equal(name, en(provider.labelKey), '引擎名必须等于英文词条');
    // 声明表已是 labelKey-only（中文常量全部迁进词条，见 providers.js 的迁 i18n 说明），
    // 不再拿 label 常量比对；改成钉「zh-CN 词条必须真的存在」——差一条界面就会回落成
    // 键名/id 显示给用户，这条断言抓的正是漏登记。
    assert.notEqual(translate('zh-CN', provider.labelKey), provider.labelKey,
      `${provider.id} 缺 zh-CN 词条（界面会回落成键名/id）`);
    if (provider.unsupportedNoteKey) {
      const note = ttsUnsupportedNote(en, provider);
      assert.equal(CJK.test(note), false, `英文界面下「暂不支持」原因仍是中文：${provider.id} → ${note}`);
      assert.equal(note, en(provider.unsupportedNoteKey), '原因说明必须等于英文词条');
      assert.notEqual(translate('zh-CN', provider.unsupportedNoteKey), provider.unsupportedNoteKey, `${provider.id} 缺 zh-CN 原因词条`);
    }
    for (const field of provider.fields) {
      assert.ok(field.labelKey, `${provider.id}.${field.key} 缺 labelKey`);
      const label = ttsFieldLabel(en, field);
      assert.equal(CJK.test(label), false, `英文界面下字段名仍是中文：${provider.id}.${field.key} → ${label}`);
      assert.equal(label, en(field.labelKey), '字段名必须等于英文词条');
      assert.notEqual(translate('zh-CN', field.labelKey), field.labelKey,
        `${provider.id}.${field.key} 缺 zh-CN 字段名词条`);
      const placeholder = ttsFieldPlaceholder(en, field);
      assert.equal(CJK.test(placeholder), false, `英文界面下占位符仍是中文：${provider.id}.${field.key} → ${placeholder}`);
      if (field.placeholderKey) {
        assert.notEqual(translate('zh-CN', field.placeholderKey), field.placeholderKey,
          `${provider.id}.${field.key} 缺 zh-CN 占位符词条`);
      } else {
        // 没有 placeholderKey 的占位符必须是语言无关字面量（URL / 模型 ID / 数字）：
        // 一旦写成中文，英文界面就又会漏出中文——这条反向断言防的正是本缺陷复发。
        assert.equal(CJK.test(String(field.placeholder || '')), false,
          `${provider.id}.${field.key} 的中文占位符缺 placeholderKey`);
      }
    }
  }
  // 兜底形态（key 优先 + 常量兜底，同 PluginPanel.js:260,263 的先例）：
  // 词条查不到时必须回落**声明表里剩下的东西**（id / 空串 / 语言无关占位符），
  // 而不是把 `tts.field.voice` 这种键名显示给用户——声明表迁 i18n 后已无中文常量，
  // 所以这里的期望值随之下移，但「不显示键名」这条不变。
  const missingT = key => key;
  const [first] = TTS_PROVIDERS;
  assert.equal(ttsProviderLabel(missingT, first), first.id);
  assert.equal(ttsFieldLabel(missingT, first.fields[0]), '');
  assert.equal(ttsFieldPlaceholder(missingT, first.fields[0]), String(first.fields[0].placeholder || ''));
});

test('播报面板：面板名与「关闭」的无障碍名是两个语义（title 曾被误写成「关闭」）', async () => {
  const panel = stripComments(readSrc('src/TtsPanel.js'));
  assert.match(panel, /\{t\('tts\.title'\)\}/, '面板标题必须走 tts.title');
  assert.match(panel, /accessibilityLabel=\{t\('tts\.closeA11y'\)\}/, '关闭按钮必须走本面板的 tts.closeA11y（同 TranscriptionPanel.js:159 形态）');
  assert.equal(panel.includes("t('common.close')"), false, '不得再用 common.close 顶替本面板的关闭名');
  const { translate } = await import('../src/i18n/index.js');
  assert.notEqual(translate('zh-CN', 'tts.title'), '关闭', '面板名不得再是「关闭」');
  assert.notEqual(translate('en', 'tts.title'), 'Close', '面板名不得再是 "Close"');
  // 英文音色区标题曾是机器翻译残留 'Label'（中文基准是「预置音色（可选）」）。
  assert.notEqual(translate('en', 'tts.voices.label'), 'Label', '英文音色区标题不得是机器翻译残留');
  assert.equal(CJK.test(translate('en', 'tts.voices.label')), false, '英文音色区标题不得是中文');
});

test('播报面板：不支持提示的默认说明没有模板碎片（花括号必须配对）', async () => {
  // 背景：tts.unsupportedHint.defaultNote 的中文值曾是 '}。播报会失败…'——某次删掉
  // '{...}' 段后留下的碎片，拼进 '当前引擎暂不支持：{note}' 会渲染成「：}。…」。
  // 同款碎片在 zh-CN/preset.js 的 preset.unnamed 也出现过（原值 '}」吗？'），**那一例已修**
  // 为 '未命名'——这里保留它作为该家族的已修案例登记；本条断言只钉 tts 自己的默认说明。
  const { translate } = await import('../src/i18n/index.js');
  for (const locale of ['zh-CN', 'en']) {
    const note = translate(locale, 'tts.unsupportedHint.defaultNote');
    assert.equal(/[{}]/.test(note), false, `${locale} 的默认说明残留花括号碎片：${note}`);
    // 真拼一遍模板：结果里不该再有花括号（未替换占位符或碎片）
    const rendered = translate(locale, 'tts.unsupportedHint', { note });
    assert.equal(/[{}]/.test(rendered), false, `${locale} 渲染结果含花括号碎片：${rendered}`);
  }
});

test('播报源名称映射只有一处：声明表的 labelKey，两个面板都从它取', async () => {
  const overrides = stripComments(readSrc('src/character/CharacterOverridesSection.js'));
  const panel = stripComments(readSrc('src/TtsPanel.js'));
  // 旧形态：CharacterOverridesSection 自己维护一份 id→key 映射表，TtsPanel 直接渲染中文常量。
  // 那份映射必须彻底消失——否则「同族一处做对一处没做」会以另一种形式复发。
  assert.equal(/TTS_PROVIDER_NAME_KEYS/.test(overrides), false, '映射表必须已从使用方删除（单一来源在声明表）');
  assert.equal(/TTS_PROVIDER_NAME_KEYS/.test(panel), false, 'TtsPanel 不得自建映射表');
  for (const [file, source] of [
    ['src/character/CharacterOverridesSection.js', overrides],
    ['src/TtsPanel.js', panel],
  ]) {
    assert.match(source, /from '[^']*tts\/providers\.js'/, `${file} 必须从 tts/providers.js 取映射`);
    assert.match(source, /\bttsProviderLabel\b/, `${file} 必须用共享取值函数，不得另抄一份`);
  }
  // 全仓扫描：`tts.providerName.*` 只允许出现在声明表与语言包里——别处再出现一次
  // 就是「又抄了一份映射」，正是本缺陷的复发形态。
  const offenders = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.js')) continue;
      const rel = path.relative(path.resolve('.'), full).split(path.sep).join('/');
      if (rel.startsWith('src/i18n/locales/')) continue;
      if (stripComments(readSrc(rel)).includes('tts.providerName.')) offenders.push(rel);
    }
  })(path.resolve('src'));
  assert.deepEqual(offenders, ['src/tts/providers.js'],
    `provider 名映射只允许定义在声明表里，实际出现在：${offenders.join(', ')}`);
  // 声明表本身：每个 provider 恰好一条 labelKey，不重复、不缺
  const { TTS_PROVIDERS } = await import('../src/tts/providers.js');
  const keys = TTS_PROVIDERS.map(item => item.labelKey);
  assert.equal(keys.every(Boolean), true, '每个 provider 都要有 labelKey');
  assert.equal(new Set(keys).size, keys.length, 'labelKey 不得重复');
  // 剥注释后再数：声明表头注释里举了 `tts.providerName.${id}` 这个反例，注释不该计数。
  const occurrences = (stripComments(readSrc('src/tts/providers.js')).match(/tts\.providerName\./g) || []).length;
  assert.equal(occurrences, TTS_PROVIDERS.length, 'providerName 引用数应与引擎数一致（一处一份）');
});

test('播报面板：读失败时保存禁用 + 给出原因，persist 不得再静默短路', async () => {
  const panel = stripComments(readSrc('src/TtsPanel.js'));
  // (a) 读失败（loaded 恒 false）→ 按钮禁用 + 视觉反馈 + 无障碍状态 + 可见原因
  assert.match(panel, /disabled=\{!loaded\}/, '读失败时保存按钮必须禁用');
  assert.match(panel, /saveButtonDisabled/, '禁用要有视觉反馈（同 providerChipUnsupported 口径）');
  assert.match(panel, /accessibilityState=\{\{ disabled: !loaded \}\}/, '禁用状态要报给无障碍（同 ChatTopBar.js:96-100）');
  assert.match(panel, /t\('tts\.saveDisabled\.readFailed'\)/, '禁用要说明原因，不能只把按钮变灰');
  // (b) persist 的 !loaded 分支必须弹可见错误，而不是 `return false` 了事
  const start = panel.indexOf('const persist = useCallback');
  const end = panel.indexOf('const provider = getTtsProvider');
  assert.ok(start >= 0 && end > start, '定位 persist 失败（本断言已失效，需同步更新）');
  const persist = panel.slice(start, end);
  const guardAt = persist.indexOf('if (!loaded)');
  assert.ok(guardAt >= 0, 'persist 必须保留 !loaded 守卫（防覆盖已有配置）');
  const guard = persist.slice(guardAt, persist.indexOf('const previous = lastSavedSettingsRef.current'));
  assert.match(guard, /Alert\.alert\(t\('tts\.alert\.saveAborted\.title'\)/, '短路分支必须弹可见错误');
  assert.match(guard, /return false;/, '仍然不得继续保存（不得覆盖已有配置）');
  // 文案必须说清「为什么不能存」，不能只说「保存失败」——后者会把用户引去查存储权限，
  // 而真实原因是读失败。口径同 storage/worldMap.js:37 与 error.storage.characterIndexReadFailed。
  const { translate } = await import('../src/i18n/index.js');
  assert.match(translate('zh-CN', 'tts.alert.saveAborted.body'), /已中止保存/, '中文文案要说清「已中止保存以免覆盖」');
  assert.match(translate('en', 'tts.alert.saveAborted.body'), /aborted/i, '英文文案要说清保存已中止');
  assert.match(translate('zh-CN', 'tts.saveDisabled.readFailed'), /已停用保存/, '禁用原因要说清已停用保存');
  assert.match(translate('en', 'tts.saveDisabled.readFailed'), /disabled/i, '英文禁用原因要说清 saving is disabled');
});


import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const sourcePath = path.resolve('src/imageGen/index.js');
const sourceText = fs.readFileSync(sourcePath, 'utf8');
const babelOptions = {
  babelrc: false,
  configFile: false,
  filename: sourcePath,
  presets: [[require.resolve('@babel/preset-env'), { targets: { node: 'current' }, modules: 'commonjs' }]],
};
const compile = code => babel.transformSync(code, babelOptions).code;

// 用 CommonJS 直编译源码，取到模块的完整导出面（buildRequest 也在这里——
// 原型污染用例必须直接调它，而不是绕过它去测内部函数）。
function loadImageGenModule(code) {
  const filename = path.resolve('src/imageGen/index.js');
  const runtimeModule = new Module(filename);
  runtimeModule.filename = filename;
  runtimeModule.paths = Module._nodeModulePaths(path.dirname(filename));
  runtimeModule._compile(code, filename);
  return runtimeModule.exports;
}

const { detectImageProvider, generateImage, buildRequest } = loadImageGenModule(compile(sourceText));

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

test('模型列表检测取消时不会进入付费试生成', async () => {
  FakeXHR.instances = [];
  FakeXHR.status = 0;
  globalThis.XMLHttpRequest = FakeXHR;
  const controller = new AbortController();
  const pending = detectImageProvider({
    provider,
    config: { apiKey: 'key' },
    model: 'model',
    signal: controller.signal,
  });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, error => error && error.name === 'AbortError');
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

// ---- 原型污染（P0）----
// 设置页的「额外参数(JSON)」是用户可编辑输入，解析成对象后其**键名**被当成点路径，
// 逐段写进请求载荷。修复前的 setByPath 在 `__proto__.x` 上会把 node 的原型换成新对象，
// 再把 x 写进那个原型对象 —— 于是 Object.prototype 被写脏，之后 normalizeConfig
// 会读到**继承来的** baseUrl/apiKey：一份「空配置」突然变成攻击者地址 + 密钥。
// 下面用哨兵键名把这条边界钉死（键名取成不可能与真实字段撞车的字符串）。
const POLLUTION_SENTINEL = '__proto_pollution_sentinel__';

// 专用 provider：模板只放一个 {prompt} 占位符，载荷形状干净到可以直接比对键集合
// （共享的 provider 模板写的是 {{prompt}}，会留一层花括号，干扰断言）。
const protoProvider = {
  id: 'proto-test',
  baseUrl: 'https://example.com/v1',
  t2i: { template: { prompt: '{prompt}' }, endpoint: 'https://example.com/image' },
};

test('额外参数的点路径不得污染 Object.prototype（config.extra 与 extra.params 两条路）', () => {
  assert.equal(({})[POLLUTION_SENTINEL], undefined, '前置：哨兵键此刻不应存在');
  const attacks = {
    [`__proto__.${POLLUTION_SENTINEL}`]: 'yes',
    [`constructor.${POLLUTION_SENTINEL}`]: 'yes',
    [`prototype.${POLLUTION_SENTINEL}`]: 'yes',
  };

  // 路 1：config.extra（设置页「额外参数(JSON)」落盘后经 normalizeConfig 到这里）
  const fromConfig = buildRequest({ provider: protoProvider, config: { apiKey: 'key', extra: attacks }, prompt: '猫' });
  assert.ok(fromConfig, '合法 provider 应当能构建出请求');
  assert.equal(({})[POLLUTION_SENTINEL], undefined, 'Object.prototype 被写脏（全局原型污染）');
  const configBody = JSON.parse(fromConfig.body);
  assert.deepEqual(Object.keys(configBody), ['prompt'], '危险键必须整键丢弃，不能变成载荷的 own 属性');
  assert.equal(Object.prototype.hasOwnProperty.call(configBody, '__proto__'), false);
  assert.equal(configBody[POLLUTION_SENTINEL], undefined);

  // 路 2：extra.params（调用方直传的额外参数，同样由用户可编辑内容拼出）
  const fromParams = buildRequest({ provider: protoProvider, config: { apiKey: 'key' }, extra: { params: attacks }, prompt: '猫' });
  assert.ok(fromParams, '合法 provider 应当能构建出请求');
  assert.equal(({})[POLLUTION_SENTINEL], undefined, 'extra.params 这条路上同样不得污染原型');
  assert.deepEqual(Object.keys(JSON.parse(fromParams.body)), ['prompt']);
});

test('正常嵌套点路径仍然写入（防过度拦截）', () => {
  const request = buildRequest({
    provider: protoProvider,
    config: { apiKey: 'key', extra: { 'a.b.c': 'deep', 'a.b.d': 2, plain: 'x' } },
    prompt: '猫',
  });
  const body = JSON.parse(request.body);
  assert.equal(body.a.b.c, 'deep');
  assert.equal(body.a.b.d, 2);
  assert.equal(body.plain, 'x');
  assert.equal(body.prompt, '猫');
});

// 阳性对照：把保留键拦截整体关掉，还原「修复前」的 setByPath，同一条攻击必须把哨兵写脏。
// 这是「上面那几条断言真的能发现泄漏」的证据（旧实现下本文件的污染用例必红）；
// 反过来，若拦截函数被改名/改形导致这里的正则没命中，下面那条 assert.ok 会立刻报错，
// 对照不会退化成永远通过的空转断言。
test('阳性对照：去掉保留键拦截后，同一条攻击确实会写脏 Object.prototype', () => {
  const unguardedSource = sourceText.replace(
    /function isReservedPathKey\([^)]*\)\s*\{[\s\S]*?\n\}/,
    'function isReservedPathKey() { return false; }'
  );
  assert.ok(unguardedSource !== sourceText, '对照必须真的改掉拦截函数，否则这条断言是空转的');
  const unguarded = loadImageGenModule(compile(unguardedSource));
  try {
    unguarded.buildRequest({
      provider: protoProvider,
      config: { apiKey: 'key', extra: { [`__proto__.${POLLUTION_SENTINEL}`]: 'yes' } },
      prompt: '猫',
    });
    assert.equal(({})[POLLUTION_SENTINEL], 'yes', '对照未复现旧实现的泄漏，说明哨兵断言已失去灵敏度');
  } finally {
    delete Object.prototype[POLLUTION_SENTINEL];
  }
  assert.equal(({})[POLLUTION_SENTINEL], undefined, '对照必须清理干净，不然后面的用例会被误判');
});

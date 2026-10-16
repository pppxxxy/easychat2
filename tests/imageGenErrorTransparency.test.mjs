// FEAT-AC13：改图报错不透明与上游兼容。
//
// 来源：用户报告（未结案 4）「上一回改图的问题还在」——无截图、无日志、无复现步骤。
// 本文件只测**行为**（导入真模块跑），不做源码字符串断言（AGENTS.md 的测试约定）。
//
// 覆盖四项必做 + 两项契约防御：
//   P0-1 报错误透传（上游 error.message 不再被丢弃）
//   P0-2 HEIC 前置拦截
//   P1-3 端点写法自检
//   P1-4 gpt-image 跳过 response_format
//   P2-5 imageUrl 通道 fail-fast
//   P2-6 重试重建请求（FormData 一次性）

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

import {
  describeHttpErrorBody,
  composeHttpErrorMessage,
} from '../src/imageGen/httpError.js';
import {
  isRejectedReferenceFormat,
  I2I_SUPPORTED_MIMES,
} from '../src/imageGen/referenceFormat.js';
import {
  ENDPOINT_ISSUES,
  inspectImageEndpoint,
  skipsResponseFormat,
  withoutResponseFormat,
} from '../src/imageGen/endpointCheck.js';

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

function loadImageGenModule(code) {
  const filename = path.resolve('src/imageGen/index.js');
  const runtimeModule = new Module(filename);
  runtimeModule.filename = filename;
  runtimeModule.paths = Module._nodeModulePaths(path.dirname(filename));
  runtimeModule._compile(code, filename);
  return runtimeModule.exports;
}

const { generateImage, buildRequest } = loadImageGenModule(compile(sourceText));

// 一个可编程的 FakeXHR：能分别设定「状态码」「响应体文本」「发送时报错」。
class FakeXHR {
  static instances = [];
  static status = 200;
  static responseText = '{}';
  static sendThrows = null;

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

  send(body) {
    // 记下实际发出的 body：P2-6 要断言「重试时重建了请求体」，
    // 不记就无从判断（第一版忘了这一行，于是两条断言都在比 undefined）。
    this.body = body;
    if (FakeXHR.sendThrows) throw FakeXHR.sendThrows;
    this.status = FakeXHR.status;
    this.responseText = FakeXHR.responseText;
    this.onload();
  }

  abort() {
    this.aborted = true;
    if (this.onabort) this.onabort();
  }
}

function resetFake({ status = 200, responseText = '{}', sendThrows = null } = {}) {
  FakeXHR.instances = [];
  FakeXHR.status = status;
  FakeXHR.responseText = responseText;
  FakeXHR.sendThrows = sendThrows;
  globalThis.XMLHttpRequest = FakeXHR;
}

// openai-relay 的真实形状（baseUrlSuffixes + endpointFromBaseUrl + 模板含 response_format）。
const relayProvider = {
  id: 'openai-relay',
  baseUrl: 'https://relay.example.com/v1/images/generations',
  method: 'POST',
  requestFormat: 'json',
  auth: { type: 'header', keyName: 'Authorization', prefix: 'Bearer ' },
  headers: { 'Content-Type': 'application/json' },
  modelField: 'model',
  listModelsPath: '/models',
  baseUrlSuffixes: ['/images/generations', '/images/edits'],
  baseUrlPlaceholder: 'https://example.com/v1/images/generations',
  params: { size: 'size' },
  t2i: { template: { model: '{model}', prompt: '{prompt}', n: 1, response_format: 'b64_json' } },
  i2i: {
    requestFormat: 'multipart',
    stripImagePrefix: true,
    endpointFromBaseUrl: { from: '/images/generations', to: '/images/edits' },
    template: { model: '{model}', prompt: '{prompt}', image: '{image}', n: 1 },
  },
  response: { path: 'data', urlField: 'url', base64Field: 'b64_json' },
  timeoutMs: 1000,
  retries: 1,
  extraDefaults: { response_format: 'b64_json' },
};

// ---------- P0-1：报错误透传（纯函数）----------

test('P0-1 提取：OpenAI 形状 {"error":{"message":…}} 取到 message', () => {
  assert.equal(
    describeHttpErrorBody('{"error":{"message":"Invalid image format: heic","type":"invalid_request_error"}}'),
    'Invalid image format: heic'
  );
});

test('P0-1 提取：摊平形状 {"message":…} 也取到', () => {
  assert.equal(describeHttpErrorBody('{"message":"model not found"}'), 'model not found');
});

test('P0-1 提取：F1 口径——metadata.raw 与 provider_name 一并带出', () => {
  // 聚合上游把真凶放在 metadata.raw（与 chat 链路 describeErrorPayload 同一口径）。
  const text = describeHttpErrorBody(JSON.stringify({
    error: {
      message: 'Provider returned error',
      metadata: { raw: 'response_format is not supported for gpt-image-1', provider_name: 'OpenAI' },
    },
  }));
  assert.ok(text.includes('Provider returned error'), `应含 message: ${text}`);
  assert.ok(text.includes('response_format is not supported'), `应含 metadata.raw: ${text}`);
  assert.ok(text.includes('OpenAI'), `应含 provider_name: ${text}`);
});

test('P0-1 提取：非 JSON / 空 / 非对象一律返回空串（回落到状态码文案）', () => {
  // 有意**不**把 HTML 网关错误页原样吐给用户（对用户无价值且刷屏）。
  assert.equal(describeHttpErrorBody('<html><body>502 Bad Gateway</body></html>'), '');
  assert.equal(describeHttpErrorBody(''), '');
  assert.equal(describeHttpErrorBody(null), '');
  assert.equal(describeHttpErrorBody('"just a string"'), '');
  assert.equal(describeHttpErrorBody('[1,2,3]'), '');
  assert.equal(describeHttpErrorBody('{}'), '');
});

test('P0-1 提取：超长 message 按 500 字符截断（与 F1 同一口径）', () => {
  const long = 'x'.repeat(900);
  const text = describeHttpErrorBody(JSON.stringify({ error: { message: long } }));
  assert.ok(text.length <= 501, `应截断到 500 字符附近，实际 ${text.length}`);
  assert.ok(text.endsWith('…'), '截断要有省略号');
});

test('P0-1 拼接：状态码文案在前、上游细节在后；无细节时原样返回', () => {
  const base = '生成失败（HTTP 400）';
  const composed = composeHttpErrorMessage(base, '{"error":{"message":"bad size"}}');
  assert.ok(composed.startsWith(base), '状态码文案必须在前（给出确定的分类）');
  assert.ok(composed.includes('bad size'), '上游细节要在后面');
  assert.equal(composeHttpErrorMessage(base, 'not json'), base, '无细节时不得改变文案');
  assert.equal(composeHttpErrorMessage(base, ''), base);
});

// ---------- P0-1：端到端（真跑 generateImage，mock XHR）----------

test('P0-1 端到端：HTTP 400 时最终错误文案**含上游 message**（此前只有笼统文案）', async () => {
  resetFake({
    status: 400,
    responseText: '{"error":{"message":"Invalid image format: image/heic is not supported"}}',
  });
  await assert.rejects(
    () => generateImage({ provider: relayProvider, config: { apiKey: 'k', baseUrl: relayProvider.baseUrl }, prompt: '猫' }),
    error => {
      assert.ok(/HTTP 400/.test(error.message), `应保留状态码文案: ${error.message}`);
      assert.ok(/heic is not supported/.test(error.message), `必须透传上游原因: ${error.message}`);
      return true;
    }
  );
});

test('P0-1 端到端：响应体不是 JSON 时回落到状态码文案（不吐 HTML）', async () => {
  resetFake({ status: 502, responseText: '<html>Bad Gateway</html>' });
  await assert.rejects(
    () => generateImage({ provider: relayProvider, config: { apiKey: 'k', baseUrl: relayProvider.baseUrl }, prompt: '猫' }),
    error => {
      assert.ok(/HTTP 502/.test(error.message), error.message);
      assert.equal(/<html>/.test(error.message), false, '不得把 HTML 原样透出');
      return true;
    }
  );
});

test('P0-1 回归：401/429 的分类文案与可重试标记不受影响', async () => {
  resetFake({ status: 401, responseText: '{"error":{"message":"invalid api key"}}' });
  await assert.rejects(
    () => generateImage({ provider: relayProvider, config: { apiKey: 'k', baseUrl: relayProvider.baseUrl }, prompt: '猫' }),
    error => {
      assert.equal(error.status, 401);
      assert.equal(error.retryable, false, '401 不该被标记为可重试');
      return true;
    }
  );
  resetFake({ status: 429, responseText: '{"error":{"message":"rate limited"}}' });
  await assert.rejects(
    () => generateImage({ provider: relayProvider, config: { apiKey: 'k', baseUrl: relayProvider.baseUrl }, prompt: '猫' }),
    error => {
      assert.equal(error.retryable, true, '429 必须仍可重试（分类不能因透传细节而丢）');
      return true;
    }
  );
});

// ---------- P0-2：HEIC 前置拦截 ----------

test('P0-2：HEIC/HEIF（mime 与扩展名两条路）都被拒绝', () => {
  for (const mime of ['image/heic', 'image/heif', 'IMAGE/HEIC', 'image/heic; charset=binary', 'image/heif-sequence']) {
    assert.equal(isRejectedReferenceFormat({ mime }), true, `${mime} 必须被拒`);
  }
  // 扩展名回落：部分 Android 机型给不出 mimeType，只有文件名。
  assert.equal(isRejectedReferenceFormat({ name: 'IMG_0001.HEIC' }), true);
  assert.equal(isRejectedReferenceFormat({ name: 'photo.heif' }), true);
});

test('P0-2：支持格式与其它格式不受影响（防过度拦截）', () => {
  for (const mime of I2I_SUPPORTED_MIMES) {
    assert.equal(isRejectedReferenceFormat({ mime }), false, `${mime} 不该被拦`);
  }
  assert.equal(isRejectedReferenceFormat({ mime: 'image/gif' }), false, 'gif 不在此规则内（交给上游）');
  assert.equal(isRejectedReferenceFormat({ name: 'a.png' }), false);
  assert.equal(isRejectedReferenceFormat({}), false, '无信息时不拦（不擅自拒绝）');
  // mime 存在且不是被拒格式 → 不再看扩展名（防 `photo.heic.png` 这类误伤）
  assert.equal(isRejectedReferenceFormat({ mime: 'image/png', name: 'weird.heic.png' }), false);
});

test('P0-2 接线：HEIC 检查必须在 isImageLike **之前**（否则拿不到可操作的提示）', () => {
  // 这是写接线时自己发现并修掉的一个真缺陷：isImageLike 的扩展名清单
  //（`png|jpe?g|webp|bmp|gif`）**不含 heic**，所以「只有文件名 .heic、没 mime」的图
  // 会被 isImageLike 拦下——但给的是笼统的「请选择图片文件」，用户拿不到
  // 「换 PNG/JPG」这个下一步。两种形态都该拿到可操作提示 ⇒ HEIC 检查必须在前。
  //
  // ⚠️ 这条是**源码顺序断言**，属于 AGENTS.md 允许的例外（钉住一个具体回归缺陷），
  // 不是新功能测试——行为本身已由上面的纯函数测试覆盖。
  const source = fs.readFileSync(path.resolve('src/ImageGenScreen.js'), 'utf8');
  const heicAt = source.indexOf('isRejectedReferenceFormat({ mime, name })');
  const likeAt = source.indexOf('if (!isImageLike(name, mime))');
  assert.ok(heicAt > 0, '前提：HEIC 检查存在');
  assert.ok(likeAt > 0, '前提：isImageLike 检查存在');
  assert.ok(heicAt < likeAt,
    'HEIC 检查必须在 isImageLike 之前——否则 .heic（无 mime）会落到笼统的「请选择图片文件」');
});

// ---------- P1-3：端点写法自检 ----------

test('P1-3：baseUrl 写法分流（与 endpointFromBaseUrl 同源判据）', () => {
  assert.equal(inspectImageEndpoint('https://x/v1/images/generations'), ENDPOINT_ISSUES.OK);
  assert.equal(inspectImageEndpoint('https://x/v1/images/edits'), ENDPOINT_ISSUES.EDITS_ONLY);
  assert.equal(inspectImageEndpoint('https://x/v1'), ENDPOINT_ISSUES.MISSING_IMAGES_PATH);
  assert.equal(inspectImageEndpoint('https://x'), ENDPOINT_ISSUES.MISSING_IMAGES_PATH);
  assert.equal(inspectImageEndpoint(''), ENDPOINT_ISSUES.MISSING_IMAGES_PATH);
  assert.equal(inspectImageEndpoint(null), ENDPOINT_ISSUES.MISSING_IMAGES_PATH);
});

test('P1-3 端到端：填 /v1 时**本地**报错并带正确形状（不再等远端 404）', async () => {
  resetFake({ status: 200, responseText: '{"data":[]}' });
  await assert.rejects(
    () => generateImage({ provider: relayProvider, config: { apiKey: 'k', baseUrl: 'https://relay.example.com/v1' }, prompt: '猫' }),
    error => {
      assert.ok(/images\/generations/.test(error.message), `应给出正确形状: ${error.message}`);
      return true;
    }
  );
  assert.equal(FakeXHR.instances.length, 0, '必须在**发请求之前**拦下（本地错误，不是远端 404）');
});

test('P1-3 端到端：只填 /images/edits 时，文生图本地拦、改图放行', async () => {
  resetFake({ status: 200, responseText: '{"data":[{"url":"https://x/a.png"}]}' });
  // 文生图：拦（会打到 edits 端点）
  await assert.rejects(
    () => generateImage({ provider: relayProvider, config: { apiKey: 'k', baseUrl: 'https://relay.example.com/v1/images/edits' }, prompt: '猫' }),
    error => {
      assert.ok(/images\/edits/.test(error.message), `应说明是 edits 端点: ${error.message}`);
      return true;
    }
  );
  assert.equal(FakeXHR.instances.length, 0, '文生图必须在本地拦下');
  // 改图：放行（这个地址对改图是正确的）
  resetFake({ status: 200, responseText: '{"data":[{"url":"https://x/a.png"}]}' });
  const result = await generateImage({
    provider: relayProvider,
    config: { apiKey: 'k', baseUrl: 'https://relay.example.com/v1/images/edits' },
    prompt: '改成蓝色',
    imageFile: 'data:image/png;base64,AAAA',
    imageUri: 'file:///tmp/a.png',
    imageMime: 'image/png',
  });
  assert.equal(result.images.length, 1, '改图场景下该地址是对的，不该拦');
});

test('P1-3：别家 provider（无 baseUrlSuffixes）不受此检查影响', async () => {
  resetFake({ status: 200, responseText: '{"data":[{"url":"https://x/a.png"}]}' });
  const other = {
    id: 'agnes-ai',
    baseUrl: 'https://apihub.agnes-ai.com/v1/images/generations',
    t2i: { template: { model: '{model}', prompt: '{prompt}' } },
    response: { path: 'data', urlField: 'url' },
    timeoutMs: 1000,
  };
  // 故意填一个「不含 /images/generations」的地址——无 baseUrlSuffixes ⇒ 不该本地拦。
  const result = await generateImage({ provider: other, config: { apiKey: 'k', baseUrl: 'https://apihub.agnes-ai.com/v1' }, prompt: '猫' });
  assert.equal(result.images.length, 1, '未声明 baseUrlSuffixes 的 provider 不得被误拦');
});

// ---------- P1-4：gpt-image 跳过 response_format ----------

test('P1-4：模型名判定（大小写不敏感，非 gpt-image 不跳）', () => {
  assert.equal(skipsResponseFormat('gpt-image-1'), true);
  assert.equal(skipsResponseFormat('GPT-Image-1'), true);
  assert.equal(skipsResponseFormat('openai/gpt-image-1-mini'), true);
  assert.equal(skipsResponseFormat('dall-e-3'), false);
  assert.equal(skipsResponseFormat('flux-1.1-pro'), false);
  assert.equal(skipsResponseFormat(''), false);
  assert.equal(skipsResponseFormat(undefined), false);
});

test('P1-4：withoutResponseFormat 只摘顶层键，且不改入参', () => {
  const original = { prompt: 'x', response_format: 'b64_json', nested: { response_format: 'keep' } };
  const next = withoutResponseFormat(original);
  assert.equal('response_format' in next, false, '顶层键要摘掉');
  assert.equal(next.nested.response_format, 'keep', '深层同名字段不属于本规则（不越权）');
  assert.equal(original.response_format, 'b64_json', '不得改入参');
  assert.deepEqual(withoutResponseFormat({ a: 1 }), { a: 1 }, '没有该键时原样返回');
});

test('P1-4 端到端：gpt-image-1 的 t2i 请求体不含 response_format', () => {
  const request = buildRequest({
    provider: relayProvider,
    config: { apiKey: 'k', baseUrl: relayProvider.baseUrl },
    prompt: '猫',
    model: 'gpt-image-1',
  });
  const body = JSON.parse(request.body);
  assert.equal('response_format' in body, false, `gpt-image-1 不得带 response_format: ${request.body}`);
  assert.equal(body.prompt, '猫', '其余字段照常');
});

test('P1-4 端到端：非 gpt-image 模型**保留** response_format（不得顺手改别家）', () => {
  const request = buildRequest({
    provider: relayProvider,
    config: { apiKey: 'k', baseUrl: relayProvider.baseUrl },
    prompt: '猫',
    model: 'dall-e-3',
  });
  assert.equal(JSON.parse(request.body).response_format, 'b64_json', 'dall-e-3 需要它');
});

test('P1-4：用户显式写的 response_format 不被覆盖（不替用户做决定）', () => {
  const request = buildRequest({
    provider: relayProvider,
    config: { apiKey: 'k', baseUrl: relayProvider.baseUrl, extra: { response_format: 'url' } },
    prompt: '猫',
    model: 'gpt-image-1',
  });
  // 模板带来的那个被摘掉，但用户显式写的照旧写回（那是他的明确选择）。
  assert.equal(JSON.parse(request.body).response_format, 'url');
});

// ---------- P2-5：imageUrl 通道 fail-fast ----------

test('P2-5：i2i 只给 https imageUrl 时本地 fail-fast（该通道必败）', async () => {
  resetFake({ status: 200, responseText: '{"data":[{"url":"https://x/a.png"}]}' });
  await assert.rejects(
    () => generateImage({
      provider: relayProvider,
      config: { apiKey: 'k', baseUrl: relayProvider.baseUrl },
      prompt: '改成蓝色',
      imageUrl: 'https://example.com/remote.png',
    }),
    error => {
      assert.ok(/改图/.test(error.message) || /image/i.test(error.message), error.message);
      return true;
    }
  );
  assert.equal(FakeXHR.instances.length, 0, '必须在发请求之前拦下');
});

test('P2-5：本地文件（imageUri / imageFile）照常放行——不误伤正常改图', async () => {
  resetFake({ status: 200, responseText: '{"data":[{"url":"https://x/a.png"}]}' });
  const result = await generateImage({
    provider: relayProvider,
    config: { apiKey: 'k', baseUrl: relayProvider.baseUrl },
    prompt: '改成蓝色',
    imageFile: 'data:image/png;base64,AAAA',
    imageUri: 'file:///tmp/a.png',
    imageMime: 'image/png',
  });
  assert.equal(result.images.length, 1, '本地图必须照常走');
  assert.equal(FakeXHR.instances.length, 1);
});

// ---------- P2-6：重试重建请求 ----------

test('P2-6：重试时**重建**请求体（FormData 一次性，不得复用同一实例）', async () => {
  // 用 **i2i multipart** 路径测——只有这条路径的 body 是 FormData，
  // 「复用同一实例」才是真缺陷（JSON 路径重建出的对象内容相同，复用无害）。
  // 打开自动重试 + 429（可重试）→ 第一次失败、第二次成功。
  const retryProvider = { ...relayProvider, allowAutomaticRetries: true, retries: 1 };
  FakeXHR.instances = [];
  globalThis.XMLHttpRequest = FakeXHR;
  let calls = 0;
  const realSend = FakeXHR.prototype.send;
  FakeXHR.prototype.send = function patchedSend(body) {
    calls += 1;
    this.body = body;
    if (calls === 1) {
      this.status = 429;
      this.responseText = '{"error":{"message":"rate limited"}}';
      this.onload();
      return;
    }
    this.status = 200;
    this.responseText = '{"data":[{"url":"https://x/a.png"}]}';
    this.onload();
  };
  try {
    const result = await generateImage({
      provider: retryProvider,
      config: { apiKey: 'k', baseUrl: retryProvider.baseUrl },
      prompt: '改成蓝色',
      imageFile: 'data:image/png;base64,AAAA',
      imageUri: 'file:///tmp/a.png',
      imageMime: 'image/png',
    });
    assert.equal(result.images.length, 1, '第二次应成功');
    assert.equal(calls, 2, '应真的重试了一次');
    assert.equal(typeof FakeXHR.instances[0].body.append, 'function', '前提：走的是 multipart（FormData）');
    // 关键断言：两次请求的 body 不是**同一个对象**。
    // 复用同一个 FormData 在 RN 上行为不确定（已消费的 part 可能被丢掉），
    // 那会让「重试」变成「发残缺请求」——比不重试更糟。
    assert.notEqual(FakeXHR.instances[0].body, FakeXHR.instances[1].body,
      '重试必须重建请求体（FormData 是一次性的）');
  } finally {
    FakeXHR.prototype.send = realSend;
  }
});

test('P2-6：retries=0 时只构建一次（现状行为逐字不变）', async () => {
  // 反向对照：未开自动重试时不该有多余的构建——证明上面的重建是「按需」而非「无条件」。
  resetFake({ status: 200, responseText: '{"data":[{"url":"https://x/a.png"}]}' });
  await generateImage({
    provider: relayProvider,
    config: { apiKey: 'k', baseUrl: relayProvider.baseUrl },
    prompt: '改成蓝色',
    imageFile: 'data:image/png;base64,AAAA',
    imageUri: 'file:///tmp/a.png',
    imageMime: 'image/png',
  });
  assert.equal(FakeXHR.instances.length, 1, '只发一次');
  assert.equal(typeof FakeXHR.instances[0].body.append, 'function', 'body 是 FormData');
});

test('P2-6 回归：未开自动重试时只发一次（现状 retries=0 不受影响）', async () => {
  resetFake({ status: 500, responseText: '{"error":{"message":"boom"}}' });
  await assert.rejects(
    () => generateImage({ provider: relayProvider, config: { apiKey: 'k', baseUrl: relayProvider.baseUrl }, prompt: '猫' })
  );
  assert.equal(FakeXHR.instances.length, 1, '默认不得重试付费请求');
});

// ---------- P0-1 补充：SSE 路径共用同一提取函数（注入验证发现的测试缺口）----------
//
// 这条是**注入验证逼出来的**：最初我只测了主传输路径，把 SSE 里的
// `describeHttpErrorBody(...)` 换成空串，整套测试**全绿**——说明 SSE 路径
// 当时根本没有覆盖。任务书 P0-1 明确要求「SSE 路径改用同一函数，行为不变」，
// 那就必须有测试钉住它，否则「共用」只是注释里的一句话。
test('P0-1 SSE：Local Dream 非 2xx 时也用共用提取函数（metadata.raw 要带出）', async () => {
  // Local Dream 走专用 SSE 分支；这里给一个非 SSE 的 JSON 错误体（真实后端会这么做）。
  const localDreamProvider = {
    id: 'local-dream',
    baseUrl: 'http://127.0.0.1:8081',
    method: 'POST',
    requestFormat: 'json',
    modelField: '',
    listModelsPath: '',
    localDream: true,
    probeSize: '512*512',
    t2i: { template: null },
    i2i: { template: null },
    response: {},
    timeoutMs: 1000,
    retries: 0,
  };
  resetFake({
    status: 400,
    responseText: JSON.stringify({
      error: {
        message: 'Provider returned error',
        metadata: { raw: 'metadata.raw 里的真凶：prompt too long' },
      },
    }),
  });
  await assert.rejects(
    () => generateImage({ provider: localDreamProvider, config: { baseUrl: localDreamProvider.baseUrl }, prompt: '猫' }),
    error => {
      // SSE 路径取到 detail 就用 detail（不拼状态码文案，与主路径的契约不同——见源码）。
      assert.ok(/metadata\.raw 里的真凶/.test(error.message),
        `SSE 路径必须共用同一提取函数（metadata.raw 要带出）: ${error.message}`);
      return true;
    }
  );
});

test('P0-1 SSE：取不到细节时回落到状态码文案（行为不变）', async () => {
  const localDreamProvider = {
    id: 'local-dream',
    baseUrl: 'http://127.0.0.1:8081',
    method: 'POST',
    requestFormat: 'json',
    modelField: '',
    listModelsPath: '',
    localDream: true,
    probeSize: '512*512',
    t2i: { template: null },
    i2i: { template: null },
    response: {},
    timeoutMs: 1000,
    retries: 0,
  };
  resetFake({ status: 500, responseText: '<html>boom</html>' });
  await assert.rejects(
    () => generateImage({ provider: localDreamProvider, config: { baseUrl: localDreamProvider.baseUrl }, prompt: '猫' }),
    error => {
      assert.ok(/HTTP 500/.test(error.message), `应回落到状态码文案: ${error.message}`);
      return true;
    }
  );
});

// ---------- 边界：不许顺手改的地方 ----------

test('边界：别家 provider 的 response_format 注入不受影响（只有 openai-relay 按模型跳）', () => {
  // gitee-ai 的模板里也有 response_format（providers.js L127/L142），
  // 本轮**不许**动它——这里用一个同形状的 provider 证明规则只跟着模型名走，
  // 而不是「谁有 response_format 就摘谁」。
  const giteeLike = {
    id: 'gitee-ai',
    baseUrl: 'https://ai.gitee.com/v1/images/generations',
    t2i: { template: { prompt: '{prompt}', response_format: 'b64_json' } },
    response: { path: 'data', urlField: 'url' },
    timeoutMs: 1000,
  };
  const kept = buildRequest({ provider: giteeLike, config: { apiKey: 'k' }, prompt: '猫', model: 'some-model' });
  assert.equal(JSON.parse(kept.body).response_format, 'b64_json', '普通模型照旧保留');
  // 即便在别家 provider 上填 gpt-image 模型名，规则依然只摘模板带来的那一个键
  //（这是**按模型名**的通用兼容规则，不是 openai-relay 专属分支）。
  const skipped = buildRequest({ provider: giteeLike, config: { apiKey: 'k' }, prompt: '猫', model: 'gpt-image-1' });
  assert.equal('response_format' in JSON.parse(skipped.body), false);
});

test('边界：multipart 附件白名单本身未被改动（P2-5 只是提前 fail-fast）', () => {
  // 用真实的 openai-relay i2i 路径构建 multipart，确认 file:// 仍走文件附件。
  const request = buildRequest({
    provider: relayProvider,
    config: { apiKey: 'k', baseUrl: relayProvider.baseUrl },
    prompt: '改成蓝色',
    image: 'AAAA',
    imageUri: 'file:///tmp/a.png',
    imageMime: 'image/png',
  });
  assert.equal(typeof request.body.append, 'function', 'multipart 应产出 FormData');
  // url 被换成 edits 端点（endpointFromBaseUrl 行为不变）
  assert.ok(/\/images\/edits/.test(request.url), `应换到 edits 端点: ${request.url}`);
});

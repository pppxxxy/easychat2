// 逐处回归：A1–A6 的「后缀判定必须只看路径」修复。
//
// 缺陷机理（先例：src/vectorMemory/providers.js:41-48，该域已修，是正面参考）：
//   后缀正则/endsWith 作用在**含 query 的整串**上 → 判定必然失败（结尾是 api-version）
//   → 端点被再追加一次，拼进 query 值里 → 404。
// 每处都断言**两条**：带 query 的不重复追加 + **不带 query 的常规地址行为不变**
// （后者防过度修正——修 A 不能改掉既有口径）。
//
// A2（network/api.js 的 normalizeChatUrl）与 A5（imageGen/index.js 的 listUrlFor）是
// 模块内部函数/依赖 RN 环境的模块，走 babel 编译 + Module._load 打桩直取导出。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

import { normalizeProtocolUrl } from '../src/apiProtocols/urls.js';
import { buildTranscriptionUrl } from '../src/transcription.js';
import { localDreamEndpoint } from '../src/imageGen/localDream.js';
import { createAgentClient } from '../src/agent/sdk.js';
import { splitUrlQuery } from '../src/utils/urlQuery.js';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');

function loadWithStubs(relativePath, stubs) {
  const sourcePath = path.resolve(relativePath);
  const code = babel.transformSync(fs.readFileSync(sourcePath, 'utf8'), {
    babelrc: false,
    configFile: false,
    filename: sourcePath,
    presets: [[require.resolve('@babel/preset-env'), { targets: { node: 'current' }, modules: 'commonjs' }]],
  }).code;
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    const base = String(request).split('/').pop();
    if (Object.prototype.hasOwnProperty.call(stubs, base)) return stubs[base];
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const runtime = new Module(sourcePath);
    runtime.filename = sourcePath;
    runtime.paths = Module._nodeModulePaths(path.dirname(sourcePath));
    runtime._compile(code, sourcePath);
    return runtime.exports;
  } finally {
    Module._load = originalLoad;
  }
}

// 断言「整串里只出现一个 '?api-version'」——即端点没有被追加进 query 值里。
function assertSingleQuery(url, marker) {
  const hits = String(url).split(marker).length - 1;
  assert.equal(hits, 1, `query 标记应只出现一次（端点被追加进 query 值了？）：${url}`);
}

// ---- A1：normalizeProtocolUrl（所有在线请求的唯一收口 + 主动消息）----

test('A1 normalizeProtocolUrl：带 query 的完整端点不得再追加端点', () => {
  const azure = 'https://x.openai.azure.com/openai/deployments/d/chat/completions?api-version=2024-02-01';
  const out = normalizeProtocolUrl('openai', azure);
  assert.equal(out, azure, '已是完整端点（路径以 /chat/completions 结尾）应原样返回');
  assertSingleQuery(out, '?api-version');
  assert.equal(/\/chat\/completions\?api-version=2024-02-01\/v1\/chat\/completions/.test(out), false);

  const azureV1 = 'https://x.test/v1?api-version=1';
  assert.equal(normalizeProtocolUrl('openai', azureV1), 'https://x.test/v1/chat/completions?api-version=1');
  assertSingleQuery(normalizeProtocolUrl('openai', azureV1), '?api-version');
});

test('A1 normalizeProtocolUrl：三协议带 query 的已带端点地址均幂等', () => {
  assert.equal(
    normalizeProtocolUrl('anthropic', 'https://api.anthropic.com/v1/messages?beta=1'),
    'https://api.anthropic.com/v1/messages?beta=1'
  );
  assert.equal(
    normalizeProtocolUrl('openai-responses', 'https://api.openai.com/v1/responses?api-version=1'),
    'https://api.openai.com/v1/responses?api-version=1'
  );
  assert.equal(
    normalizeProtocolUrl('anthropic', 'https://api.anthropic.com/v1?beta=1'),
    'https://api.anthropic.com/v1/messages?beta=1'
  );
});

test('A1 normalizeProtocolUrl：不带 query 的常规地址行为不变（防过度修正）', () => {
  assert.equal(normalizeProtocolUrl('openai', 'https://api.deepseek.com'), 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(normalizeProtocolUrl('openai', 'https://x.test/v1'), 'https://x.test/v1/chat/completions');
  assert.equal(normalizeProtocolUrl('openai', 'https://x.test/v1/chat/completions'), 'https://x.test/v1/chat/completions');
  assert.equal(normalizeProtocolUrl('openai', ''), 'https://api.openai.com/v1/chat/completions');
  assert.equal(normalizeProtocolUrl('openai', 'https://x.test/v1/'), 'https://x.test/v1/chat/completions');
  assert.equal(normalizeProtocolUrl('openai-responses', 'https://api.openai.com/v1'), 'https://api.openai.com/v1/responses');
  assert.equal(normalizeProtocolUrl('openai-responses', 'https://x.test/v1/responses'), 'https://x.test/v1/responses');
  assert.equal(normalizeProtocolUrl('anthropic', 'https://api.anthropic.com'), 'https://api.anthropic.com/v1/messages');
  assert.equal(normalizeProtocolUrl('anthropic', 'https://x.test/v1/messages'), 'https://x.test/v1/messages');
});

// ---- A2：normalizeChatUrl（设置页模型清单探测；与 A1 必须同口径）----

const apiModule = loadWithStubs('src/network/api.js', {
  'apiConfigs.js': {
    DEFAULT_MAX_OUTPUT_TOKENS: 32000,
    getActiveApiConfig: async () => ({}),
    getActiveModel: () => '',
    getApiConfigs: async () => [],
    capabilitiesForModel: () => ({}),
  },
  'settings.js': { getSamplingSettings: async () => ({}), getThinkingSettings: async () => ({}) },
  'secrets.js': { registerSecretValues: () => {} },
  'diagnostics.js': { recordDiagnostic: () => {} },
});

test('A2 normalizeChatUrl：带 query 的完整端点不得再追加端点', () => {
  const azure = 'https://x.openai.azure.com/openai/deployments/d/chat/completions?api-version=2024-02-01';
  assert.equal(apiModule.normalizeChatUrl(azure), azure);
  assertSingleQuery(apiModule.normalizeChatUrl(azure), '?api-version');
  assert.equal(apiModule.normalizeChatUrl('https://x.test/v1?api-version=1'), 'https://x.test/v1/chat/completions?api-version=1');
});

test('A2 normalizeChatUrl：不带 query 的常规地址行为不变（防过度修正）', () => {
  assert.equal(apiModule.normalizeChatUrl('https://api.deepseek.com'), 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(apiModule.normalizeChatUrl('https://x.test/v1'), 'https://x.test/v1/chat/completions');
  assert.equal(apiModule.normalizeChatUrl('https://x.test/v1/chat/completions'), 'https://x.test/v1/chat/completions');
  assert.equal(apiModule.normalizeChatUrl(''), 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(apiModule.normalizeChatUrl('  https://x.test/v1/  '), 'https://x.test/v1/chat/completions');
});

// ---- A3：buildTranscriptionUrl ----

test('A3 buildTranscriptionUrl：带 query 的 chat 端点不得把转写端点追加进 query', () => {
  const out = buildTranscriptionUrl('https://x.test/v1/chat/completions?api-version=1');
  assert.equal(out, 'https://x.test/v1/audio/transcriptions?api-version=1');
  assertSingleQuery(out, '?api-version');
  // 已是转写端点 + query：幂等
  assert.equal(
    buildTranscriptionUrl('https://api.openai.com/v1/audio/transcriptions?api-version=1'),
    'https://api.openai.com/v1/audio/transcriptions?api-version=1'
  );
});

test('A3 buildTranscriptionUrl：不带 query 的常规地址行为不变（防过度修正）', () => {
  assert.equal(buildTranscriptionUrl('https://api.deepseek.com/v1/chat/completions'), 'https://api.deepseek.com/v1/audio/transcriptions');
  assert.equal(buildTranscriptionUrl('https://api.deepseek.com/v1'), 'https://api.deepseek.com/v1/audio/transcriptions');
  assert.equal(buildTranscriptionUrl('https://api.deepseek.com'), 'https://api.deepseek.com/v1/audio/transcriptions');
  assert.equal(buildTranscriptionUrl('https://api.openai.com/v1/audio/transcriptions'), 'https://api.openai.com/v1/audio/transcriptions');
});

// ---- A4：localDreamEndpoint ----

test('A4 localDreamEndpoint：带 query 的地址不得再追加 path', () => {
  const out = localDreamEndpoint('http://127.0.0.1:8081/generate?api-version=1', '/generate');
  assert.equal(out, 'http://127.0.0.1:8081/generate?api-version=1');
  assertSingleQuery(out, '?api-version');
  // 根地址 + query：path 追加在 query 之前
  assert.equal(
    localDreamEndpoint('http://127.0.0.1:8081?token=1', '/generate'),
    'http://127.0.0.1:8081/generate?token=1'
  );
});

test('A4 localDreamEndpoint：不带 query 的常规地址行为不变（防过度修正）', () => {
  assert.equal(localDreamEndpoint('', '/generate'), 'http://127.0.0.1:8081/generate');
  assert.equal(localDreamEndpoint('http://127.0.0.1:8081', '/generate'), 'http://127.0.0.1:8081/generate');
  assert.equal(localDreamEndpoint('http://127.0.0.1:8081/', '/generate'), 'http://127.0.0.1:8081/generate');
  assert.equal(localDreamEndpoint('http://127.0.0.1:8081/generate', '/generate'), 'http://127.0.0.1:8081/generate');
  assert.equal(localDreamEndpoint('http://192.168.1.5:8081', '/tokenize'), 'http://192.168.1.5:8081/tokenize');
});

// ---- A5：listUrlFor 的 custom 分支（同函数内两口径对齐）----

// 只打桩密钥登记（真实 vendorHttp 会走 globalThis.XMLHttpRequest，由各用例自行替换）。
const imageGenModule = loadWithStubs('src/imageGen/index.js', {
  'secrets.js': { registerSecretValues: () => {} },
});

// 复用真实 provider 目录里的 custom 条目（openai-relay：listModelsPath '/models'、
// baseUrlSuffixes ['/images/generations', '/images/edits']）。
const { getImageProvider } = await import('../src/imageGen/providers.js');
const customProvider = getImageProvider('openai-relay');
const builtinProvider = getImageProvider('google-ai-studio');

// 走真实 listModels（内部即 listUrlFor），用打桩 XHR 记录最终 URL——
// 比正则切片源码更能证明「真实拼接结果」。
async function captureListUrl(provider, baseUrl) {
  const seen = [];
  class CapturingXHR {
    open(method, url) { this.url = url; seen.push(url); }
    setRequestHeader() {}
    send() {
      this.status = 200;
      this.responseText = JSON.stringify({ data: [{ id: 'm' }] });
      this.onload();
    }
    abort() {}
  }
  const originalXHR = globalThis.XMLHttpRequest;
  globalThis.XMLHttpRequest = CapturingXHR;
  try {
    await imageGenModule.listModels({ provider, config: { baseUrl, apiKey: 'k' } });
  } finally {
    globalThis.XMLHttpRequest = originalXHR;
  }
  assert.equal(seen.length, 1, `每次探测应只发一个请求：${seen.join(' , ')}`);
  return seen[0];
}

test('A5 listUrlFor custom 分支：带 query 时后缀剥离仍然生效，端点不得被追加进 query', async () => {
  const url = await captureListUrl(customProvider, 'https://relay.test/v1/images/generations?api-version=1');
  // custom 分支：剥掉 /images/generations 后接 /models，且 query 不得进入路径判定
  assert.equal(url, 'https://relay.test/v1/models');
  assert.equal(url.includes('api-version'), false, 'query 不得残留在模型清单 URL 里');
});

test('A5 listUrlFor：custom 与非 custom 分支对同一输入的路径部分一致（同函数两口径）', async () => {
  // 两分支的判定基准必须**同一个** path（splitUrlQuery 的结果），query 一律不参与：
  //   custom     → stripKnownSuffix(path) + listModelsPath
  //   非 custom  → originOf(path)        + listModelsPath
  // 此前 custom 拿的是含 query 的整串，非 custom 经 originOf 天然切掉 query ⇒ 同函数两口径。
  // 这里用**同一个** input 同时驱动两分支，断言两件事：
  //   ① 各自对「带 query」与「去掉 query」的输出完全相同（query 不参与判定）；
  //   ② 两分支的产物都是 path 的派生（都不含 query 值）。
  const input = 'https://relay.test/v1/images/generations?api-version=1';
  const { path: pathOnly } = splitUrlQuery(input);
  assert.equal(pathOnly, 'https://relay.test/v1/images/generations');

  const customWithQuery = await captureListUrl(customProvider, input);
  const customWithoutQuery = await captureListUrl(customProvider, pathOnly);
  const builtinWithQuery = await captureListUrl(builtinProvider, 'https://relay.test/v1?api-version=1');
  const builtinWithoutQuery = await captureListUrl(builtinProvider, 'https://relay.test/v1');

  // ① query 的有无不影响任一分支的结果
  assert.equal(customWithQuery, customWithoutQuery, 'custom 分支的结果不得随 query 变化');
  assert.equal(builtinWithQuery, builtinWithoutQuery, '非 custom 分支的结果不得随 query 变化');

  // ② 两分支都只从 path 派生，产物里不得残留 query 值
  assert.equal(customWithQuery, 'https://relay.test/v1/models');
  assert.equal(builtinWithQuery, 'https://relay.test/v1beta/models');
  assert.equal(customWithQuery.includes('api-version'), false);
  assert.equal(builtinWithQuery.includes('api-version'), false);
  // 两分支的产物都指向同一个 origin，且都以各自的 listModelsPath 结尾（路径部分同源）
  assert.equal(new URL(customWithQuery).origin, new URL(builtinWithQuery).origin);
  assert.equal(new URL(customWithQuery).pathname, customProvider.listModelsPath === '/models' ? '/v1/models' : '');
  assert.equal(new URL(builtinWithQuery).pathname, builtinProvider.listModelsPath);
});

test('A5 listUrlFor custom 分支：不带 query 的常规地址行为不变（防过度修正）', async () => {
  assert.equal(
    await captureListUrl(customProvider, 'https://relay.test/v1/images/generations'),
    'https://relay.test/v1/models',
    '剥掉 /images/generations 后缀'
  );
  assert.equal(
    await captureListUrl(customProvider, 'https://relay.test/v1'),
    'https://relay.test/v1/models',
    '无后缀时原样接 /models'
  );
});

// ---- A6：createAgentClient 的 URL 拼接 ----

function capturingClient(baseUrl) {
  const calls = [];
  const client = createAgentClient({
    baseUrl,
    apiKey: 'k',
    fetchImpl: async (url, options) => {
      calls.push({ url, method: (options && options.method) || 'GET' });
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        body: { getReader: () => ({ read: async () => ({ done: true, value: undefined }) }) },
      };
    },
  });
  return { client, calls };
}

test('A6 createAgentClient：baseUrl 已含 /v1 或完整端点时不得重复拼接', async () => {
  // 最脆的一处：此前**连后缀判定都没有**，无条件追加 /v1/... → 重复拼接。
  for (const baseUrl of [
    'http://127.0.0.1:8686/v1',
    'http://127.0.0.1:8686/v1/',
    'http://127.0.0.1:8686/v1/chat/completions',
    'http://127.0.0.1:8686/v1/models',
    'http://127.0.0.1:8686/v1/agent',
  ]) {
    const { client, calls } = capturingClient(baseUrl);
    assert.equal(client.baseUrl, 'http://127.0.0.1:8686', `baseUrl 应归一到根：${baseUrl}`);
    await client.listModels();
    await client.runAgent({ prompt: 'p' });
    await client.streamChat({ messages: [] });
    assert.equal(calls[0].url, 'http://127.0.0.1:8686/v1/models');
    assert.equal(calls[1].url, 'http://127.0.0.1:8686/v1/agent');
    assert.equal(calls[2].url, 'http://127.0.0.1:8686/v1/chat/completions');
    assert.equal(/\/v1\/v1\//.test(calls.map(c => c.url).join(' ')), false, '不得出现 /v1/v1 重复拼接');
  }
});

test('A6 createAgentClient：带 query 时 query 原样保留且不参与后缀判定', async () => {
  const { client, calls } = capturingClient('http://127.0.0.1:8686/v1/chat/completions?api-version=1');
  assert.equal(client.baseUrl, 'http://127.0.0.1:8686');
  await client.listModels();
  assert.equal(calls[0].url, 'http://127.0.0.1:8686/v1/models?api-version=1');
  assertSingleQuery(calls[0].url, '?api-version');
});

test('A6 createAgentClient：不带 query 的常规地址行为不变（防过度修正）', async () => {
  const { client, calls } = capturingClient('http://127.0.0.1:8686/');
  assert.equal(client.baseUrl, 'http://127.0.0.1:8686');
  await client.listModels();
  await client.runAgent({ prompt: 'p' });
  await client.streamChat({ messages: [] });
  assert.deepEqual(calls.map(c => c.url), [
    'http://127.0.0.1:8686/v1/models',
    'http://127.0.0.1:8686/v1/agent',
    'http://127.0.0.1:8686/v1/chat/completions',
  ]);
  assert.equal(calls[1].method, 'POST');

  // 默认 baseUrl 行为不变
  const fallback = capturingClient(undefined);
  assert.equal(fallback.client.baseUrl, 'http://127.0.0.1:8686');
});

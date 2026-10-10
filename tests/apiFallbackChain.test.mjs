// P0-7 降级链**接线**测试（下半）：判定层的纯函数测试在 fallbackModels.test.mjs，
// 这里跑真实的 src/network/api.js（只打桩存储层与 XMLHttpRequest），断言
// 「换模型重试真的发生」以及「不该重试时一次都不多发」——这是接线最容易被写错的两端。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const sourcePath = path.resolve('src/network/api.js');
const transformed = babel.transformSync(fs.readFileSync(sourcePath, 'utf8'), {
  babelrc: false,
  configFile: false,
  filename: sourcePath,
  presets: [[require.resolve('@babel/preset-env'), { targets: { node: 'current' }, modules: 'commonjs' }]],
}).code;

let activeConfig = {
  id: 'cfg-1',
  baseUrl: 'https://example.test/v1',
  activeModel: 'model-a',
  fallbackModels: ['model-b'],
  apiKey: 'key-12345678',
  authHeader: 'Authorization',
  authScheme: 'Bearer ',
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  const base = String(request).split('/').pop();
  if (base === 'storage.js' || base === 'apiConfigs.js' || base === 'settings.js') {
    return {
      getActiveApiConfig: async () => activeConfig,
      getActiveModel: config => String((config && config.activeModel) || ''),
      // 与 storage/apiConfigs.capabilitiesForModel 同构的桩：按**模型名**解析能力。
      // 真实现的归一/迁移覆盖在 apiConfig.test.mjs。
      capabilitiesForModel: (config, model) => {
        const entry = (config && config.modelCapabilities && config.modelCapabilities[String(model || '')]) || {};
        return {
          supportsThinking: entry.supportsThinking === true,
          thinkingField: String(entry.thinkingField || 'reasoning_effort'),
          thinkingFormat: entry.thinkingFormat || 'effort',
          supportsVision: entry.supportsVision === true,
          supportsVideo: entry.supportsVideo === true,
          supportsAudio: entry.supportsAudio === true,
          contextWindow: Math.max(0, Math.floor(Number(entry.contextWindow)) || 0),
          maxOutput: Math.max(0, Math.floor(Number(entry.maxOutput)) || 0),
          customParams: entry.customParams === true,
        };
      },
      getSamplingSettings: async () => ({}),
      getThinkingSettings: async () => ({ enabled: false }),
    };
  }
  if (base === 'secrets.js') return { registerSecretValues: () => {} };
  if (base === 'diagnostics.js') return { recordDiagnostic: () => {} };
  return originalLoad.call(this, request, parent, isMain);
};

function loadApi() {
  const filename = path.resolve('src/network/api.js');
  const runtimeModule = new Module(filename);
  runtimeModule.filename = filename;
  runtimeModule.paths = Module._nodeModulePaths(path.dirname(filename));
  runtimeModule._compile(transformed, filename);
  return runtimeModule.exports;
}

const OK_SSE = 'data: {"choices":[{"delta":{"content":"你好"}}]}\n\ndata: [DONE]\n\n';
// 只吐半句、没有 [DONE]：用于「已产出后再失败」的场景。
const HALF_SSE = 'data: {"choices":[{"delta":{"content":"半句"}}]}\n\n';

// 按脚本应答的 XHR：每次 send() 消费一个 step，并记录请求体（断言换的是哪个模型）。
class ScriptedXHR {
  static steps = [];
  static bodies = [];
  static instances = [];
  constructor() {
    this.status = 200;
    this.responseText = '';
    this.aborted = false;
    ScriptedXHR.instances.push(this);
  }
  open() {}
  setRequestHeader() {}
  send(body) {
    ScriptedXHR.bodies.push(JSON.parse(body));
    const step = ScriptedXHR.steps.shift() || { kind: 'ok' };
    queueMicrotask(() => {
      if (step.kind === 'ok') {
        this.status = 200;
        this.responseText = step.sse === undefined ? OK_SSE : step.sse;
        if (this.onprogress) this.onprogress();
        if (this.onload) this.onload();
        return;
      }
      if (step.kind === 'http') {
        this.status = step.status;
        this.responseText = JSON.stringify({ error: { message: `HTTP ${step.status}` } });
        if (this.onload) this.onload();
        return;
      }
      if (step.kind === 'emit-then-http') {
        this.status = 200;
        this.responseText = step.sse || HALF_SSE;
        if (this.onprogress) this.onprogress();
        this.status = step.status;
        this.responseText = JSON.stringify({ error: { message: `HTTP ${step.status}` } });
        if (this.onload) this.onload();
        return;
      }
      if (step.kind === 'network') {
        if (this.onerror) this.onerror();
        return;
      }
      // 'hang'：什么都不做（等测试自己 abort）。
    });
  }
  abort() {
    this.aborted = true;
    if (this.onabort) this.onabort();
  }
}

function withXhr(steps, run) {
  return async () => {
    const originalXHR = globalThis.XMLHttpRequest;
    ScriptedXHR.steps = steps.slice();
    ScriptedXHR.bodies = [];
    ScriptedXHR.instances = [];
    globalThis.XMLHttpRequest = ScriptedXHR;
    try {
      return await run();
    } finally {
      globalThis.XMLHttpRequest = originalXHR;
      ScriptedXHR.steps = [];
    }
  };
}

function setConfig(patch) {
  const previous = activeConfig;
  activeConfig = { ...activeConfig, ...patch };
  return () => {
    activeConfig = previous;
  };
}

const MESSAGES = [{ role: 'user', content: 'hi' }];

test('429 后换用降级模型重试，并把「已切换到 X」告知宿主', withXhr(
  [{ kind: 'http', status: 429 }, { kind: 'ok' }],
  async () => {
    const restore = setConfig({ activeModel: 'model-a', fallbackModels: ['model-b'] });
    try {
      const { streamChatCompletion } = loadApi();
      const notices = [];
      const chunks = [];
      const result = await streamChatCompletion(MESSAGES, {
        onChunk: text => chunks.push(text),
        onModelFallback: info => notices.push(info),
      });
      assert.equal(result.text, '你好', '回复来自降级模型');
      assert.deepEqual(
        ScriptedXHR.bodies.map(item => item.model),
        ['model-a', 'model-b'],
        '第一次主模型，第二次降级模型'
      );
      assert.equal(notices.length, 1, '换模型必须通知宿主（不能静默）');
      assert.equal(notices[0].from, 'model-a');
      assert.equal(notices[0].to, 'model-b');
      assert.equal(notices[0].reason, 'HTTP 429', '原因用可判定字段摘要，不靠文案匹配');
      assert.deepEqual(chunks, ['你好'], '只上抛降级模型的产出，不重不漏');
    } finally {
      restore();
    }
  }
));

test('网络不可达同样降级；链走完仍失败时把最后一个错误抛给调用方', withXhr(
  [{ kind: 'network' }, { kind: 'http', status: 503 }],
  async () => {
    const restore = setConfig({ activeModel: 'model-a', fallbackModels: ['model-b'] });
    try {
      const { streamChatCompletion } = loadApi();
      const notices = [];
      await assert.rejects(
        streamChatCompletion(MESSAGES, { onModelFallback: info => notices.push(info) }),
        /HTTP 503/
      );
      assert.deepEqual(
        ScriptedXHR.bodies.map(item => item.model),
        ['model-a', 'model-b'],
        '断网 → 降级；降级模型 5xx → 链尾，不再重试'
      );
      assert.equal(notices.length, 1);
      assert.equal(notices[0].reason, 'network');
    } finally {
      restore();
    }
  }
));

test('已产出内容后失败绝不换模型（否则用户会看到两段拼接的回复）', withXhr(
  [{ kind: 'emit-then-http', status: 500 }],
  async () => {
    const restore = setConfig({ activeModel: 'model-a', fallbackModels: ['model-b'] });
    try {
      const { streamChatCompletion } = loadApi();
      const notices = [];
      const chunks = [];
      await assert.rejects(
        streamChatCompletion(MESSAGES, {
          onChunk: text => chunks.push(text),
          onModelFallback: info => notices.push(info),
        }),
        /HTTP 500/
      );
      assert.equal(ScriptedXHR.bodies.length, 1, '已经吐字了就不再发第二次请求');
      assert.equal(notices.length, 0);
      assert.deepEqual(chunks, ['半句'], '已产出的半句保持原样，不做拼接');
    } finally {
      restore();
    }
  }
));

test('确定性失败（401）不换模型：换了还是同一个错，只是白花额度', withXhr(
  [{ kind: 'http', status: 401 }],
  async () => {
    const restore = setConfig({ activeModel: 'model-a', fallbackModels: ['model-b', 'model-c'] });
    try {
      const { streamChatCompletion } = loadApi();
      const notices = [];
      await assert.rejects(
        streamChatCompletion(MESSAGES, { onModelFallback: info => notices.push(info) }),
        /HTTP 401/
      );
      assert.equal(ScriptedXHR.bodies.length, 1);
      assert.equal(notices.length, 0);
    } finally {
      restore();
    }
  }
));

test('用户中断不降级：AbortError 原样抛出，且不再发请求', withXhr(
  [{ kind: 'hang' }],
  async () => {
    const restore = setConfig({ activeModel: 'model-a', fallbackModels: ['model-b'] });
    try {
      const { streamChatCompletion } = loadApi();
      const notices = [];
      const controller = new AbortController();
      const pending = streamChatCompletion(MESSAGES, {
        signal: controller.signal,
        onModelFallback: info => notices.push(info),
      });
      await new Promise(resolve => setImmediate(resolve));
      controller.abort();
      await assert.rejects(pending, error => error && error.name === 'AbortError');
      assert.equal(ScriptedXHR.bodies.length, 1, '用户按了停止就是停止，不是失败');
      assert.equal(notices.length, 0);
    } finally {
      restore();
    }
  }
));

test('没配降级模型时链长为 1：5xx 也只请求一次（与接线前完全一致）', withXhr(
  [{ kind: 'http', status: 503 }],
  async () => {
    const restore = setConfig({ activeModel: 'model-a', fallbackModels: [] });
    try {
      const { streamChatCompletion } = loadApi();
      await assert.rejects(streamChatCompletion(MESSAGES), /HTTP 503/);
      assert.equal(ScriptedXHR.bodies.length, 1);
    } finally {
      restore();
    }
  }
));

test('降级后按新模型重算能力：不把主模型的输出预算带过去', withXhr(
  [{ kind: 'http', status: 500 }, { kind: 'ok' }],
  async () => {
    const restore = setConfig({
      activeModel: 'model-a',
      fallbackModels: ['model-b'],
      // 只有主模型声明了自定义参数；降级模型没有条目 = 未确认 = 不自定义。
      modelCapabilities: { 'model-a': { customParams: true, maxOutput: 8192 } },
    });
    try {
      const { streamChatCompletion } = loadApi();
      await streamChatCompletion(MESSAGES);
      assert.equal(ScriptedXHR.bodies[0].max_tokens, 8192, '主模型按自定义输出长度发送');
      assert.equal(
        'max_tokens' in ScriptedXHR.bodies[1],
        false,
        '降级模型未声明自定义参数 → 不带主模型的 8192（否则是静默串味）'
      );
    } finally {
      restore();
    }
  }
));

test('降级链会去重并限量：同名不重复试、最多 3 个', withXhr(
  [{ kind: 'http', status: 500 }, { kind: 'http', status: 500 }, { kind: 'http', status: 500 }],
  async () => {
    const restore = setConfig({
      activeModel: 'model-a',
      fallbackModels: ['model-a', 'model-b', 'model-c', 'model-d'],
    });
    try {
      const { streamChatCompletion } = loadApi();
      await assert.rejects(streamChatCompletion(MESSAGES), /HTTP 500/);
      assert.deepEqual(
        ScriptedXHR.bodies.map(item => item.model),
        ['model-a', 'model-b', 'model-c'],
        '主模型同名项不重复试，第四个降级项被上限截掉'
      );
    } finally {
      restore();
    }
  }
));

test('onModelFallback 抛错不打断重试（信息性回调不得影响主链路）', withXhr(
  [{ kind: 'http', status: 429 }, { kind: 'ok' }],
  async () => {
    const restore = setConfig({ activeModel: 'model-a', fallbackModels: ['model-b'] });
    try {
      const { streamChatCompletion } = loadApi();
      const result = await streamChatCompletion(MESSAGES, {
        onModelFallback: () => {
          throw new Error('宿主回调炸了');
        },
      });
      assert.equal(result.text, '你好', '回调抛错被吞掉，重试照常完成');
      assert.equal(ScriptedXHR.bodies.length, 2);
    } finally {
      restore();
    }
  }
));

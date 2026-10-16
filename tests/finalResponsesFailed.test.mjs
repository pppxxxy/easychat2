// 稳健性小修包 P0：非流式终稿解析缺 status==='failed' 分支（竞品警示 #6）。
//
// 缺陷：Responses API 失败时响应体带 status:'failed'（如工具调用中途出错）。此前只有
// 'incomplete' 分支，failed 体会照常返回 text:'' + finishReason:'stop'，上游把**失败**
// 当成**正常空回复**呈现（还会记账、写总结、朗读）。
//
// 本文件钉两层：
//   ① 纯函数层（errors/final）：失败必须被识别，且**不能**被误判成成功空回复；
//   ② 集成层（真 api.js + FakeXHR）：端到端确认失败以 error 暴露、原因不被笼统文案吃掉。
// 集成层的 FakeXHR/模块桩沿用 tests/apiStreaming.test.mjs 的既有做法。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

import { getActiveLocale, setActiveLocale, translate } from '../src/i18n/index.js';
import { parseFinalPayload } from '../src/apiProtocols.js';
import { parseProtocolError } from '../src/apiProtocols/errors.js';

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
  apiKey: 'key-12345678',
  authHeader: 'Authorization',
  authScheme: 'Bearer ',
  // 本文件针对 openai-responses 协议：不声明它会被按 openai 解析（choices 为空 → 空回复），
  // 那样测的就不是本案的路径了。
  protocol: 'openai-responses',
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  const base = String(request).split('/').pop();
  if (base === 'storage.js' || base === 'apiConfigs.js' || base === 'settings.js') {
    return {
      getActiveApiConfig: async () => activeConfig,
      getActiveModel: config => config.activeModel,
      capabilitiesForModel: () => ({
        supportsThinking: false,
        thinkingField: 'reasoning_effort',
        thinkingFormat: 'effort',
        supportsVision: false,
        supportsVideo: false,
        supportsAudio: false,
      }),
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

class FakeXHR {
  static last = null;
  static responseText = '';
  static status = 200;
  static autoRespond = true;
  constructor() {
    this.aborted = false;
    this.status = 0;
    this.responseText = '';
    FakeXHR.last = this;
  }
  open() {}
  setRequestHeader() {}
  send(body) {
    this.body = body;
    this.responseText = FakeXHR.responseText;
    this.status = FakeXHR.status;
    if (FakeXHR.autoRespond) {
      queueMicrotask(() => {
        if (this.onprogress) this.onprogress();
        if (this.onload) this.onload();
      });
    }
  }
  abort() {
    this.aborted = true;
    if (this.onabort) this.onabort();
  }
}

// 用真 api.js 的非流式路径发一次请求，返回 { status, reply } 或 { status:'error', message }。
async function sendNonStream(responseText, status = 200) {
  const originalXHR = globalThis.XMLHttpRequest;
  globalThis.XMLHttpRequest = FakeXHR;
  FakeXHR.responseText = responseText;
  FakeXHR.status = status;
  FakeXHR.autoRespond = true;
  try {
    const { sendChatMessage } = loadApi();
    const reply = await sendChatMessage(
      [{ role: 'user', content: 'hi' }],
      { stream: false, config: activeConfig }
    );
    return { status: 'ok', reply };
  } catch (error) {
    return { status: 'error', message: String((error && error.message) || error) };
  } finally {
    globalThis.XMLHttpRequest = originalXHR;
  }
}

const failedBody = extra => JSON.stringify({ status: 'failed', output: [], ...extra });

test('P0 纯函数：failed 体必须被识别为失败，不能当成功空回复', () => {
  const failed = parseFinalPayload('openai-responses', { status: 'failed', output: [] });
  // 关键不变量：只要 status==='failed'，就必须带出 error（消费方据此抛错），
  // 而不是安静地返回可被当作「空回复」的结果。
  assert.ok(failed.error, 'status=failed 必须带 error 哨兵，否则失败会被当成正常空回复');
});

test('P0：failed 体提取 error.message 作为原因（具体原因优先）', () => {
  const message = parseProtocolError('openai-responses', {
    status: 'failed',
    error: { message: 'Tool call failed mid-turn' },
  });
  assert.equal(message, 'Tool call failed mid-turn');
});

test('P0：failed 体只有 code 时也要有原因（不能落空）', () => {
  const message = parseProtocolError('openai-responses', { status: 'failed', error: { code: 'server_error' } });
  assert.equal(message, 'server_error');
});

test('P0：failed 但没给可读原因（null/缺失/空对象）必须兜底成明确失败，不能返回空串', () => {
  const previous = getActiveLocale();
  try {
    const zh = translate('zh-CN', 'error.api.responseStatusFailed');
    setActiveLocale('zh-CN');
    for (const payload of [
      { status: 'failed' },
      { status: 'failed', error: null },
      { status: 'failed', error: {} },
    ]) {
      const message = parseProtocolError('openai-responses', payload);
      assert.equal(message, zh, `payload=${JSON.stringify(payload)} 必须判为失败而不是「没有错误」`);
    }
  } finally {
    setActiveLocale(previous);
  }
});

test('P0：兜底文案跟随语言（英文界面不得冒中文）', () => {
  const previous = getActiveLocale();
  try {
    const en = translate('en', 'error.api.responseStatusFailed');
    setActiveLocale('en');
    assert.equal(parseProtocolError('openai-responses', { status: 'failed' }), en);
    // parseFinalPayload 也走同一词条（两条实现路径文案一致）
    assert.equal(parseFinalPayload('openai-responses', { status: 'failed' }).error, en);
  } finally {
    setActiveLocale(previous);
  }
});

test('P0 不回归：completed 正常结果不受影响（无 error 哨兵）', () => {
  const done = parseFinalPayload('openai-responses', {
    status: 'completed',
    output: [{ type: 'message', content: [{ type: 'output_text', text: '正常回复' }] }],
  });
  assert.equal(done.text, '正常回复');
  assert.equal(done.finishReason, 'stop');
  assert.equal(done.error, undefined, '正常完成不得带 error');
});

test('P0 不回归：incomplete（截断）仍是 length，不当失败', () => {
  const truncated = parseFinalPayload('openai-responses', {
    status: 'incomplete',
    incomplete_details: { reason: 'max_output_tokens' },
    output: [{ type: 'message', content: [{ type: 'output_text', text: '半截' }] }],
  });
  assert.equal(truncated.finishReason, 'length');
  assert.equal(truncated.error, undefined, '截断是正常终止，不是失败');
  assert.equal(truncated.text, '半截', '截断必须保留已产出内容');

  const other = parseFinalPayload('openai-responses', { status: 'incomplete', output: [] });
  assert.equal(other.finishReason, 'stop');
  assert.equal(other.error, undefined);
});

test('P0 不回归：failed 之前已读出的内容仍带在结果里（供上层决定是否保留）', () => {
  const failed = parseFinalPayload('openai-responses', {
    status: 'failed',
    output: [
      { type: 'reasoning', summary: [{ text: '想过' }] },
      { type: 'message', content: [{ type: 'output_text', text: '半句' }] },
    ],
  });
  assert.equal(failed.reasoning, '想过');
  assert.equal(failed.text, '半句');
  assert.ok(failed.error);
});

test('P0 不回归：openai / anthropic 两协议结果形状不变', () => {
  const oa = parseFinalPayload('openai', { choices: [{ message: { content: '嗨' }, finish_reason: 'stop' }] });
  assert.equal(oa.text, '嗨');
  assert.equal(oa.error, undefined);
  const anthropic = parseFinalPayload('anthropic', {
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: '好' }],
  });
  assert.equal(anthropic.text, '好');
  assert.equal(anthropic.error, undefined);
});

// ---- 集成层：真 api.js 非流式路径 -------------------------------------

test('P0 集成：failed 体在聊天路径上报失败，而不是返回「没有收到回复」', async () => {
  const result = await sendNonStream(failedBody({ error: { message: 'Tool call failed mid-turn' } }));
  assert.equal(result.status, 'error', 'failed 必须走失败路径（此前会被当成功空回复）');
  assert.equal(result.message, 'Tool call failed mid-turn', '具体原因必须带到错误气泡，不能被换成笼统文案');
});

test('P0 集成：failed 且无可读原因时给出明确失败文案（不是空回复）', async () => {
  const result = await sendNonStream(failedBody({ error: null }));
  assert.equal(result.status, 'error');
  assert.notEqual(result.message, '没有收到回复。', '失败不得伪装成正常空回复');
});

test('P0 集成：HTTP 200 + failed 不再被当成空回复记账', async () => {
  // 回归的是「失败被静默降级成成功」这条：只要不 resolve，上层就不会 recordStats/写总结。
  const result = await sendNonStream(failedBody({}));
  assert.equal(result.status, 'error');
});

test('P0 集成不回归：completed 体正常 resolve 出正文', async () => {
  const body = JSON.stringify({
    status: 'completed',
    output: [{ type: 'message', content: [{ type: 'output_text', text: '正常回复' }] }],
  });
  const result = await sendNonStream(body);
  assert.equal(result.status, 'ok', '正常完成必须 resolve，不得被误判成失败');
  assert.equal(result.reply, '正常回复');
});

test('P0 集成不回归：incomplete 截断体正常 resolve（不当失败）', async () => {
  const body = JSON.stringify({
    status: 'incomplete',
    incomplete_details: { reason: 'max_output_tokens' },
    output: [{ type: 'message', content: [{ type: 'output_text', text: '半截' }] }],
  });
  const result = await sendNonStream(body);
  assert.equal(result.status, 'ok', '截断是正常终止，不是失败：不得走错误路径');
  assert.equal(result.reply, '半截');
});

// ---- P2：只思考不说话的呈现区分（调研结论 = 现状已可，不改行为）---------
// 竞品 v2.10.0 把「只思考没输出」从「思考中断」改叫「思考终止」。本仓**从未**有过这两个
// 词条，且两条路径本就结构可分：用户中止 → settlePendingMessage 落「（未生成正文）」；
// 非中止（服务端只给了思考就收尾）→ replyFlow 落「没有收到回复。」。
// 而推理内容本身由 MessageBubble.js:362 的 reasoning 块渲染（用户可见、可展开），
// 所以用户看到的是「思考内容 + 一句无正文说明」，既不是空白气泡也不是笼统报错 ——
// 符合任务书「若已有合理区分（如显示思考内容本身）→ 记录现状已可，不改」。
// 这两条断言把结论钉成可执行事实：将来若有人把两条路径合并成同一句文案，会在这里变红。
test('P2 结论：中止与非中止的「无正文」文案是两句不同的话（现状已可，不改）', () => {
  const previous = getActiveLocale();
  try {
    setActiveLocale('zh-CN');
    const interrupted = translate('zh-CN', 'chat.noBody');
    const notReceived = translate('zh-CN', 'chat.send.noReply');
    assert.notEqual(
      interrupted,
      notReceived,
      '中止（未生成正文）与非中止（没有收到回复）必须是可区分的两句：这是本仓既有的结构区分',
    );
    assert.equal(interrupted, '（未生成正文）');
    assert.equal(notReceived, '没有收到回复。');
  } finally {
    setActiveLocale(previous);
  }
});

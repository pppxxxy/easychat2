import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_TRANSCRIPTION_MODEL,
  buildTranscriptionUrl,
  normalizeTranscriptionConfig,
  resolveTranscription,
  isUnsupportedTranscriptionError,
  transcribeAudio,
} from '../src/transcription.js';

test('buildTranscriptionUrl：去掉 chat/completions 后缀，固定到 /v1/audio/transcriptions', () => {
  assert.equal(
    buildTranscriptionUrl('https://api.deepseek.com/v1/chat/completions'),
    'https://api.deepseek.com/v1/audio/transcriptions'
  );
  assert.equal(
    buildTranscriptionUrl('https://api.deepseek.com/v1'),
    'https://api.deepseek.com/v1/audio/transcriptions'
  );
  assert.equal(
    buildTranscriptionUrl('https://api.deepseek.com'),
    'https://api.deepseek.com/v1/audio/transcriptions'
  );
  // 已是转写端点则原样返回（幂等）
  assert.equal(
    buildTranscriptionUrl('https://api.openai.com/v1/audio/transcriptions'),
    'https://api.openai.com/v1/audio/transcriptions'
  );
});

test('normalizeTranscriptionConfig：默认模型与字段规整', () => {
  const cfg = normalizeTranscriptionConfig({ name: '  本地  ', baseUrl: ' https://x.test/v1/ ' });
  assert.equal(cfg.name, '本地');
  assert.equal(cfg.baseUrl, 'https://x.test/v1');
  assert.equal(cfg.model, DEFAULT_TRANSCRIPTION_MODEL);
  assert.equal(normalizeTranscriptionConfig({ model: 'whisper-large-v3' }).model, 'whisper-large-v3');
});

test('resolveTranscription：独立配置优先于复用聊天配置', () => {
  const picked = resolveTranscription({
    chatConfig: { baseUrl: 'https://chat.test/v1/chat/completions', apiKey: 'chat-key' },
    dedicated: { baseUrl: 'https://stt.test', apiKey: 'stt-key', model: 'whisper-1' },
  });
  assert.equal(picked.source, 'dedicated');
  assert.equal(picked.url, 'https://stt.test/v1/audio/transcriptions');
  assert.equal(picked.apiKey, 'stt-key');
});

test('resolveTranscription：无独立配置时复用聊天配置', () => {
  const picked = resolveTranscription({
    chatConfig: { baseUrl: 'https://api.deepseek.com/v1/chat/completions', apiKey: 'k' },
  });
  assert.equal(picked.source, 'reused');
  assert.equal(picked.url, 'https://api.deepseek.com/v1/audio/transcriptions');
  assert.equal(picked.model, DEFAULT_TRANSCRIPTION_MODEL);
});

test('resolveTranscription：都没有时返回 none', () => {
  assert.equal(resolveTranscription({}).source, 'none');
  // 独立配置缺 baseUrl 视为不可用，回落到复用
  const fallback = resolveTranscription({
    chatConfig: { baseUrl: 'https://api.test/v1', apiKey: 'k' },
    dedicated: { apiKey: 'stt-key' },
  });
  assert.equal(fallback.source, 'reused');
});

test('isUnsupportedTranscriptionError：404/405/501 与明确文案判为不支持', () => {
  assert.equal(isUnsupportedTranscriptionError({ status: 404 }), true);
  assert.equal(isUnsupportedTranscriptionError({ status: 405 }), true);
  assert.equal(isUnsupportedTranscriptionError({ status: 501 }), true);
  assert.equal(isUnsupportedTranscriptionError({ unsupported: true }), true);
  assert.equal(isUnsupportedTranscriptionError({ message: 'model not found' }), true);
  assert.equal(isUnsupportedTranscriptionError({ message: 'unsupported endpoint' }), true);
  assert.equal(isUnsupportedTranscriptionError({ status: 500, message: 'internal error' }), false);
  assert.equal(isUnsupportedTranscriptionError(null), false);
});

test('transcribeAudio：构造 FormData 文件与模型字段并解析 text', async () => {
  const originalFetch = globalThis.fetch;
  let captured = null;
  globalThis.fetch = async (url, options) => {
    captured = { url, options };
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ text: '  你好世界  ' }),
    };
  };
  try {
    const result = await transcribeAudio({
      config: { url: 'https://stt.test/v1/audio/transcriptions', apiKey: 'k', model: 'whisper-1' },
      fileUri: 'file:///documents/voice/a.m4a',
      mime: 'audio/m4a',
    });
    assert.equal(result.text, '你好世界');
    assert.equal(captured.url, 'https://stt.test/v1/audio/transcriptions');
    assert.equal(captured.options.headers.Authorization, 'Bearer k');
    assert.equal(captured.options.body.get('model'), 'whisper-1');
    // file 字段用 RN 的 { uri, name, type } 对象描述；Node 的 FormData 会把它
    // 转成 "[object Object]"，故只断言该字段存在（真实 RN 环境保留对象）。
    assert.ok(captured.options.body.has('file'), 'FormData 应含 file 字段');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('transcribeAudio：HTTP 错误带 status 与可读信息', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 404,
    text: async () => JSON.stringify({ error: { message: 'not found' } }),
  });
  try {
    await assert.rejects(
      () => transcribeAudio({
        config: { url: 'https://stt.test/v1/audio/transcriptions', apiKey: 'k', model: 'whisper-1' },
        fileUri: 'file:///documents/voice/a.m4a',
      }),
      error => error.status === 404 && /not found/.test(error.message)
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('transcribeAudio：未配置地址直接判为不支持', async () => {
  await assert.rejects(
    () => transcribeAudio({ config: { url: '' }, fileUri: 'file:///a.m4a' }),
    error => error.unsupported === true
  );
});

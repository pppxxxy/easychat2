import test from 'node:test';
import assert from 'node:assert/strict';

import {
  VOICE_MESSAGE_KIND,
  VOICE_PLACEHOLDER_TEXT,
  createVoiceMessage,
  formatVoiceDuration,
  getVoicePromptText,
  isVoiceMessage,
} from '../src/voiceMessages.js';

test('createVoiceMessage：构造 voice 消息并规整音频引用', () => {
  const message = createVoiceMessage({
    id: 'm1',
    role: 'user',
    text: '你好',
    audio: { uri: 'file:///documents/voice/a.m4a', mime: 'audio/m4a', durationMs: 2345 },
    timestamp: 1000,
  });
  assert.equal(message.kind, VOICE_MESSAGE_KIND);
  assert.equal(message.role, 'user');
  assert.equal(message.text, '你好');
  assert.deepEqual(message.audio, {
    uri: 'file:///documents/voice/a.m4a',
    mime: 'audio/m4a',
    durationMs: 2345,
  });
  assert.equal(message.timestamp, 1000);
});

test('createVoiceMessage：role 非法回退 user，duration 负数归零', () => {
  const message = createVoiceMessage({ role: 'weird', audio: { durationMs: -5 } });
  assert.equal(message.role, 'user');
  assert.equal(message.audio.durationMs, 0);
  assert.equal(message.audio.mime, 'audio/m4a');
});

test('isVoiceMessage：仅 kind=voice 且有 audio 才算', () => {
  assert.equal(isVoiceMessage({ kind: 'voice', audio: { uri: 'x' } }), true);
  assert.equal(isVoiceMessage({ kind: 'voice' }), false);
  assert.equal(isVoiceMessage({ kind: 'image', audio: { uri: 'x' } }), false);
  assert.equal(isVoiceMessage(null), false);
});

test('getVoicePromptText：有文本用文本，空文本用占位', () => {
  assert.equal(getVoicePromptText({ kind: 'voice', audio: {}, text: '  转写内容  ' }), '转写内容');
  assert.equal(getVoicePromptText({ kind: 'voice', audio: {}, text: '' }), VOICE_PLACEHOLDER_TEXT);
  assert.equal(getVoicePromptText({ kind: 'voice', audio: {}, text: '   ' }), VOICE_PLACEHOLDER_TEXT);
});

test('getVoicePromptText：非语音消息原样返回 text', () => {
  assert.equal(getVoicePromptText({ role: 'user', text: '普通消息' }), '普通消息');
  assert.equal(getVoicePromptText(null), '');
});

test('formatVoiceDuration：四舍五入到秒，至少 1 秒', () => {
  assert.equal(formatVoiceDuration(0), '1"');
  assert.equal(formatVoiceDuration(400), '1"');
  assert.equal(formatVoiceDuration(1400), '1"');
  assert.equal(formatVoiceDuration(1500), '2"');
  assert.equal(formatVoiceDuration(12000), '12"');
});

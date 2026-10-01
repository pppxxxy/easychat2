import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_MODEL_LOGS,
  MODEL_LOG_LEVELS,
  __resetModelLogsForTests,
  classifyLocalModelError,
  clearModelLogs,
  formatModelLogs,
  getModelLogs,
  normalizeModelLog,
  recordModelLog,
} from '../src/localModel/modelLogs.js';

test('normalizeModelLog：补全时间/等级/事件并截断超长文本', () => {
  __resetModelLogsForTests();
  const entry = normalizeModelLog({ at: 5, level: 'weird', event: 'load', message: 'x'.repeat(5000) });
  assert.equal(entry.at, 5);
  assert.equal(entry.level, 'info');
  assert.equal(entry.event, 'load');
  assert.equal(entry.message.length, 2000);
  const empty = normalizeModelLog(null);
  assert.equal(empty.event, 'event');
  assert.ok(empty.at > 0);
});

test('recordModelLog / getModelLogs：按顺序追加并返回副本', () => {
  __resetModelLogsForTests();
  recordModelLog('load', 'a');
  recordModelLog('chat', 'b', { level: 'error', context: 'ctx' });
  const logs = getModelLogs();
  assert.equal(logs.length, 2);
  assert.equal(logs[0].event, 'load');
  assert.equal(logs[1].level, 'error');
  assert.equal(logs[1].context, 'ctx');
  // 外部修改不影响内部缓冲
  logs[0].message = 'mutated';
  assert.equal(getModelLogs()[0].message, 'a');
});

test('环形缓冲：超过上限丢弃最旧条目', () => {
  __resetModelLogsForTests();
  for (let i = 0; i < MAX_MODEL_LOGS + 5; i += 1) {
    recordModelLog('chat', `m${i}`);
  }
  const logs = getModelLogs();
  assert.equal(logs.length, MAX_MODEL_LOGS);
  assert.equal(logs[0].message, 'm5');
  assert.equal(logs[logs.length - 1].message, `m${MAX_MODEL_LOGS + 4}`);
});

test('clearModelLogs 清空缓冲', () => {
  __resetModelLogsForTests();
  recordModelLog('load', 'x');
  clearModelLogs();
  assert.deepEqual(getModelLogs(), []);
});

test('formatModelLogs：空列表返回空串，有条目时含等级与事件', () => {
  assert.equal(formatModelLogs([]), '');
  const text = formatModelLogs([{ at: 0, level: 'warn', event: 'load', message: '慢', context: 'ctx' }]);
  assert.match(text, /warn load: 慢/);
  assert.match(text, /context: ctx/);
});

test('classifyLocalModelError：按 code/name 分类等级', () => {
  assert.deepEqual(classifyLocalModelError({ code: 'LOCAL_MODEL_UNAVAILABLE' }), {
    code: 'LOCAL_MODEL_UNAVAILABLE', level: 'warn', message: '当前构建未包含本地模型能力',
  });
  assert.equal(classifyLocalModelError({ code: 'RESOURCE_BUSY' }).level, 'warn');
  assert.equal(classifyLocalModelError({ code: 'LOAD_FAILED', message: 'x' }).level, 'error');
  assert.equal(classifyLocalModelError({ code: 'INFERENCE_FAILED', message: 'x' }).level, 'error');
  const abort = classifyLocalModelError({ name: 'AbortError' });
  assert.equal(abort.code, 'ABORTED');
  assert.equal(abort.level, 'info');
  assert.equal(classifyLocalModelError({ message: '崩了' }).code, 'UNKNOWN');
  assert.equal(classifyLocalModelError(null).message, '本地模型未知错误');
});

test('MODEL_LOG_LEVELS 稳定', () => {
  assert.deepEqual(MODEL_LOG_LEVELS, ['info', 'warn', 'error']);
});

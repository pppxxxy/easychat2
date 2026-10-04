// 主动消息面板：协议守卫的源码断言（RN 面板与原生定时器进不了 Node）。
// 背景：API 协议层放开 anthropic / openai-responses 后，原生主动消息仍只会按
// OpenAI Chat Completions 发后台请求；若无守卫，选非 openai 协议会静默失败。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.resolve('src/ProactivePanel.js'), 'utf8');

test('ProactivePanel：同步 API 给原生之前必须先做协议守卫', () => {
  assert.ok(
    source.includes("import { normalizeProtocol } from './apiProtocols.js'"),
    '协议归一必须来自 apiProtocols（与聊天路径同一套口径）',
  );

  const saveHead = source.slice(
    source.indexOf('const save = useCallback'),
    source.indexOf('await setProactiveApiSettings('),
  );
  assert.ok(saveHead.length > 0, '必须能定位到 save 的前半段（守卫应在此之前）');
  assert.ok(
    saveHead.includes("normalizeProtocol(currentConfig.protocol) !== 'openai'"),
    'save 里必须拒绝非 openai 协议：原生侧只会按 Chat Completions 发请求',
  );
  assert.ok(
    saveHead.includes('主动消息目前仅支持 OpenAI 兼容协议'),
    '拒绝时必须给出可读原因，而不是静默失败',
  );
});

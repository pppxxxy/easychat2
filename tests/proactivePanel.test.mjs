// 主动消息面板：多协议接线的源码断言（RN 面板与原生定时器进不了 Node）。
// 背景：apiProtocols 放开 anthropic / openai-responses 后，主动消息在保存槽时
// 就把**按协议组好的完整请求体**快照进原生，端点与鉴权头也按协议计算——
// 原生只负责发送与按协议解析回复（spec：2026-10-04-proactive-multi-protocol）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.resolve('src/ProactivePanel.js'), 'utf8');

test('ProactivePanel：协议/端点/鉴权全部来自协议层，保存前完成计算', () => {
  assert.ok(
    source.includes("import { normalizeProtocol } from './proactive/proactiveRequest.js'") ||
      /buildProactive(AuthSettings|Endpoint)[\s\S]*?from '\.\/proactive\/proactiveRequest\.js'/.test(source),
    '协议口径必须来自 proactiveRequest（与聊天路径同一套 apiProtocols）',
  );

  const save = source.slice(source.indexOf('const save = useCallback'), source.indexOf('await setProactiveApiSettings('));
  assert.ok(save.length > 0, '必须能定位到 save 的前半段');
  assert.ok(save.includes('normalizeProtocol(currentConfig.protocol)'), '保存时必须归一当前配置的协议');
  assert.ok(save.includes('buildProactiveAuthSettings('), '鉴权头必须按协议计算');
  assert.ok(save.includes('buildProactiveEndpoint('), '端点必须按协议计算（normalizeChatUrl 只会给出 chat/completions）');
});

test('ProactivePanel：协议、鉴权与请求体快照随保存下发原生', () => {
  const sync = source.slice(
    source.indexOf('await setProactiveApiSettings('),
    source.indexOf('// 3. 逐槽排定'),
  );
  assert.ok(sync.length > 0, '必须能定位到 API 同步调用');
  for (const field of ['protocol', 'authHeader', 'authScheme', 'extraHeadersJson']) {
    assert.ok(sync.includes(`${field}:`), `同步给原生时必须下发 ${field}`);
  }
  assert.ok(!sync.includes('normalizeChatUrl'), '不得再用 normalizeChatUrl 固化 chat/completions 端点');

  // 每个槽的快照必须带上当前协议与模型（原生解析回复与回退简版都依赖它）
  const snapshot = source.slice(source.indexOf('buildProactiveRequestJson({'), source.indexOf("} catch (error) {\n            requestJson = '';"));
  assert.ok(snapshot.includes('protocol: proactiveProtocol'), '槽快照必须使用当前协议');
  assert.ok(snapshot.includes('model,'), '槽快照必须带模型（原生回退简版需要）');
});

// 聊天 ↔ agent 工具循环接线的源码断言（RN/流式依赖运行时，Node 进不去）。
// 关键回归钉：
// - ask 模式：不注册工具、不触达 runAgentTurn，仍走原 sendChatMessage 路径（零变化）；
// - read/write：onlineSend 走 runAgentTurn，mode/tools/signal/context 齐全；
// - 配置守卫经 requestOptions 透传（expectedConfigId/Fingerprint），不再外露给 api；
// - 工具状态气泡是 pending+transient（临时、不落库），并在中止/成功/异常三个出口清理。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.resolve('src/chat/useChatSend.js'), 'utf8');

test('接线导入与 mode 读取', () => {
  assert.ok(source.includes("from '../agent/tools/registry.js'"), '导入工具注册表');
  assert.ok(source.includes('listToolsForMode'), '按模式派生工具集');
  assert.ok(source.includes("from '../agent/loop.js'"), '导入 runAgentTurn');
  assert.ok(source.includes("from '../workspace/native.js'"), '导入默认工作区工具注册');
  assert.ok(source.includes('getWorkspaceSettings'), '读工作区模式');
  assert.ok(/let workspaceMode = 'ask'/.test(source), '模式默认 ask（读失败也不改变发送行为）');
});

test('ask 零变化：不注册工具、走 sendChatMessage；read/write 走 runAgentTurn', () => {
  assert.ok(source.includes("if (workspaceMode !== 'ask')"), '仅非 ask 才注册/派生工具');
  assert.ok(source.includes('registerDefaultWorkspaceTools()'), '注册默认工作区工具');
  assert.ok(/agentTools\.length > 0[\s\S]{0,80}runAgentTurn/.test(source), '有工具才走循环');
  assert.ok(source.includes('sendChatMessage(onlineMessages'), 'ask 路径仍是 sendChatMessage');
  assert.ok(source.includes('listToolsForMode(workspaceMode)'), '工具集按当前模式派生');
});

test('runAgentTurn 调用参数齐全 + 守卫透传', () => {
  const idx = source.indexOf('runAgentTurn(onlineMessages');
  assert.ok(idx >= 0, '存在 runAgentTurn 调用');
  const block = source.slice(idx, idx + 2600);
  assert.ok(/mode:\s*workspaceMode/.test(block), '传 mode');
  assert.ok(/tools:\s*agentTools/.test(block), '传 tools');
  assert.ok(/signal:\s*controller\.signal/.test(block), '传取消信号');
  assert.ok(/requestOptions:\s*\{[\s\S]*expectedConfigId/.test(block), '守卫经 requestOptions 透传');
  assert.ok(block.includes('expectedConfigFingerprint'), '指纹守卫也在 requestOptions');
  assert.ok(/onToken:/.test(block) && /onReasoning:/.test(block) && /onToolEvent:/.test(block),
    '三条 UI 回调齐全');
  assert.ok(/context:\s*\{[\s\S]*characterId[\s\S]*sessionId/.test(block), '工具沙盒上下文');
});

test('工具状态气泡：临时不落库 + 三个出口清理', () => {
  assert.ok(source.includes("kind: 'tool-status'"), '工具状态有独立 kind');
  assert.ok(/text,\s*\n\s*kind: 'tool-status',\s*\n\s*pending: true,\s*\n\s*transient: true/.test(source),
    '工具气泡同时 pending+transient（落库过滤会剔除）');
  assert.ok(source.includes("event.phase === 'start'"), 'start 打气泡');
  assert.ok(source.includes('setToolStatus('), 'end 清气泡');
  const clears = (source.match(/clearToolStatus\(\)/g) || []).length;
  assert.ok(clears >= 3, `至少三处清理（中止/成功/异常），实际 ${clears}`);
});

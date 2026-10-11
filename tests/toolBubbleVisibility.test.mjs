// 工具过程气泡：隐藏开关的**行为**验证（气泡状态机 + 审批边界 + 清单单一来源）。
//
// 为什么单独一个文件：tests/chatTools.test.mjs 钉的是「气泡显示逻辑与门控」，
// 本文件钉的是「隐藏开关真的生效」——两者都会在写错时静默出错：
//   - 隐藏写晚了 → 气泡先闪一下再消失（需求点名要避免的形态）；
//   - 隐藏写得比失败豁免更宽 → 工具失败了却毫无提示；
//   - 隐藏顺手把审批也跳过 → 工具静默执行（安全问题）；
//   - 设置页手抄一份工具清单 → 新增工具时开关漏掉（本仓库被咬过六次以上）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

import { TOOL_BUBBLE_KIND, ASSISTANT_ID } from '../src/chat/chatConstants.js';
import { createToolBubbleApplier, toolBubbleState, updateToolBubbles } from '../src/chat/toolBubbleView.js';
import { isToolNoticeHidden } from '../src/chat/toolNoticeVisibility.js';
import * as registry from '../src/agent/tools/registry.js';
import { zhCN } from '../src/i18n/locales/zh-CN.js';
import { en } from '../src/i18n/locales/en.js';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const presetEnv = require.resolve('@babel/preset-env');

// chatTools.js 会 import 存储层（AsyncStorage）与网络层，纯逻辑测试里按需打桩；
// 注册表**不打桩**——下面注入的是真注册表，用来证明「注册的」与「界面列出的」同源。
function loadModule(relativePath, stubs = {}) {
  const sourcePath = path.resolve(relativePath);
  const transformed = babel.transformSync(fs.readFileSync(sourcePath, 'utf8'), {
    babelrc: false,
    configFile: false,
    filename: sourcePath,
    presets: [[presetEnv, { targets: { node: 'current' }, modules: 'commonjs' }]],
  }).code;
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (stubs[request]) return stubs[request];
    for (const [suffix, value] of Object.entries(stubs)) {
      if (suffix.startsWith('*') && request.endsWith(suffix.slice(1))) return value;
    }
    if (request.endsWith('/i18n/index.js')) {
      return { tActive: (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key) };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  const runtime = new Module(sourcePath);
  runtime.filename = sourcePath;
  runtime.paths = Module._nodeModulePaths(path.dirname(sourcePath));
  runtime._compile(transformed, sourcePath);
  Module._load = originalLoad;
  return runtime.exports;
}

const chatTools = loadModule('src/chat/chatTools.js', {
  '*agent/tools/registry.js': registry,
  '*storage/settings/plugins.js': { getPlugins: async () => [] },
  '*plugins/webSearch.js': { runWebSearch: async () => [] },
  '*plugins/webFetch.js': { runWebFetch: async () => ({}) },
});

const ID = 'bubble-1';
const visible = {};
const perToolHidden = { hiddenToolNotices: { web_search: true } };
const hideAll = { hideAllToolNotices: true };

test.beforeEach(() => {
  registry.clearTools();
});

// ---------- 气泡状态机 ----------

test('默认可见：气泡照常挂出、原地更新，且是「不落库的临时消息」', () => {
  let messages = updateToolBubbles([], { id: ID, name: 'web_search', status: 'running', visibility: visible, now: 111 });
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0], {
    id: ID,
    role: ASSISTANT_ID,
    text: '',
    kind: TOOL_BUBBLE_KIND,
    toolName: 'web_search',
    toolStatus: 'running',
    toolError: '',
    pending: true,
    transient: true,
    timestamp: 111,
  });
  // end：同一个 id 原地更新，不堆第二条
  messages = updateToolBubbles(messages, { id: ID, name: 'web_search', status: 'done', visibility: visible, now: 222 });
  assert.equal(messages.length, 1, '不逐轮堆叠');
  assert.equal(messages[0].toolStatus, 'done');
  assert.equal(messages[0].timestamp, 222, '更新时刷新时间戳');
});

test('按工具隐藏生效：被隐藏的工具**连一帧气泡都不挂出**（不闪一下再消失）', () => {
  // start 阶段就不挂：这是「不闪烁」的实现方式——判定发生在追加之前
  assert.deepEqual(
    updateToolBubbles([], { id: ID, name: 'web_search', status: 'running', visibility: perToolHidden, now: 1 }),
    []
  );
  // end（成功）同样不挂
  assert.deepEqual(
    updateToolBubbles([], { id: ID, name: 'web_search', status: 'done', visibility: perToolHidden, now: 1 }),
    []
  );
  // 别的工具不受牵连
  const other = updateToolBubbles([], { id: ID, name: 'web_fetch', status: 'running', visibility: perToolHidden, now: 1 });
  assert.equal(other.length, 1);
  assert.equal(other[0].toolName, 'web_fetch');
});

test('总开关：清单内外的工具都不挂气泡', () => {
  for (const name of ['web_search', 'web_fetch', 'read_workspace_file', 'mcp__github__create_issue', 'brand_new_tool']) {
    assert.deepEqual(
      updateToolBubbles([], { id: ID, name, status: 'running', visibility: hideAll, now: 1 }),
      [], `${name} running 不该显示`
    );
    assert.deepEqual(
      updateToolBubbles([], { id: ID, name, status: 'done', visibility: hideAll, now: 1 }),
      [], `${name} done 不该显示`
    );
  }
});

test('边界②：失败永不被隐藏——总开关与单项开关都开着时仍然显示', () => {
  const both = { hideAllToolNotices: true, hiddenToolNotices: { web_search: true } };
  const failed = updateToolBubbles([], {
    id: ID, name: 'web_search', status: 'error', error: '工具 web_search 执行超过 20 秒，已放弃等待——结果未知', visibility: both, now: 7,
  });
  assert.equal(failed.length, 1, '失败必须看得见');
  assert.equal(failed[0].toolStatus, 'error');
  assert.ok(failed[0].toolError.includes('结果未知'), '失败原因原样带出，不能被吞掉');
  // 而且它必须是「原地替换」而不是叠一条：先有 running（隐藏时不挂）→ error 挂出
  const only = updateToolBubbles(failed, {
    id: ID, name: 'web_search', status: 'error', error: 'x', visibility: both, now: 8,
  });
  assert.equal(only.length, 1);
});

test('开关改变立即生效：已挂出的气泡在下一次工具事件时就消失/出现', () => {
  let messages = updateToolBubbles([], { id: ID, name: 'web_search', status: 'running', visibility: visible, now: 1 });
  assert.equal(messages.length, 1);
  // 用户在设置页打开「隐藏」后回到聊天页：chatOptionsRef 已是新值，下一次事件即重判
  messages = updateToolBubbles(messages, { id: ID, name: 'web_search', status: 'running', visibility: perToolHidden, now: 2 });
  assert.equal(messages.length, 0, '改成隐藏后立即消失（不必等下一轮）');
  messages = updateToolBubbles(messages, { id: ID, name: 'web_search', status: 'running', visibility: visible, now: 3 });
  assert.equal(messages.length, 1, '改回显示后立即出现');
});

test('清除与隔离：缺 name/status 即清除该 id，其余消息与 id 一概不动', () => {
  const keep = { id: 'assistant-1', role: ASSISTANT_ID, text: '回复', kind: '' };
  const other = { id: 'bubble-2', role: ASSISTANT_ID, text: '', kind: TOOL_BUBBLE_KIND, toolName: 'web_fetch', toolStatus: 'done' };
  let messages = updateToolBubbles([keep, other], { id: ID, name: 'web_search', status: 'running', visibility: visible, now: 1 });
  assert.equal(messages.length, 3);
  const cleared = updateToolBubbles(messages, { id: ID, visibility: visible });
  assert.deepEqual(cleared.map(item => item.id), ['assistant-1', 'bubble-2']);
  assert.equal(updateToolBubbles(null, { id: ID, name: 'web_search', status: 'running', visibility: visible }).length, 1,
    '非数组输入不得抛错');
  // 不改原数组
  assert.equal(messages.length, 3);
});

test('事件→状态映射复用 toolBubbleState：start/done/error 三种结果', () => {
  assert.deepEqual(toolBubbleState({ phase: 'start', name: 'web_search', round: 1 }), { name: 'web_search', status: 'running', round: 1 });
  assert.equal(toolBubbleState({ phase: 'end', name: 'web_search', round: 1, ok: true }).status, 'done');
  assert.equal(toolBubbleState({ phase: 'end', name: 'web_search', round: 1, ok: false }).status, 'error');
  assert.equal(toolBubbleState({ phase: 'nope', name: 'web_search' }), null, '未知阶段不产出气泡');
});

// ---------- 接线器（发送路径的真实胶水） ----------

// 真实的 React 状态更新契约：setMessages 收 updater 函数，返回下一个数组。
function makeHost({ visibility, currentSession = true } = {}) {
  const host = { messages: [], session: currentSession, updates: 0 };
  host.setMessages = updater => {
    host.updates += 1;
    host.messages = typeof updater === 'function' ? updater(host.messages) : updater;
  };
  host.applier = createToolBubbleApplier({
    id: ID,
    isCurrentSession: () => host.session,
    getVisibility: () => (typeof visibility === 'function' ? visibility() : visibility),
    setMessages: host.setMessages,
  });
  return host;
}

test('接线器：可见性每次事件现取——同一轮内改开关立即生效', () => {
  let visibility = visible;
  const host = makeHost({ visibility: () => visibility });
  host.applier.set('web_search', 'running');
  assert.equal(host.messages.length, 1, '默认显示');
  visibility = perToolHidden;
  host.applier.set('web_search', 'running');
  assert.equal(host.messages.length, 0, '开关改成隐藏后，同一轮的下一次事件即消失');
  visibility = visible;
  host.applier.set('web_search', 'running');
  assert.equal(host.messages.length, 1, '改回显示后立即出现');
});

test('接线器：会话已切走时不挂气泡、也不触碰状态', () => {
  const host = makeHost({ visibility: perToolHidden, currentSession: false });
  host.applier.set('web_fetch', 'running');
  assert.equal(host.updates, 0, '不是当前会话时连状态更新都不发起');
  assert.deepEqual(host.messages, []);
  // clear 同样受会话守卫
  host.applier.clear();
  assert.equal(host.updates, 0);
});

test('接线器：隐藏只掐显示，事件照常被消费（不抛错、不影响工具循环）', () => {
  const host = makeHost({ visibility: hideAll });
  // 三种事件都不能抛错；隐藏时状态里一条气泡都不该出现（含 end 成功）
  for (const event of [
    { phase: 'start', name: 'web_search', round: 1 },
    { phase: 'end', name: 'web_search', round: 1, ok: true },
    { phase: 'end', name: 'web_search', round: 1, ok: false, error: '超时' },
    { phase: 'unknown', name: 'web_search' },
    null,
  ]) {
    const state = toolBubbleState(event);
    assert.doesNotThrow(() => { if (state) host.applier.set(state.name, state.status, state.error || ''); });
  }
  // 唯一该留下的是「失败」那条
  assert.equal(host.messages.length, 1);
  assert.equal(host.messages[0].toolStatus, 'error');
  // clear 之后清空
  host.applier.clear();
  assert.deepEqual(host.messages, []);
});

// ---------- 边界①：审批绝不被隐藏 ----------

test('边界①：工具被隐藏时，审批照常弹出（隐藏提示 ≠ 隐藏确认）', async () => {
  registry.registerTool({
    name: 'hidden_confirm_tool',
    description: '需要确认的工具',
    readOnly: false,
    requiresConfirmation: true,
    execute: async () => 'executed',
  });
  const settings = { hideAllToolNotices: true, hiddenToolNotices: { hidden_confirm_tool: true } };
  // 前提：这个工具的过程提示**确实**被判为隐藏——否则下面的断言证明不了任何事
  assert.equal(isToolNoticeHidden('hidden_confirm_tool', settings), true, '前提：该工具的过程提示被隐藏');
  assert.deepEqual(
    updateToolBubbles([], { id: ID, name: 'hidden_confirm_tool', status: 'running', visibility: settings, now: 1 }),
    [],
    '前提：该工具不挂气泡'
  );

  let asked = 0;
  const approved = await registry.runTool(
    { name: 'hidden_confirm_tool', arguments: '{}' },
    { mode: 'write', confirm: async () => { asked += 1; return true; } }
  );
  assert.equal(asked, 1, '隐藏过程提示绝不允许跳过审批——跳过了就是工具静默执行');
  assert.equal(approved.isError, false);
  assert.equal(approved.content, 'executed');

  // 用户拒绝 → 不执行（隐藏开关不能让「拒绝」变成「照跑」）
  let executed = 0;
  registry.registerTool({
    name: 'hidden_confirm_tool',
    description: '需要确认的工具',
    readOnly: false,
    requiresConfirmation: true,
    execute: async () => { executed += 1; return 'executed'; },
  });
  const denied = await registry.runTool(
    { name: 'hidden_confirm_tool', arguments: '{}' },
    { mode: 'write', confirm: async () => false }
  );
  assert.equal(denied.isError, true);
  assert.equal(executed, 0, '被拒绝时绝不能执行');

  // 没有可问用户的出口 → 拒绝执行（而不是「反正提示都隐藏了，直接跑」）
  const noOutlet = await registry.runTool({ name: 'hidden_confirm_tool', arguments: '{}' }, { mode: 'write' });
  assert.equal(noOutlet.isError, true);
  assert.equal(executed, 0);
});

// ---------- 清单单一来源 ----------

test('工具清单单一来源：设置页开关派生的清单 == 真正注册进注册表的聊天工具', () => {
  const names = chatTools.listChatToolNames();
  assert.ok(names.length >= 2, '至少要有联网搜索与网页抓取');
  const registered = chatTools.registerChatTools();
  const fromRegistry = registry.listRegisteredTools()
    .filter(tool => tool.chatTool === true)
    .map(tool => tool.name)
    .sort();
  assert.deepEqual([...names].sort(), fromRegistry,
    '设置页列出的开关必须与真正注册的聊天工具完全一致（否则新增工具时开关会漏掉）');
  assert.deepEqual([...registered].sort(), fromRegistry);

  // 摘除同样派生：清单里不留残余（「关掉必须真的摘掉」）
  chatTools.unregisterChatTools();
  assert.deepEqual(registry.listRegisteredTools().filter(tool => tool.chatTool === true), []);
});

test('每个聊天工具都有可读文案与可隐藏的开关（新增工具不会变成裸名字）', () => {
  const names = chatTools.listChatToolNames();
  const view = loadModule('src/chat/toolBubbleView.js', {});
  names.forEach(name => {
    const key = view.toolLabelKey(name);
    assert.ok(key, `${name} 必须有专属文案 key，否则设置页只能显示原始工具名`);
    assert.ok(zhCN[key], `zh-CN 缺 ${key}`);
    assert.ok(en[key], `en 缺 ${key}`);
    assert.equal(
      isToolNoticeHidden(name, { hiddenToolNotices: { [name]: true } }), true,
      `${name} 必须能被单独隐藏`
    );
  });
});

// 聊天内工具：可见气泡的展示逻辑 + 受控工具集的门控。
//
// 这里的断言分两类，都对应「错了也不容易发现」的风险：
//   1) 展示逻辑：工具名 → 文案映射、状态覆盖顺序、未知工具不吞信息；
//   2) 门控：聊天内工具必须「不开启就真的调不到」——注册表里留着但 UI 不勾选，
//      等于没关。这条是安全属性，必须有测试钉住。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const presetEnv = require.resolve('@babel/preset-env');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = rel => fs.readFileSync(path.join(HERE, '..', rel), 'utf8');

// 依赖注入加载器：registry 会 import i18n，webSearch 会 import 网络层，
// 都替换成最小桩，让纯逻辑可在 Node 下跑。
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

const bubble = loadModule('src/chat/toolBubbleView.js', {});

test('toolLabelKey：已登记工具给 i18n key，未登记工具给空串（由兜底文案接管）', () => {
  assert.equal(bubble.toolLabelKey('web_search'), 'chat.toolBubble.name.search');
  assert.equal(bubble.toolLabelKey('some_future_tool'), '');
  assert.equal(bubble.toolLabelKey(''), '');
  assert.equal(bubble.toolLabelKey(null), '');
});

test('toolBubbleState：start → running，end → done / error', () => {
  assert.deepEqual(
    bubble.toolBubbleState({ phase: 'start', name: 'web_search', round: 1 }),
    { name: 'web_search', status: 'running', round: 1 }
  );
  assert.deepEqual(
    bubble.toolBubbleState({ phase: 'end', name: 'web_search', round: 1, ok: true }),
    { name: 'web_search', status: 'done', round: 1, error: '' }
  );
  const failed = bubble.toolBubbleState({ phase: 'end', name: 'web_search', round: 2, ok: false, error: '超时' });
  assert.equal(failed.status, 'error');
  assert.equal(failed.error, '超时');
});

test('toolBubbleState：未知阶段或空工具名返回 null，不产出空气泡', () => {
  assert.equal(bubble.toolBubbleState({ phase: 'weird', name: 'x' }), null);
  assert.equal(bubble.toolBubbleState({ phase: 'start', name: '' }), null);
  assert.equal(bubble.toolBubbleState(null), null);
});

test('toolBubbleView：已登记工具走具名文案，未登记工具原样显示工具名（不吞信息）', () => {
  const known = bubble.toolBubbleView({ name: 'web_search', status: 'running' });
  assert.equal(known.nameKey, 'chat.toolBubble.name.search');
  assert.equal(known.statusKey, 'chat.toolBubble.status.running');

  const unknown = bubble.toolBubbleView({ name: 'future_tool', status: 'done' });
  assert.equal(unknown.nameKey, 'chat.toolBubble.name.generic');
  assert.equal(unknown.nameParams.raw, 'future_tool', '未登记的工具必须暴露原始名');
  assert.equal(unknown.statusKey, 'chat.toolBubble.status.done');
});

test('reduceToolEvents：同一轮同一工具的 start 被 end 覆盖，不堆两条', () => {
  const states = bubble.reduceToolEvents([
    { phase: 'start', name: 'web_search', round: 1 },
    { phase: 'end', name: 'web_search', round: 1, ok: true },
  ]);
  assert.equal(states.length, 1);
  assert.equal(states[0].status, 'done');

  // 不同轮次分别保留
  const twoRounds = bubble.reduceToolEvents([
    { phase: 'end', name: 'web_search', round: 1, ok: true },
    { phase: 'end', name: 'web_search', round: 2, ok: true },
  ]);
  assert.equal(twoRounds.length, 2);
});

test('shouldShowToolBubble：开关关闭时一律不显示', () => {
  const state = { name: 'web_search', status: 'running' };
  assert.equal(bubble.shouldShowToolBubble({ enabled: true, state }), true);
  assert.equal(bubble.shouldShowToolBubble({ enabled: false, state }), false, '关掉开关必须真的不显示');
  assert.equal(bubble.shouldShowToolBubble({ state }), false, '缺省即关闭');
  assert.equal(bubble.shouldShowToolBubble({ enabled: true, state: null }), false);
});

test('注册表门控：聊天内工具不开启就不可达（既不列出也不可执行）', () => {
  const registry = loadModule('src/agent/tools/registry.js', {});
  registry.clearTools();
  // 一个工作区工具（受模式门控）+ 一个聊天内工具（受独立开关门控）
  registry.registerTool({
    name: 'ws_tool', description: 'workspace', readOnly: true, execute: async () => 'ws',
  });
  registry.registerTool({
    name: 'chat_tool', description: 'chat', readOnly: true, chatTool: true, execute: async () => 'chat',
  });

  // 暴露层：ask 模式 + 开关关闭 → 两个都不列出
  assert.deepEqual(registry.listToolsForMode('ask').map(t => t.function.name), []);
  // 开关打开 → 只有聊天内工具（工作区工具仍受 ask 门控）
  assert.deepEqual(
    registry.listToolsForMode('ask', { allowChatTools: true }).map(t => t.function.name),
    ['chat_tool']
  );
  // read 模式 + 开关关闭 → 只有只读工作区工具，聊天内工具不出现
  assert.deepEqual(
    registry.listToolsForMode('read').map(t => t.function.name),
    ['ws_tool']
  );
  // read 模式 + 开关打开 → 两个都在
  assert.deepEqual(
    registry.listToolsForMode('read', { allowChatTools: true }).map(t => t.function.name).sort(),
    ['chat_tool', 'ws_tool']
  );

  // 执行层：即使模型硬报一个名字，开关关闭时也必须被拒
  assert.equal(registry.canRunTool(registry.getTool('chat_tool'), 'ask'), false);
  assert.equal(registry.canRunTool(registry.getTool('chat_tool'), 'ask', { allowChatTools: true }), true);
  assert.equal(registry.canRunTool(registry.getTool('ws_tool'), 'ask', { allowChatTools: true }), false,
    '开关打开也不能让工作区工具突破 ask 门控');
  registry.clearTools();
});

test('runTool：聊天内工具在未放行时被拒绝且不执行', async () => {
  const registry = loadModule('src/agent/tools/registry.js', {});
  registry.clearTools();
  let executed = 0;
  registry.registerTool({
    name: 'chat_tool',
    description: 'chat',
    readOnly: true,
    chatTool: true,
    execute: async () => { executed += 1; return 'ran'; },
  });

  const denied = await registry.runTool(
    { name: 'chat_tool', arguments: '{}' },
    { mode: 'ask' }
  );
  assert.equal(denied.isError, true, '未放行必须返回错误结果');
  assert.equal(executed, 0, '被拒绝时绝不能执行');

  const allowed = await registry.runTool(
    { name: 'chat_tool', arguments: '{}' },
    { mode: 'ask', allowChatTools: true }
  );
  assert.equal(allowed.isError, false);
  assert.equal(executed, 1);
  registry.clearTools();
});

test('agent loop：allowChatTools 一路传到 runTool（否则暴露了却执行不了）', () => {
  const loop = read('src/agent/loop.js');
  assert.ok(loop.includes('const allowChatTools = options.allowChatTools === true;'));
  assert.ok(loop.includes('allowChatTools,'), 'runTool 调用点要带上开关');
  assert.ok(loop.includes('listToolsForMode(mode, { allowChatTools })'), '默认工具集也要按开关过滤');
});

test('搜索工具配置：未启用或缺密钥时不暴露（不暴露即不可达）', () => {
  const chatTools = loadModule('src/chat/chatTools.js', {
    '*agent/tools/registry.js': {
      registerTool: () => {},
      unregisterTool: () => {},
    },
    '*storage/settings/plugins.js': { getPlugins: async () => [] },
    '*plugins/webSearch.js': { runWebSearch: async () => [] },
  });
  const plugins = [
    { id: 'web-search', type: 'web-search', enabled: false, config: { provider: 'serpapi', apiKey: 'k' } },
  ];
  assert.equal(chatTools.resolveSearchPluginConfig(plugins), null, '未启用 → 不暴露');

  const enabledNoKey = [
    { id: 'web-search', type: 'web-search', enabled: true, config: { provider: 'serpapi', apiKey: '' } },
  ];
  assert.equal(chatTools.resolveSearchPluginConfig(enabledNoKey), null, '无密钥且无自定义地址 → 不暴露');

  const ready = [
    { id: 'web-search', type: 'web-search', enabled: true, config: { provider: 'serpapi', apiKey: 'k' } },
  ];
  assert.deepEqual(chatTools.resolveSearchPluginConfig(ready), { provider: 'serpapi', apiKey: 'k' });
});

test('UI 接线：气泡组件、渲染分支、发送路径驱动三者齐备', () => {
  const list = read('src/chat/MessageList.js');
  const send = read('src/chat/useChatSend.js');
  const component = read('src/chat/ToolBubble.js');
  const constants = read('src/chat/chatConstants.js');

  assert.ok(constants.includes("export const TOOL_BUBBLE_KIND = 'tool-bubble';"));
  assert.ok(list.includes("import ToolBubble from './ToolBubble.js';"));
  assert.ok(list.includes('message.kind === TOOL_BUBBLE_KIND ? ('), '渲染分支必须真的接上');
  assert.ok(component.includes('toolBubbleView('));
  assert.ok(component.includes('ToolBubble'), '组件存在');

  // 发送路径：start 挂出、end 改状态、收尾清除
  assert.ok(send.includes("setToolBubble(event.name, 'running')"));
  assert.ok(send.includes("event.ok === false ? 'error' : 'done'"));
  assert.ok(send.includes('clearToolBubble()'));
  assert.ok(send.includes('TOOL_BUBBLE_KIND'));
  // 气泡必须是不落库的临时消息
  assert.ok(send.includes('transient: true'), '气泡必须 transient（不落库）');
});

test('聊天内工具词条中英齐备', () => {
  const zh = read('src/i18n/locales/zh-CN/chat.js');
  const en = read('src/i18n/locales/en/chat.js');
  const zhSettings = read('src/i18n/locales/zh-CN/settings.js');
  const enSettings = read('src/i18n/locales/en/settings.js');
  const keys = [
    'chat.toolBubble.name.search',
    'chat.toolBubble.name.generic',
    'chat.toolBubble.status.running',
    'chat.toolBubble.status.done',
    'chat.toolBubble.status.error',
    'chat.toolBubble.search.notConfigured',
  ];
  keys.forEach(key => {
    assert.ok(zh.includes(`'${key}'`), `zh-CN 缺 ${key}`);
    assert.ok(en.includes(`'${key}'`), `en 缺 ${key}`);
  });
  ['settings.global.chatTools', 'settings.global.chatToolsHint'].forEach(key => {
    assert.ok(zhSettings.includes(`'${key}'`), `zh-CN 缺 ${key}`);
    assert.ok(enSettings.includes(`'${key}'`), `en 缺 ${key}`);
  });
});
